import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { creditPurchase } from './credit.ts';
import { DarajaClient, DarajaError, loadDarajaConfig } from './daraja.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { toMpesaShillings } from './money.ts';
import { hashPhone, normalizePhone } from './phone.ts';
import { parsePricing, quote } from './pricing.ts';
import { rateLimit } from './ratelimit.ts';
import { getInt, getSetting } from './settings.ts';
import { recordUnallocated } from './unallocated.ts';
import { timingSafeEqual, randomBytes } from 'node:crypto';

export class StkError extends Error {
  code: 'TABLE_UNAVAILABLE' | 'INVALID_GAMES' | 'RATE_LIMITED' | 'UNKNOWN_TABLE' | 'NOT_CONFIGURED' | 'INVALID_INPUT';
  detail?: string;
  constructor(code: StkError['code'], message: string, detail?: string) { super(message); this.code = code; this.detail = detail; }
}

export type RequestStatus = 'INITIATING' | 'PENDING' | 'TIMEOUT' | 'SUCCESS' | 'CANCELLED' | 'WRONG_PIN' | 'INSUFFICIENT_FUNDS' | 'FAILED' | 'EXPIRED';
interface ReqRow {
  id: string; table_id: string; games: number; amount_minor: number; phone_hash: string; phone_enc: string; attendant_id: string | null;
  status: RequestStatus; checkout_request_id: string | null; receipt: string | null; payment_id: string | null; query_attempts: number;
  expires_at_ms: number; created_at: string;
}
export interface InitiateResult { requestId: string; status: RequestStatus; amountMinor: number; games: number; expiresAtMs: number; duplicate: boolean }

const iso = (ctx: Ctx) => ctx.now().toISOString();
const alert = (ctx: Ctx, kind: string, sev: 'LOW' | 'MEDIUM' | 'HIGH', tableId: string | null, msg: string) =>
  ctx.db.run('INSERT INTO alerts(id,kind,severity,table_id,message,created_at) VALUES (?,?,?,?,?,?)', randomUUID(), kind, sev, tableId, msg, iso(ctx));

/** Customer pays: validate, rate-limit, record the request (idempotent), THEN call Daraja outside the DB lock. */
export async function initiateStk(
  ctx: Ctx, client: DarajaClient | null,
  i: { tableId: string; games: number; phone: string; idempotencyKey: string; ip: string; pepper: string; attendantId?: string | null },
): Promise<InitiateResult> {
  if (!i.idempotencyKey || i.idempotencyKey.length > 100) throw new StkError('INVALID_INPUT', 'idempotency key required');
  const phone = normalizePhone(i.phone);
  const phoneHash = hashPhone(phone, i.pepper);

  const created = ctx.db.tx(() => {
    const existing = ctx.db.get<ReqRow>('SELECT * FROM mpesa_requests WHERE idempotency_key=?', i.idempotencyKey);
    if (existing) return { row: existing, duplicate: true };
    const t = ctx.db.get<{ status: string; online: number; pricing_json: string }>('SELECT status, online, pricing_json FROM pool_tables WHERE id=?', i.tableId);
    if (!t) throw new StkError('UNKNOWN_TABLE', 'Table not found');
    // Blocked BEFORE the customer pays.
    if (t.status !== 'ACTIVE') throw new StkError('TABLE_UNAVAILABLE', 'This table is not available right now.', t.status);
    if (!t.online) throw new StkError('TABLE_UNAVAILABLE', 'This table is offline right now.', 'OFFLINE');
    let q;
    try { q = quote(parsePricing(JSON.parse(t.pricing_json)), i.games, ctx.now()); }
    catch (e) { throw new StkError('INVALID_GAMES', (e as Error).message); }
    const okPhone = rateLimit(ctx, `stk:phone:${phoneHash}`, getInt(ctx, 'limits.stk_per_phone_hour'), 3_600_000);
    const okCool = rateLimit(ctx, `stk:cool:${phoneHash}`, 1, getInt(ctx, 'stk.cooldown_ms'));
    const okIp = rateLimit(ctx, `stk:ip:${i.ip}`, getInt(ctx, 'limits.stk_per_ip_hour'), 3_600_000);
    const okTable = rateLimit(ctx, `stk:table:${i.tableId}`, getInt(ctx, 'limits.stk_per_table_hour'), 3_600_000);
    if (!okCool) throw new StkError('RATE_LIMITED', 'Please wait a few seconds before trying again.', 'COOLDOWN');
    if (!okPhone || !okIp || !okTable) throw new StkError('RATE_LIMITED', 'Too many attempts. Please try again later.');
    const id = randomUUID();
    const expires = ctx.now().getTime() + getInt(ctx, 'stk.expiry_ms');
    ctx.db.run(`INSERT INTO mpesa_requests(id,idempotency_key,table_id,games,amount_minor,phone_hash,phone_enc,attendant_id,status,created_at,expires_at_ms)
                VALUES (?,?,?,?,?,?,?,?,'INITIATING',?,?)`, id, i.idempotencyKey, i.tableId, i.games, q.totalMinor, phoneHash,
      encryptSecret(phone, ctx.masterKey), i.attendantId ?? null, iso(ctx), expires);
    return { row: ctx.db.get<ReqRow>('SELECT * FROM mpesa_requests WHERE id=?', id)!, duplicate: false };
  });
  const r = created.row;
  const out = (row: ReqRow, dup: boolean): InitiateResult => ({ requestId: row.id, status: row.status, amountMinor: row.amount_minor, games: row.games, expiresAtMs: row.expires_at_ms, duplicate: dup });
  if (created.duplicate) return out(r, true); // double tap / retry: never a second push

  if (!client) { markFailed(ctx, r.id, 'NOT_CONFIGURED', 'M-Pesa is not configured'); throw new StkError('NOT_CONFIGURED', 'Payments are not set up yet.'); }
  try {
    const resp = await client.stkPush({ amountShillings: toMpesaShillings(r.amount_minor), phone, accountRef: `T${i.tableId.slice(0, 8)}`, description: 'Pool games' });
    ctx.db.run(`UPDATE mpesa_requests SET status='PENDING', checkout_request_id=?, merchant_request_id=?, next_query_at_ms=? WHERE id=? AND status='INITIATING'`,
      resp.CheckoutRequestID, resp.MerchantRequestID, ctx.now().getTime() + 30_000, r.id);
  } catch (e) {
    const definite = e instanceof DarajaError && e.status >= 200 && e.status < 500 && e.status !== 0;
    markFailed(ctx, r.id, definite ? 'REJECTED' : 'UNCERTAIN', e instanceof Error ? e.message : 'error');
    if (!definite) alert(ctx, 'STK_UNCERTAIN', 'MEDIUM', r.table_id, `STK push to Daraja failed ambiguously for request ${r.id}; if the customer paid it will appear under unallocated payments.`);
  }
  return out(ctx.db.get<ReqRow>('SELECT * FROM mpesa_requests WHERE id=?', r.id)!, false);
}

function markFailed(ctx: Ctx, id: string, code: string, desc: string): void {
  ctx.db.run(`UPDATE mpesa_requests SET status='FAILED', result_desc=?, completed_at=? WHERE id=? AND status IN ('INITIATING','PENDING')`, `${code}: ${desc}`.slice(0, 300), iso(ctx), id);
}

// ----------------------------- callback ----------------------------------

export class StkShapeError extends Error {}
export interface ParsedCallback {
  merchantRequestId: string; checkoutRequestId: string; resultCode: number; resultDesc: string;
  amountMinor?: number; receipt?: string; phone?: string;
}

function shillingsToMinor(v: unknown): number | undefined {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v));
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

/** Validates the documented Daraja shape: { Body: { stkCallback: { ... CallbackMetadata: { Item: [{Name, Value}] } } } } */
export function parseStkCallback(body: unknown): ParsedCallback {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } } | null)?.Body?.stkCallback;
  if (!cb || typeof cb !== 'object') throw new StkShapeError('missing Body.stkCallback');
  const { MerchantRequestID: mr, CheckoutRequestID: cr, ResultCode: rc, ResultDesc: rd } = cb as Record<string, unknown>;
  if (typeof mr !== 'string' || typeof cr !== 'string' || !cr || typeof rc !== 'number' || !Number.isInteger(rc) || typeof rd !== 'string') throw new StkShapeError('bad core fields');
  const out: ParsedCallback = { merchantRequestId: mr, checkoutRequestId: cr, resultCode: rc, resultDesc: rd };
  if (rc === 0) {
    const items = (cb.CallbackMetadata as { Item?: unknown } | undefined)?.Item;
    if (!Array.isArray(items)) throw new StkShapeError('success without CallbackMetadata.Item');
    for (const it of items as { Name?: string; Value?: unknown }[]) {
      if (it?.Name === 'Amount') out.amountMinor = shillingsToMinor(it.Value);
      else if (it?.Name === 'MpesaReceiptNumber' && typeof it.Value === 'string' && /^[A-Z0-9]{8,14}$/.test(it.Value)) out.receipt = it.Value;
      else if (it?.Name === 'PhoneNumber') out.phone = String(it.Value);
    }
    if (out.amountMinor === undefined || !out.receipt) throw new StkShapeError('success without valid Amount/MpesaReceiptNumber');
  }
  return out;
}

/** Secret path token (constant time) and optional Safaricom source-IP allowlist. */
export function verifyCallbackOrigin(ctx: Ctx, token: string, ip: string): { ok: boolean; reason?: string } {
  const cfg = loadDarajaConfig(ctx);
  if (!cfg) return { ok: false, reason: 'NOT_CONFIGURED' };
  const a = Buffer.from(token), b = Buffer.from(cfg.callbackToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_TOKEN' };
  const allow = getSetting(ctx, 'callback.ip_allowlist').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(ip.replace(/^::ffff:/, ''))) return { ok: false, reason: 'IP_NOT_ALLOWED' };
  return { ok: true };
}
export const newCallbackToken = (): string => randomBytes(24).toString('hex');

const FAIL_STATUS: Record<number, RequestStatus> = { 1032: 'CANCELLED', 1: 'INSUFFICIENT_FUNDS', 2001: 'WRONG_PIN', 1037: 'TIMEOUT' };
const failStatus = (code: number): RequestStatus => FAIL_STATUS[code] ?? 'FAILED';
const OPEN: RequestStatus[] = ['INITIATING', 'PENDING', 'TIMEOUT'];

export interface CallbackOutcome { verdict: string; tableId?: string }

function logCallback(ctx: Ctx, kind: string, checkout: string | null, ip: string, body: unknown, verdict: string): void {
  ctx.db.run('INSERT INTO mpesa_callbacks(kind,checkout_request_id,source_ip,body_json,verdict,received_at) VALUES (?,?,?,?,?,?)', kind, checkout, ip, JSON.stringify(body), verdict, iso(ctx));
}

/** Credits a request exactly once. `ref` is the real M-Pesa receipt, or a synthetic one when only the query API confirmed payment. */
function applySuccess(ctx: Ctx, reqId: string, ref: string, realReceipt: string | null): CallbackOutcome {
  return ctx.db.tx(() => {
    const req = ctx.db.get<ReqRow>('SELECT * FROM mpesa_requests WHERE id=?', reqId)!;
    if (req.status === 'SUCCESS') {
      if (realReceipt && !ctx.db.get('SELECT 1 FROM mpesa_receipts WHERE receipt=?', realReceipt)) {
        ctx.db.run(`INSERT INTO mpesa_receipts(receipt,kind,ref_id,created_at) VALUES (?, 'STK', ?, ?)`, realReceipt, req.id, iso(ctx));
        ctx.db.run('UPDATE mpesa_requests SET receipt=? WHERE id=? AND receipt IS NULL', realReceipt, req.id);
      }
      return { verdict: 'DUPLICATE' };
    }
    if (realReceipt) {
      const seen = ctx.db.get<{ ref_id: string }>('SELECT ref_id FROM mpesa_receipts WHERE receipt=?', realReceipt);
      if (seen && seen.ref_id !== req.id) return { verdict: 'DUPLICATE_RECEIPT' };
    }
    const r = creditPurchase(ctx, { source: 'MPESA_STK', idempotencyKey: `stk:${req.id}`, externalRef: ref, tableId: req.table_id, amountMinor: req.amount_minor,
      gamesRequested: req.games, ownerRef: req.phone_hash, attendantId: req.attendant_id, actor: 'mpesa' });
    if (r.status !== 'CREDITED') { alert(ctx, 'STK_CREDIT_REJECTED', 'HIGH', req.table_id, `Paid request ${req.id} could not be credited (${r.reason}).`); return { verdict: 'CREDIT_REJECTED' }; }
    if (realReceipt) ctx.db.run(`INSERT OR IGNORE INTO mpesa_receipts(receipt,kind,ref_id,created_at) VALUES (?, 'STK', ?, ?)`, realReceipt, req.id, iso(ctx));
    ctx.db.run(`UPDATE mpesa_requests SET status='SUCCESS', result_code=0, receipt=COALESCE(?,receipt), payment_id=?, credited_without_receipt=?, completed_at=? WHERE id=?`,
      realReceipt, r.paymentId, realReceipt ? 0 : 1, iso(ctx), req.id);
    appendAudit(ctx.db, ctx.now(), { actor: 'mpesa', action: 'stk.success', entityType: 'mpesa_request', entityId: req.id, data: { ref, games: r.games } });
    return { verdict: r.duplicate ? 'DUPLICATE' : 'CREDITED', tableId: req.table_id };
  });
}

/**
 * Processes an STK callback. Origin checks (path token / IP) are done by verifyCallbackOrigin before calling.
 * Never throws for bad input: every outcome is logged and returned as a verdict.
 */
export async function handleStkCallback(ctx: Ctx, client: DarajaClient | null, body: unknown, ip: string): Promise<CallbackOutcome> {
  let p: ParsedCallback;
  try { p = parseStkCallback(body); }
  catch (e) { ctx.db.tx(() => logCallback(ctx, 'STK', null, ip, body, `INVALID_SHAPE: ${(e as Error).message}`)); return { verdict: 'INVALID_SHAPE' }; }

  const phase1 = ctx.db.tx((): { outcome?: CallbackOutcome; req?: ReqRow; needQuery?: boolean } => {
    const req = ctx.db.get<ReqRow>('SELECT * FROM mpesa_requests WHERE checkout_request_id=?', p.checkoutRequestId);
    if (!req) {
      if (p.resultCode === 0 && p.receipt) {
        const seen = ctx.db.get('SELECT 1 FROM mpesa_receipts WHERE receipt=?', p.receipt);
        if (!seen) {
          const id = recordUnallocated(ctx, { receipt: p.receipt, source: 'STK_UNKNOWN', amountMinor: p.amountMinor!, phoneHash: null, reason: 'UNKNOWN_CHECKOUT_REQUEST', raw: body });
          ctx.db.run(`INSERT INTO mpesa_receipts(receipt,kind,ref_id,created_at) VALUES (?, 'STK', ?, ?)`, p.receipt, id, iso(ctx));
        }
      }
      logCallback(ctx, 'STK', p.checkoutRequestId, ip, body, 'UNKNOWN_CHECKOUT');
      return { outcome: { verdict: p.resultCode === 0 ? 'UNALLOCATED_UNKNOWN_CHECKOUT' : 'UNKNOWN_IGNORED' } };
    }
    if (req.status === 'SUCCESS') { logCallback(ctx, 'STK', p.checkoutRequestId, ip, body, 'DUPLICATE'); return { req, outcome: undefined, needQuery: false }; }
    if (p.resultCode !== 0) {
      ctx.db.run('UPDATE mpesa_requests SET status=?, result_code=?, result_desc=?, completed_at=? WHERE id=? AND status IN (\'INITIATING\',\'PENDING\',\'TIMEOUT\')',
        failStatus(p.resultCode), p.resultCode, p.resultDesc.slice(0, 300), iso(ctx), req.id);
      logCallback(ctx, 'STK', p.checkoutRequestId, ip, body, 'FAILURE_RECORDED');
      return { outcome: { verdict: 'FAILURE_RECORDED' } };
    }
    // success: verify amount and phone against what THIS system asked for
    if (p.amountMinor !== req.amount_minor) {
      recordUnallocated(ctx, { receipt: p.receipt!, source: 'STK_MISMATCH', amountMinor: p.amountMinor!, phoneHash: req.phone_hash, reason: 'AMOUNT_MISMATCH', raw: body });
      ctx.db.run(`INSERT OR IGNORE INTO mpesa_receipts(receipt,kind,ref_id,created_at) VALUES (?, 'STK', ?, ?)`, p.receipt!, req.id, iso(ctx));
      ctx.db.run(`UPDATE mpesa_requests SET status='FAILED', result_desc='AMOUNT_MISMATCH', completed_at=? WHERE id=?`, iso(ctx), req.id);
      alert(ctx, 'STK_AMOUNT_MISMATCH', 'HIGH', req.table_id, `Callback amount ${p.amountMinor} differs from requested ${req.amount_minor} (receipt ${p.receipt}).`);
      logCallback(ctx, 'STK', p.checkoutRequestId, ip, body, 'AMOUNT_MISMATCH');
      return { outcome: { verdict: 'AMOUNT_MISMATCH' } };
    }
    let phoneUncertain = true;
    if (p.phone && /^254\d{9}$/.test(p.phone)) {
      if (p.phone !== decryptSecret(req.phone_enc, ctx.masterKey)) {
        recordUnallocated(ctx, { receipt: p.receipt!, source: 'STK_MISMATCH', amountMinor: p.amountMinor!, phoneHash: req.phone_hash, reason: 'PHONE_MISMATCH', raw: body });
        ctx.db.run(`INSERT OR IGNORE INTO mpesa_receipts(receipt,kind,ref_id,created_at) VALUES (?, 'STK', ?, ?)`, p.receipt!, req.id, iso(ctx));
        ctx.db.run(`UPDATE mpesa_requests SET status='FAILED', result_desc='PHONE_MISMATCH', completed_at=? WHERE id=?`, iso(ctx), req.id);
        alert(ctx, 'STK_PHONE_MISMATCH', 'HIGH', req.table_id, `Callback phone differs from request (receipt ${p.receipt}).`);
        logCallback(ctx, 'STK', p.checkoutRequestId, ip, body, 'PHONE_MISMATCH');
        return { outcome: { verdict: 'PHONE_MISMATCH' } };
      }
      phoneUncertain = false;
    }
    logCallback(ctx, 'STK', p.checkoutRequestId, ip, body, 'ACCEPTED_FOR_CREDIT');
    const unusual = !OPEN.includes(req.status) || phoneUncertain;
    return { req, needQuery: unusual && getSetting(ctx, 'stk.verify_with_query') === '1' };
  });
  if (phase1.outcome) return phase1.outcome;
  const req = phase1.req!;
  if (req.status === 'SUCCESS') return applySuccess(ctx, req.id, req.receipt ?? p.receipt!, p.receipt ?? null);

  if (phase1.needQuery) {
    let q: Awaited<ReturnType<DarajaClient['stkQuery']>> | null = null;
    try { q = client ? await client.stkQuery(p.checkoutRequestId) : null; } catch { q = null; }
    if (!q || q.state !== 'SUCCESS') {
      // Uncertain: never vend on an unconfirmed claim. Park the claimed receipt; the reconciler decides.
      ctx.db.tx(() => {
        ctx.db.run(`UPDATE mpesa_requests SET receipt=COALESCE(receipt,?), status=CASE WHEN status IN ('PENDING','INITIATING') THEN 'TIMEOUT' ELSE status END, next_query_at_ms=? WHERE id=?`,
          p.receipt!, ctx.now().getTime() + 5_000, req.id);
        if (q) alert(ctx, 'STK_QUERY_DISAGREES', 'HIGH', req.table_id, `Callback claimed success but STK Query says ${q.state} (${q.resultDesc ?? ''}) for ${req.id}.`);
      });
      return { verdict: q ? 'QUERY_NOT_CONFIRMED' : 'DEFERRED_QUERY_UNAVAILABLE' };
    }
  }
  return applySuccess(ctx, req.id, p.receipt!, p.receipt!);
}

// ----------------------------- reconciler --------------------------------

/** Lost-callback recovery. Safe to run on a timer and at boot. Returns table ids that received credits (caller dispatches vends). */
export async function reconcilePending(ctx: Ctx, client: DarajaClient | null): Promise<{ credited: string[]; checked: number }> {
  const now = ctx.now().getTime();
  const lateWindow = getInt(ctx, 'stk.late_window_ms');
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE mpesa_requests SET status='FAILED', result_desc='INITIATING_STALE', completed_at=? WHERE status='INITIATING' AND expires_at_ms < ?`, iso(ctx), now - 60_000);
    ctx.db.run(`UPDATE mpesa_requests SET status='TIMEOUT' WHERE status='PENDING' AND expires_at_ms < ?`, now);
    ctx.db.run(`UPDATE mpesa_requests SET status='EXPIRED', completed_at=? WHERE status='TIMEOUT' AND expires_at_ms + ? < ?`, iso(ctx), lateWindow, now);
  });
  if (!client) return { credited: [], checked: 0 };
  const due = ctx.db.all<ReqRow>(`SELECT * FROM mpesa_requests WHERE status IN ('PENDING','TIMEOUT') AND checkout_request_id IS NOT NULL AND COALESCE(next_query_at_ms,0) <= ? ORDER BY created_at LIMIT 50`, now);
  const credited: string[] = [];
  for (const r of due) {
    const backoff = Math.min(30_000 * 2 ** r.query_attempts, 600_000);
    let q;
    try { q = await client.stkQuery(r.checkout_request_id!); }
    catch { ctx.db.run('UPDATE mpesa_requests SET query_attempts=query_attempts+1, next_query_at_ms=? WHERE id=?', now + backoff, r.id); continue; }
    if (q.state === 'PROCESSING') { ctx.db.run('UPDATE mpesa_requests SET query_attempts=query_attempts+1, next_query_at_ms=? WHERE id=?', now + backoff, r.id); continue; }
    if (q.state === 'FAILED') {
      ctx.db.run(`UPDATE mpesa_requests SET status=?, result_code=?, result_desc=?, completed_at=? WHERE id=? AND status IN ('PENDING','TIMEOUT')`, failStatus(q.resultCode!), q.resultCode!, (q.resultDesc ?? '').slice(0, 300), iso(ctx), r.id);
      continue;
    }
    const fresh = ctx.db.get<ReqRow>('SELECT * FROM mpesa_requests WHERE id=?', r.id)!;
    const out = applySuccess(ctx, r.id, fresh.receipt ?? `STKQ-${r.checkout_request_id}`, fresh.receipt);
    if (out.tableId) credited.push(out.tableId);
  }
  return { credited, checked: due.length };
}

export function getRequestStatus(ctx: Ctx, requestId: string) {
  const r = ctx.db.get<ReqRow & { result_desc: string | null }>('SELECT * FROM mpesa_requests WHERE id=?', requestId);
  if (!r) return null;
  return { requestId: r.id, status: r.status, games: r.games, amountMinor: r.amount_minor, receipt: r.status === 'SUCCESS' ? r.receipt : null, expiresAtMs: r.expires_at_ms, resultDesc: r.result_desc, tableId: r.table_id };
}
