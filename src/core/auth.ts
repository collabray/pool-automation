import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { rateLimit } from './ratelimit.ts';

export class AuthError extends Error {
  code: 'INVALID_CREDENTIALS' | 'LOCKED' | 'RATE_LIMITED' | 'TOTP_REQUIRED' | 'INVALID_TOKEN' | 'WEAK_SECRET' | 'EXISTS' | 'FORBIDDEN';
  constructor(code: AuthError['code'], message: string) { super(message); this.code = code; }
}
export type Role = 'owner' | 'manager' | 'attendant';
export interface Principal { id: string; role: Role; username: string; displayName: string; canSeeMoney: boolean }

const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 7 * 24 * 3600_000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

// ---- password / PIN hashing. scrypt (memory-hard) is used because Node 22's crypto has no argon2id; see docs/DECISIONS.md.
export function hashSecret(plain: string): string {
  const salt = randomBytes(16);
  const N = 32768, r = 8, p = 1;
  const h = scryptSync(plain, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifySecret(plain: string, stored: string | null): boolean {
  const dummy = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const [, n, r, p, salt, hash] = (stored ?? dummy).split('$');
  const N = Number(n), R = Number(r), P = Number(p);
  const h = scryptSync(plain, Buffer.from(salt, 'base64'), 32, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  const want = Buffer.from(hash, 'base64');
  return stored !== null && want.length === h.length && timingSafeEqual(h, want);
}

export function checkPasswordPolicy(pw: string): void {
  if (pw.length < 10 || pw.length > 200 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new AuthError('WEAK_SECRET', 'Password must be 10+ characters with letters and numbers');
}
export function checkPinPolicy(pin: string): void {
  if (!/^\d{4,8}$/.test(pin)) throw new AuthError('WEAK_SECRET', 'PIN must be 4-8 digits');
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw new AuthError('WEAK_SECRET', 'PIN is too easy to guess');
}

export interface NewUser { username: string; displayName: string; role: Role; password?: string; pin?: string; canSeeMoney?: boolean; voidLimitMinor?: number; discountLimitMinor?: number }
export function createUser(ctx: Ctx, u: NewUser, actor: string): string {
  if (!/^[a-z0-9._-]{3,40}$/.test(u.username)) throw new AuthError('WEAK_SECRET', 'username must be 3-40 chars: a-z 0-9 . _ -');
  if (u.role !== 'attendant' && !u.password) throw new AuthError('WEAK_SECRET', 'owners and managers need a password');
  if (u.password) checkPasswordPolicy(u.password);
  if (u.pin) checkPinPolicy(u.pin);
  if (!u.password && !u.pin) throw new AuthError('WEAK_SECRET', 'a password or PIN is required');
  const id = randomUUID();
  return ctx.db.tx(() => {
    if (ctx.db.get('SELECT 1 FROM users WHERE username=?', u.username)) throw new AuthError('EXISTS', 'username already exists');
    ctx.db.run(`INSERT INTO users(id,username,display_name,role,password_hash,pin_hash,can_see_money,void_limit_minor,discount_limit_minor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, u.username, u.displayName.trim(), u.role, u.password ? hashSecret(u.password) : null, u.pin ? hashSecret(u.pin) : null,
      u.canSeeMoney === false ? 0 : 1, u.voidLimitMinor ?? 50000, u.discountLimitMinor ?? 2000, ctx.now().toISOString());
    appendAudit(ctx.db, ctx.now(), { actor, action: 'user.created', entityType: 'user', entityId: id, data: { username: u.username, role: u.role } });
    return id;
  });
}

// ---- JWT (HS256) ----
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const jwtKey = (ctx: Ctx) => createHmac('sha256', ctx.masterKey).update('jwt-v1').digest();
export function signJwt(ctx: Ctx, claims: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${b64u(createHmac('sha256', jwtKey(ctx)).update(`${head}.${body}`).digest())}`;
}
export function verifyJwt(ctx: Ctx, token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('INVALID_TOKEN', 'invalid token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString() || '{}');
  if (header.alg !== 'HS256') throw new AuthError('INVALID_TOKEN', 'invalid token'); // blocks alg=none and alg confusion
  const want = createHmac('sha256', jwtKey(ctx)).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new AuthError('INVALID_TOKEN', 'invalid token');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < ctx.now().getTime()) throw new AuthError('INVALID_TOKEN', 'token expired');
  return claims;
}

export function authenticate(ctx: Ctx, bearer: string | undefined): Principal {
  if (!bearer?.startsWith('Bearer ')) throw new AuthError('INVALID_TOKEN', 'missing token');
  let c: Record<string, unknown>;
  try { c = verifyJwt(ctx, bearer.slice(7)); } catch (e) { throw e instanceof AuthError ? e : new AuthError('INVALID_TOKEN', 'invalid token'); }
  const u = ctx.db.get<{ id: string; username: string; display_name: string; role: Role; active: number; can_see_money: number; token_version: number }>(
    'SELECT id, username, display_name, role, active, can_see_money, token_version FROM users WHERE id=?', String(c.sub));
  if (!u || !u.active || u.token_version !== c.tv) throw new AuthError('INVALID_TOKEN', 'session no longer valid');
  return { id: u.id, role: u.role, username: u.username, displayName: u.display_name, canSeeMoney: !!u.can_see_money };
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
export function unbase32(s: string): Buffer { let bits = ''; for (const c of s.replace(/=+$/, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
export function totpCode(secretB32: string, atMs: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac('sha1', unbase32(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
export function verifyTotp(secretB32: string, code: string, atMs: number): boolean {
  return [-1, 0, 1].some((d) => { const a = Buffer.from(totpCode(secretB32, atMs + d * 30_000)), b = Buffer.from(code); return a.length === b.length && timingSafeEqual(a, b); });
}
export function beginTotp(ctx: Ctx, userId: string): { secret: string; uri: string } {
  const secret = base32(randomBytes(20));
  const u = ctx.db.get<{ username: string }>('SELECT username FROM users WHERE id=?', userId)!;
  ctx.db.run('UPDATE users SET totp_secret_enc=? WHERE id=?', 'pending:' + encryptSecret(secret, ctx.masterKey), userId);
  return { secret, uri: `otpauth://totp/PoolTable:${u.username}?secret=${secret}&issuer=PoolTable` };
}
export function confirmTotp(ctx: Ctx, userId: string, code: string): void {
  const raw = ctx.db.get<{ t: string | null }>('SELECT totp_secret_enc t FROM users WHERE id=?', userId)?.t;
  if (!raw?.startsWith('pending:')) throw new AuthError('INVALID_CREDENTIALS', 'no TOTP setup in progress');
  const secret = decryptSecret(raw.slice(8), ctx.masterKey);
  if (!verifyTotp(secret, code, ctx.now().getTime())) throw new AuthError('INVALID_CREDENTIALS', 'incorrect code');
  ctx.db.run('UPDATE users SET totp_secret_enc=? WHERE id=?', encryptSecret(secret, ctx.masterKey), userId);
}

// ---- login, refresh rotation ----
export interface Tokens { accessToken: string; refreshToken: string; expiresInSec: number; user: Principal }
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

function issueTokens(ctx: Ctx, userId: string, familyId: string): Tokens {
  const u = ctx.db.get<{ id: string; username: string; display_name: string; role: Role; can_see_money: number; token_version: number }>('SELECT id, username, display_name, role, can_see_money, token_version FROM users WHERE id=?', userId)!;
  const nowS = Math.floor(ctx.now().getTime() / 1000);
  const accessToken = signJwt(ctx, { sub: u.id, role: u.role, tv: u.token_version, iat: nowS, exp: nowS + ACCESS_TTL_MS / 1000, jti: randomUUID() });
  const refreshToken = randomBytes(32).toString('base64url');
  ctx.db.run('INSERT INTO refresh_tokens(id,user_id,family_id,token_hash,expires_at_ms,created_at) VALUES (?,?,?,?,?,?)', randomUUID(), u.id, familyId, hashToken(refreshToken), ctx.now().getTime() + REFRESH_TTL_MS, ctx.now().toISOString());
  return { accessToken, refreshToken, expiresInSec: ACCESS_TTL_MS / 1000, user: { id: u.id, role: u.role, username: u.username, displayName: u.display_name, canSeeMoney: !!u.can_see_money } };
}

export function login(ctx: Ctx, a: { username: string; secret: string; kind: 'password' | 'pin'; totp?: string; ip: string }): Tokens {
  const uname = a.username.toLowerCase();
  if (!rateLimit(ctx, `login:ip:${a.ip}`, 30, 600_000) || !rateLimit(ctx, `login:user:${uname}`, 10, 600_000)) throw new AuthError('RATE_LIMITED', 'Too many attempts. Try again later.');
  return ctx.db.tx(() => {
    const u = ctx.db.get<{ id: string; role: Role; active: number; password_hash: string | null; pin_hash: string | null; totp_secret_enc: string | null; failed_attempts: number; locked_until: string | null }>('SELECT * FROM users WHERE username=?', uname);
    const stored = u ? (a.kind === 'pin' ? u.pin_hash : u.password_hash) : null;
    const allowedKind = !u || a.kind === 'password' || u.role === 'attendant'; // PIN login is for attendants only
    if (u?.locked_until && Date.parse(u.locked_until) > ctx.now().getTime()) { verifySecret(a.secret, stored); throw new AuthError('LOCKED', 'Account temporarily locked. Try again later.'); }
    const ok = verifySecret(a.secret, stored) && !!u && !!u.active && allowedKind;
    if (!ok) {
      if (u) {
        const fails = u.failed_attempts + 1;
        ctx.db.run('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?', fails >= LOCK_AFTER ? 0 : fails, fails >= LOCK_AFTER ? new Date(ctx.now().getTime() + LOCK_MS).toISOString() : null, u.id);
        if (fails >= LOCK_AFTER) appendAudit(ctx.db, ctx.now(), { actor: 'system', action: 'user.locked', entityType: 'user', entityId: u.id, data: { ip: a.ip } });
      }
      // The failure must persist even though we throw, so commit it by returning a marker instead of throwing inside the tx.
      return null;
    }
    if (u!.totp_secret_enc && !u!.totp_secret_enc.startsWith('pending:') && a.kind === 'password') {
      if (!a.totp) throw new AuthError('TOTP_REQUIRED', 'Enter your authenticator code');
      if (!verifyTotp(decryptSecret(u!.totp_secret_enc, ctx.masterKey), a.totp, ctx.now().getTime())) {
        ctx.db.run('UPDATE users SET failed_attempts=failed_attempts+1 WHERE id=?', u!.id);
        return null;
      }
    }
    ctx.db.run('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?', u!.id);
    appendAudit(ctx.db, ctx.now(), { actor: u!.id, action: 'auth.login', entityType: 'user', entityId: u!.id, data: { kind: a.kind, ip: a.ip } });
    return issueTokens(ctx, u!.id, randomUUID());
  }) ?? (() => { throw new AuthError('INVALID_CREDENTIALS', 'Incorrect username or credentials'); })();
}

export function refresh(ctx: Ctx, token: string): Tokens {
  return ctx.db.tx(() => {
    const r = ctx.db.get<{ id: string; user_id: string; family_id: string; expires_at_ms: number; used_at: string | null; revoked: number }>('SELECT * FROM refresh_tokens WHERE token_hash=?', hashToken(token));
    if (!r || r.revoked) throw new AuthError('INVALID_TOKEN', 'invalid refresh token');
    if (r.used_at) { // reuse of a rotated token = theft signal: kill the whole family
      ctx.db.run('UPDATE refresh_tokens SET revoked=1 WHERE family_id=?', r.family_id);
      appendAudit(ctx.db, ctx.now(), { actor: r.user_id, action: 'auth.refresh_reuse_detected', entityType: 'user', entityId: r.user_id });
      return null;
    }
    if (r.expires_at_ms < ctx.now().getTime()) throw new AuthError('INVALID_TOKEN', 'refresh token expired');
    const u = ctx.db.get<{ active: number }>('SELECT active FROM users WHERE id=?', r.user_id);
    if (!u?.active) throw new AuthError('INVALID_TOKEN', 'account disabled');
    ctx.db.run('UPDATE refresh_tokens SET used_at=? WHERE id=?', ctx.now().toISOString(), r.id);
    return issueTokens(ctx, r.user_id, r.family_id);
  }) ?? (() => { throw new AuthError('INVALID_TOKEN', 'refresh token reuse detected; sign in again'); })();
}

export function logout(ctx: Ctx, refreshToken: string): void {
  ctx.db.run('UPDATE refresh_tokens SET revoked=1 WHERE family_id=(SELECT family_id FROM refresh_tokens WHERE token_hash=?)', hashToken(refreshToken));
}

/** Kills every session of a user (password change, deactivation, suspected compromise). */
export function revokeAllSessions(ctx: Ctx, userId: string): void {
  ctx.db.run('UPDATE users SET token_version=token_version+1 WHERE id=?', userId);
  ctx.db.run('UPDATE refresh_tokens SET revoked=1 WHERE user_id=?', userId);
}

export function setCredentials(ctx: Ctx, userId: string, c: { password?: string; pin?: string }, actor: string): void {
  if (c.password) checkPasswordPolicy(c.password);
  if (c.pin) checkPinPolicy(c.pin);
  ctx.db.tx(() => {
    if (c.password) ctx.db.run('UPDATE users SET password_hash=? WHERE id=?', hashSecret(c.password), userId);
    if (c.pin) ctx.db.run('UPDATE users SET pin_hash=?, failed_attempts=0, locked_until=NULL WHERE id=?', hashSecret(c.pin), userId);
    revokeAllSessions(ctx, userId);
    appendAudit(ctx.db, ctx.now(), { actor, action: 'user.credentials_changed', entityType: 'user', entityId: userId, data: { password: !!c.password, pin: !!c.pin } });
  });
}

/** A manager/owner proves they are present by entering their credentials; returns a single-use token bound to the requesting user. */
export function grantApproval(ctx: Ctx, a: { requestedBy: string; username: string; secret: string; kind: 'password' | 'pin'; ip: string }): { token: string; approverName: string } {
  const uname = a.username.toLowerCase();
  if (!rateLimit(ctx, `approve:user:${a.requestedBy}`, 10, 600_000) || !rateLimit(ctx, `login:user:${uname}`, 10, 600_000)) throw new AuthError('RATE_LIMITED', 'Too many attempts. Try again later.');
  return ctx.db.tx(() => {
    const u = ctx.db.get<{ id: string; role: Role; active: number; display_name: string; password_hash: string | null; pin_hash: string | null; locked_until: string | null; failed_attempts: number }>('SELECT * FROM users WHERE username=?', uname);
    const stored = u ? (a.kind === 'pin' ? u.pin_hash : u.password_hash) : null;
    const locked = !!u?.locked_until && Date.parse(u.locked_until) > ctx.now().getTime();
    const ok = verifySecret(a.secret, stored) && !!u && !!u.active && !locked && (u.role === 'manager' || u.role === 'owner') && u.id !== a.requestedBy;
    if (!ok) {
      if (u) ctx.db.run('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?', u.failed_attempts + 1 >= LOCK_AFTER ? 0 : u.failed_attempts + 1, u.failed_attempts + 1 >= LOCK_AFTER ? new Date(ctx.now().getTime() + LOCK_MS).toISOString() : null, u.id);
      return null;
    }
    const token = randomBytes(24).toString('base64url');
    ctx.db.run('INSERT INTO approval_tokens(token_hash,approver_id,requested_by,expires_at_ms,created_at) VALUES (?,?,?,?,?)', hashToken(token), u!.id, a.requestedBy, ctx.now().getTime() + 5 * 60_000, ctx.now().toISOString());
    appendAudit(ctx.db, ctx.now(), { actor: u!.id, action: 'approval.granted', entityType: 'user', entityId: a.requestedBy, data: { ip: a.ip } });
    return { token, approverName: u!.display_name };
  }) ?? (() => { throw new AuthError('INVALID_CREDENTIALS', 'Approval refused: check the manager name and PIN/password'); })();
}
/** Consumes the token (exactly once). Throws unless it was issued to this requester and has not expired. Returns the approver's user id. */
export function consumeApproval(ctx: Ctx, token: string, requestedBy: string): string {
  const r = ctx.db.get<{ approver_id: string; requested_by: string; expires_at_ms: number; used_at: string | null }>('SELECT * FROM approval_tokens WHERE token_hash=?', hashToken(token));
  if (!r || r.used_at || r.requested_by !== requestedBy || r.expires_at_ms < ctx.now().getTime()) throw new AuthError('INVALID_TOKEN', 'approval is invalid, expired or already used');
  const upd = ctx.db.run('UPDATE approval_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL', ctx.now().toISOString(), hashToken(token));
  if (upd.changes !== 1) throw new AuthError('INVALID_TOKEN', 'approval is invalid, expired or already used');
  return r.approver_id;
}
