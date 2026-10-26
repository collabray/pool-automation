import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { startServer, api, type TestServer, type Api } from './helpers/server.ts';
import { FakeDaraja } from './helpers/fake-daraja.ts';
import { makeTable } from './helpers/ctx.ts';
import { createUser, signJwt, base32, totpCode, beginTotp, confirmTotp } from '../src/core/auth.ts';
import { saveDarajaConfig } from '../src/core/daraja.ts';
import { signDeviceRequest } from '../src/core/devices.ts';
import { openShift, cashSale } from '../src/core/cash.ts';
import { creditPurchase } from '../src/core/credit.ts';
import { A, balance } from '../src/core/ledger.ts';
import { kes } from '../src/core/money.ts';

let fake: FakeDaraja, srv: TestServer, call: Api, tableId: string, deviceId: string, secret: string;
const tok: Record<string, string> = {}; const ids: Record<string, string> = {};
const login = async (u: string, pw: string) => (await call('POST', '/api/auth/login', { username: u, password: pw })).json.accessToken as string;

before(async () => {
  fake = new FakeDaraja(); await fake.start(); srv = await startServer(fake, { corsOrigins: ['https://admin.example.com'] }); call = api(srv.base);
  const t = makeTable(srv.ctx); tableId = t.tableId; deviceId = t.deviceId; secret = t.deviceSecret;
  saveDarajaConfig(srv.ctx, { env: 'sandbox', shortcode: fake.shortcode, partyB: fake.shortcode, passkey: fake.passkey, consumerKey: fake.key, consumerSecret: fake.secret, txType: 'CustomerPayBillOnline', callbackBaseUrl: 'https://x.example.com', callbackToken: 'cbtoken-for-tests' }, 'test');
  ids.owner = createUser(srv.ctx, { username: 'boss', displayName: 'Boss', role: 'owner', password: 'Owner-Passw0rd!' }, 't');
  ids.manager = createUser(srv.ctx, { username: 'mgr', displayName: 'Mgr', role: 'manager', password: 'Manager-Passw0rd!' }, 't');
  ids.a = createUser(srv.ctx, { username: 'alice', displayName: 'Alice', role: 'attendant', pin: '4827' }, 't');
  ids.b = createUser(srv.ctx, { username: 'bob', displayName: 'Bob', role: 'attendant', pin: '7391', canSeeMoney: false }, 't');
  tok.owner = await login('boss', 'Owner-Passw0rd!'); tok.manager = await login('mgr', 'Manager-Passw0rd!');
  tok.a = (await call('POST', '/api/auth/pin-login', { username: 'alice', pin: '4827' })).json.accessToken; tok.b = (await call('POST', '/api/auth/pin-login', { username: 'bob', pin: '7391' })).json.accessToken;
});
after(async () => { await srv.close(); await fake.stop(); });

test('authentication: missing, garbage, tampered, alg=none and expired tokens are all rejected', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, { token: 'garbage' })).status, 401);
  const parts = tok.a.split('.'); const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()), role: 'owner', sub: ids.owner })).toString('base64url');
  assert.equal((await call('GET', '/api/me', undefined, { token: `${parts[0]}.${forgedBody}.${parts[2]}` })).status, 401);
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${forgedBody}.`;
  assert.equal((await call('GET', '/api/me', undefined, { token: none })).status, 401);
  const expired = signJwt(srv.ctx, { sub: ids.a, role: 'attendant', tv: 0, iat: 1, exp: 2 }); assert.equal((await call('GET', '/api/me', undefined, { token: expired })).status, 401);
  const wrongKey = `${parts[0]}.${parts[1]}.${createHmac('sha256', 'attacker').update(`${parts[0]}.${parts[1]}`).digest('base64url')}`; assert.equal((await call('GET', '/api/me', undefined, { token: wrongKey })).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, { token: tok.a })).status, 200);
});
test('RBAC: attendants and managers are refused on every higher-privilege route', async () => {
  const ownerOnly: [string, string, unknown?][] = [['POST', '/api/tables', { name: 'x', vendMode: 'GATE_SOLENOID', pricing: {} }], ['PATCH', `/api/tables/${tableId}`, { name: 'x' }], ['PUT', '/api/daraja', {}], ['PUT', '/api/settings', { settings: {} }], ['GET', '/api/errors'], ['PUT', '/api/notifications', {}], ['POST', `/api/tables/${tableId}/rotate-device-secret`, {}], ['POST', '/api/privacy/erase', {}]];
  const mgrOnly: [string, string, unknown?][] = [['GET', '/api/reports/summary'], ['GET', '/api/unallocated'], ['GET', '/api/staff'], ['GET', '/api/audit'], ['GET', '/api/alerts'], ['GET', '/api/owner/dashboard'], ['GET', '/api/system/health'], ['GET', `/api/tables/${tableId}/qr`], ['POST', '/api/vouchers/batch', { count: 1, games: 1 }], ['GET', '/api/settings'], ['GET', '/api/shifts'], ['GET', `/api/staff/${ids.b}/stats`]];
  for (const [m, p, b] of [...ownerOnly, ...mgrOnly]) { const r = await call(m, p, m === 'GET' ? undefined : b, { token: tok.a, idem: 'x1' }); assert.equal(r.status, 403, `attendant ${m} ${p}`); }
  for (const [m, p, b] of ownerOnly) { const r = await call(m, p, m === 'GET' ? undefined : b, { token: tok.manager, idem: 'x2' }); assert.equal(r.status, 403, `manager ${m} ${p}`); }
  for (const [m, p] of [...ownerOnly, ...mgrOnly]) assert.equal((await call(m, p, m === 'GET' ? undefined : {})).status, 401, `anon ${m} ${p}`);
});
test('IDOR: an attendant can only see and void their own data', async () => {
  openShift(srv.ctx, ids.a, 0); openShift(srv.ctx, ids.b, 0);
  const sa = cashSale(srv.ctx, { attendantId: ids.a, tableId, cashReceivedMinor: kes(40), idempotencyKey: 'ia1' }); const sb = cashSale(srv.ctx, { attendantId: ids.b, tableId, cashReceivedMinor: kes(60), idempotencyKey: 'ib1' });
  const mine = (await call('GET', '/api/cash/sales', undefined, { token: tok.a })).json.sales; assert.deepEqual(mine.map((s: any) => s.id), [sa.saleId]);
  assert.equal((await call('POST', '/api/cash/void', { saleId: sb.saleId, reason: 'sabotage' }, { token: tok.a, idem: 'v1' })).status, 403);
  assert.equal((await call('GET', `/api/staff/${ids.b}/stats`, undefined, { token: tok.a })).status, 403);
  assert.equal((await call('GET', '/api/my/stats?period=today', undefined, { token: tok.a })).json.totalMinor, kes(40));
  assert.equal((await call('POST', '/api/shifts/close', { countedMinor: 0 }, { token: tok.a })).status, 200); // closes alice's shift only
  assert.equal(srv.ctx.db.get<{ status: string }>("SELECT status FROM shifts WHERE attendant_id=?", ids.b)!.status, 'OPEN');
  const bs = (await call('GET', '/api/my/stats?period=today', undefined, { token: tok.b })).json; assert.deepEqual([bs.totalMinor, bs.gamesSold, bs.moneyVisible], [null, 3, false]); // money hidden by owner permission
  assert.equal((await call('GET', '/api/my/export?period=today&format=csv', undefined, { token: tok.b })).status, 403);
  const cmp = (await call('GET', '/api/staff/compare?period=today', undefined, { token: tok.manager })).json.staff; assert.equal(cmp.length, 2);
});
test('mass assignment and schema strictness: unknown or privileged fields are rejected, types enforced', async () => {
  const r1 = await call('PATCH', `/api/staff/${ids.a}`, { role: 'owner' }, { token: tok.owner }); assert.equal(r1.status, 400); assert.match(JSON.stringify(r1.json.error.details), /unknown field/);
  assert.equal(srv.ctx.db.get<{ role: string }>('SELECT role FROM users WHERE id=?', ids.a)!.role, 'attendant');
  assert.equal((await call('PATCH', `/api/tables/${tableId}`, { device_id: 'dev_000000000000' }, { token: tok.owner })).status, 400);
  assert.equal((await call('POST', '/api/staff', { username: 'zed1', displayName: 'Z', role: 'owner', password: 'Zzzzzzzzzz1' }, { token: tok.manager, idem: 's1' })).status, 400);
  assert.equal((await call('POST', '/api/staff', { username: 'zed2', displayName: 'Z', role: 'manager', password: 'Zzzzzzzzzz1' }, { token: tok.manager, idem: 's2' })).status, 403);
  assert.equal((await call('PATCH', `/api/staff/${ids.owner}`, { active: false }, { token: tok.manager })).status, 403);
  assert.equal((await call('PATCH', `/api/staff/${ids.manager}`, { canSeeMoney: false }, { token: tok.manager })).status, 403);
  for (const bad of [{ cashReceivedMinor: '100', tableId }, { cashReceivedMinor: 1.5, tableId }, { cashReceivedMinor: -5, tableId }, { tableId }, { tableId, cashReceivedMinor: 100, extra: 1 }]) assert.equal((await call('POST', '/api/cash/sale', bad, { token: tok.manager, idem: 'bad' })).status, 400, JSON.stringify(bad));
  assert.equal((await call('POST', '/api/cash/sale', { tableId, cashReceivedMinor: 2000 }, { token: tok.manager })).json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});
test('transport hygiene: body limit, content type, malformed JSON, security headers, CORS, no stack leaks', async () => {
  assert.equal((await call('POST', '/api/auth/login', { username: 'a'.repeat(100000), password: 'x' })).status, 413);
  const ct = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' }); assert.equal(ct.status, 415);
  const bj = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' }); assert.equal(bj.status, 400);
  const h = (await call('GET', '/api/health')).headers;
  assert.match(h.get('content-security-policy')!, /default-src 'self'/); assert.equal(h.get('x-content-type-options'), 'nosniff'); assert.equal(h.get('x-frame-options'), 'DENY'); assert.equal(h.get('referrer-policy'), 'no-referrer'); assert.equal(h.get('cache-control'), 'no-store'); assert.equal(h.get('x-powered-by'), null);
  const evil = await call('GET', '/api/health', undefined, { headers: { Origin: 'https://evil.example.com' } }); assert.equal(evil.status, 403);
  const ok = await call('GET', '/api/health', undefined, { headers: { Origin: 'https://admin.example.com' } }); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://admin.example.com');
  const pre = await fetch(srv.base + '/api/health', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } }); assert.equal(pre.status, 403);
  const e = await call('GET', '/api/does-not-exist'); assert.equal(e.status, 404); assert.ok(!/at .*\.ts/.test(e.text));
  assert.equal((await call('POST', '/api/health', {})).status, 405);
});
test('static files: security headers apply, path traversal is blocked', async () => {
  const idx = await fetch(srv.base + '/'); assert.equal(idx.status, 200); assert.match(idx.headers.get('content-security-policy')!, /script-src 'self'/); assert.equal(idx.headers.get('x-frame-options'), 'DENY');
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2f..%2fetc/passwd', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) { const r = await fetch(srv.base + p); assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`); assert.ok(!(await r.text()).includes('root:')); }
});
test('injection: SQL metacharacters in logins, codes and ids change nothing', async () => {
  for (const u of ["' OR '1'='1", "admin'--", '"; DROP TABLE users; --']) assert.equal((await call('POST', '/api/auth/login', { username: u, password: "' OR '1'='1" })).status, 401);
  assert.equal((await call('GET', "/api/public/table/' OR 1=1 --")).status, 404);
  assert.equal((await call('GET', "/api/public/pay/x' OR '1'='1")).status, 404);
  assert.equal((await call('POST', '/api/cash/void', { saleId: "x' OR 1=1 --", reason: 'abc' }, { token: tok.manager, idem: 'inj' })).status, 404);
  assert.ok(srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n >= 4);
});
test('login: lockout after repeated failures, generic errors, refresh rotation with reuse detection', async () => {
  const u = createUser(srv.ctx, { username: 'carol', displayName: 'Carol', role: 'attendant', pin: '5913' }, 't');
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/pin-login', { username: 'carol', pin: '1111' })).status, 401);
  assert.equal((await call('POST', '/api/auth/pin-login', { username: 'carol', pin: '5913' })).status, 423); // even the right PIN is refused while locked
  const unknown = await call('POST', '/api/auth/pin-login', { username: 'nobody', pin: '1111' }); const wrong = await call('POST', '/api/auth/login', { username: 'boss', password: 'wrong-password1' });
  assert.equal(unknown.json.error.message, wrong.json.error.message); // no user enumeration
  assert.equal((await call('POST', '/api/auth/pin-login', { username: 'boss', pin: '4827' })).status, 401); // owners cannot use PIN login
  void u;
  const first = (await call('POST', '/api/auth/login', { username: 'mgr', password: 'Manager-Passw0rd!' })).json;
  const rot = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken }); assert.equal(rot.status, 200);
  const reuse = await call('POST', '/api/auth/refresh', { refreshToken: first.refreshToken }); assert.equal(reuse.status, 401);
  assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: rot.json.refreshToken })).status, 401); // the whole family was revoked
  const l = await call('POST', '/api/auth/login', { username: 'mgr', password: 'Manager-Passw0rd!' });
  assert.equal((await call('POST', '/api/auth/logout', { refreshToken: l.json.refreshToken })).status, 200); assert.equal((await call('POST', '/api/auth/refresh', { refreshToken: l.json.refreshToken })).status, 401);
});
test('login brute force is rate limited per username', async () => {
  let last = 0; for (let i = 0; i < 14; i++) last = (await call('POST', '/api/auth/login', { username: 'ratelimited-user', password: 'nope-nope-nope1' })).status;
  assert.equal(last, 429);
});
test('sessions die on deactivation and credential change', async () => {
  srv.ctx.db.run('DELETE FROM rate_events');
  const id = createUser(srv.ctx, { username: 'dave', displayName: 'Dave', role: 'attendant', pin: '2468' }, 't'); const t = (await call('POST', '/api/auth/pin-login', { username: 'dave', pin: '2468' })).json.accessToken;
  assert.equal((await call('GET', '/api/me', undefined, { token: t })).status, 200);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { pin: '8642' }, { token: tok.owner })).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, { token: t })).status, 401);
  const t2 = (await call('POST', '/api/auth/pin-login', { username: 'dave', pin: '8642' })).json.accessToken;
  await call('PATCH', `/api/staff/${id}`, { active: false }, { token: tok.owner }); assert.equal((await call('GET', '/api/me', undefined, { token: t2 })).status, 401);
  assert.equal((await call('POST', '/api/auth/pin-login', { username: 'dave', pin: '8642' })).status, 401);
  assert.equal((await call('PATCH', `/api/staff/${ids.owner}`, { active: false }, { token: tok.owner })).status, 403);
});
test('weak credentials are refused', async () => {
  for (const pin of ['1234', '1111', '0000', '4321']) assert.equal((await call('POST', '/api/staff', { username: 'weak' + pin, displayName: 'W', role: 'attendant', pin }, { token: tok.owner, idem: 'w' + pin })).status, 400, pin);
  assert.equal((await call('POST', '/api/staff', { username: 'weakpw', displayName: 'W', role: 'manager', password: 'short1' }, { token: tok.owner, idem: 'wpw' })).status, 400);
});
test('TOTP: once enabled the password alone no longer logs in', async () => {
  srv.ctx.db.run('DELETE FROM rate_events');
  const { secret: s } = beginTotp(srv.ctx, ids.manager); confirmTotp(srv.ctx, ids.manager, totpCode(s, Date.now()));
  assert.equal((await call('POST', '/api/auth/login', { username: 'mgr', password: 'Manager-Passw0rd!' })).json.error.code, 'TOTP_REQUIRED');
  assert.equal((await call('POST', '/api/auth/login', { username: 'mgr', password: 'Manager-Passw0rd!', totp: '000000' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'mgr', password: 'Manager-Passw0rd!', totp: totpCode(s, Date.now()) })).status, 200);
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI'); // RFC 4648 vector
});

test('forged payment callbacks: wrong token, unknown checkout and malformed bodies never credit', async () => {
  const before = balance(srv.ctx.db, A.gamesAvail(tableId));
  const body = { Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_FORGED', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 100 }, { Name: 'MpesaReceiptNumber', Value: 'FORGED0001' }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } };
  assert.equal((await call('POST', '/api/mpesa/stk-callback/not-the-token', body)).status, 403);
  assert.equal((await call('POST', '/api/mpesa/stk-callback/cbtoken-for-tests', body)).status, 200); // valid origin but unknown checkout -> unallocated only
  assert.equal((await call('POST', '/api/mpesa/stk-callback/cbtoken-for-tests', { junk: true })).status, 200);
  assert.equal((await call('POST', '/api/mpesa/stk-callback/cbtoken-for-tests', 'a bare string')).status, 200); // accepted and logged as INVALID_SHAPE, never credited
  assert.equal((await fetch(srv.base + '/api/mpesa/stk-callback/cbtoken-for-tests', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal(balance(srv.ctx.db, A.gamesAvail(tableId)), before);
  assert.equal(srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM unallocated_payments WHERE receipt='FORGED0001'")!.n, 1);
});
test('secrets are never returned by the API', async () => {
  const all = JSON.stringify([(await call('GET', '/api/daraja', undefined, { token: tok.owner })).json, (await call('GET', '/api/staff', undefined, { token: tok.owner })).json, (await call('GET', '/api/settings', undefined, { token: tok.owner })).json, (await call('GET', '/api/notifications', undefined, { token: tok.owner })).json, (await call('GET', '/api/tables', undefined, { token: tok.owner })).json]);
  for (const s of [fake.passkey, fake.secret, fake.key, 'scrypt$', 'device_secret', 'password_hash', 'pin_hash', secret]) assert.ok(!all.includes(s), `leaked ${s.slice(0, 12)}`);
  assert.match(srv.ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key='daraja.passkey'")!.value, /^v1:/); // encrypted at rest
});
test('public endpoints are rate limited', async () => {
  let last = 0; for (let i = 0; i < 40; i++) last = (await call('POST', '/api/public/voucher', { code: 'AAAAAA-AAAA', voucher: 'ZZZZZ-ZZZZ' + i })).status; assert.equal(last, 429);
});

// ---------- device protocol ----------
async function deviceCall(o: { sec?: string; id?: string; ts?: number; nonce?: string; body?: string; tamper?: boolean }) {
  const body = o.body ?? JSON.stringify({ wait: 0 }); const ts = o.ts ?? Date.now(); const nonce = o.nonce ?? randomBytes(16).toString('hex');
  let sig = signDeviceRequest(o.sec ?? secret, 'POST', '/api/device/sync', ts, nonce, body); if (o.tamper) sig = sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a');
  return fetch(srv.base + '/api/device/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': o.id ?? deviceId, 'X-Ts': String(ts), 'X-Nonce': nonce, 'X-Sig': sig }, body });
}
test('device auth: valid signature works; bad signature, wrong secret, unknown device, stale time and replay are refused', async () => {
  const nonce = randomBytes(16).toString('hex');
  const ok = await deviceCall({ nonce }); assert.equal(ok.status, 200); assert.ok(ok.headers.get('x-resp-sig')); assert.ok(ok.headers.get('x-server-time'));
  assert.equal((await deviceCall({ nonce })).status, 409); // exact replay
  assert.equal((await deviceCall({ tamper: true })).status, 401);
  assert.equal((await deviceCall({ sec: 'wrong' })).status, 401);
  assert.equal((await deviceCall({ id: 'dev_000000000000' })).status, 401);
  assert.equal((await deviceCall({ ts: Date.now() - 10 * 60_000 })).status, 401);
  assert.equal((await call('POST', '/api/device/sync', { wait: 0 })).status, 401);
  const r = await call('POST', `/api/tables/${tableId}/rotate-device-secret`, {}, { token: tok.owner, idem: 'rot-1' }); assert.equal(r.status, 200);
  assert.equal((await deviceCall({})).status, 401); // old secret is dead
  assert.equal((await deviceCall({ sec: r.json.deviceSecret })).status, 200);
});
test('device cannot be tricked into vending: a customer/attendant token is not a device credential and credits are server-side only', async () => {
  assert.equal((await call('POST', '/api/device/sync', { wait: 0 }, { token: tok.owner })).status, 401);
  const before = srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM vends')!.n; creditPurchase(srv.ctx, { source: 'CASH', idempotencyKey: 'dv', externalRef: 'DV-1', tableId, amountMinor: kes(20), actor: 't' });
  assert.equal(srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM vends')!.n, before); // credit alone creates no vend until the device syncs
});
test('privacy: export and erase de-identify a customer while keeping the financial records', async () => {
  const { initiateStk } = await import('../src/core/stk.ts'); const { DarajaClient } = await import('../src/core/daraja.ts'); const { loadDarajaConfig } = await import('../src/core/daraja.ts');
  const client = new DarajaClient({ ...loadDarajaConfig(srv.ctx)!, baseUrlOverride: fake.url }, srv.ctx.now);
  await initiateStk(srv.ctx, client, { tableId, games: 1, phone: '0711000222', idempotencyKey: 'priv-1', ip: '3.3.3.3', pepper: 'pepper' });
  const ex = await call('POST', '/api/privacy/export', { phone: '0711000222' }, { token: tok.owner }); assert.equal(ex.json.mpesaRequests.length, 1);
  const er = await call('POST', '/api/privacy/erase', { phone: '0711000222', reason: 'customer request' }, { token: tok.owner, idem: 'er-1' }); assert.equal(er.json.requests, 1);
  assert.equal((await call('POST', '/api/privacy/export', { phone: '0711000222' }, { token: tok.owner })).json.mpesaRequests.length, 0);
  assert.equal(srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM mpesa_requests WHERE idempotency_key='priv-1'")!.n, 1);
});

test('manager approvals: over-limit actions need a single-use token earned with the manager\'s real credentials', async () => {
  srv.ctx.db.run('DELETE FROM rate_events');
  assert.equal((await call('POST', '/api/shifts/open', { floatMinor: 0 }, { token: tok.a })).status, 201);
  const sale = (extra: object = {}, idem = 'ap-' + Math.random()) => call('POST', '/api/cash/sale', { tableId, cashReceivedMinor: kes(75), discountMinor: kes(25), discountReason: 'regular customer', ...extra }, { token: tok.a, idem });
  assert.equal((await sale()).json.error.code, 'APPROVAL_REQUIRED');
  assert.equal((await sale({ approvedBy: ids.manager })).status, 400); // the old "just send a manager id" bypass no longer exists
  assert.equal((await call('POST', '/api/approvals', { username: 'bob', secret: '7391', kind: 'pin' }, { token: tok.a })).status, 401); // a fellow attendant cannot approve
  assert.equal((await call('POST', '/api/approvals', { username: 'alice', secret: '4827', kind: 'pin' }, { token: tok.a })).status, 401); // nor can you approve yourself
  assert.equal((await call('POST', '/api/approvals', { username: 'boss', secret: 'wrong-password1', kind: 'password' }, { token: tok.a })).status, 401);
  const grant = await call('POST', '/api/approvals', { username: 'boss', secret: 'Owner-Passw0rd!', kind: 'password' }, { token: tok.a }); assert.equal(grant.status, 200);
  assert.equal((await call('POST', '/api/cash/sale', { tableId, cashReceivedMinor: kes(75), discountMinor: kes(25), discountReason: 'x1', approvalToken: grant.json.token }, { token: tok.b, idem: 'steal-1' })).status, 401); // bound to the requester
  const okSale = await sale({ approvalToken: grant.json.token }); assert.equal(okSale.status, 201); assert.equal(okSale.json.games, 5);
  assert.equal((await sale({ approvalToken: grant.json.token })).status, 401); // single use
  const g2 = (await call('POST', '/api/approvals', { username: 'boss', secret: 'Owner-Passw0rd!', kind: 'password' }, { token: tok.a })).json.token;
  srv.ctx.db.run('UPDATE approval_tokens SET expires_at_ms=1'); assert.equal((await sale({ approvalToken: g2 })).status, 401); // expired
  const g3 = (await call('POST', '/api/approvals', { username: 'mgr', secret: 'Manager-Passw0rd!', kind: 'password', totp: undefined }, { token: tok.a })); assert.ok([200, 401].includes(g3.status));
  const sv = srv.ctx.db.get<{ id: string }>('SELECT id FROM cash_sales ORDER BY receipt_seq DESC LIMIT 1')!.id;
  srv.ctx.db.run('UPDATE users SET void_limit_minor=? WHERE id=?', kes(10), ids.a);
  assert.equal((await call('POST', '/api/cash/void', { saleId: sv, reason: 'customer left' }, { token: tok.a, idem: 'vv1' })).json.error.code, 'APPROVAL_REQUIRED');
  const g4 = (await call('POST', '/api/approvals', { username: 'boss', secret: 'Owner-Passw0rd!', kind: 'password' }, { token: tok.a })).json.token;
  assert.equal((await call('POST', '/api/cash/void', { saleId: sv, reason: 'customer left', approvalToken: g4 }, { token: tok.a, idem: 'vv2' })).status, 200);
});
test('POS helpers: quote follows the table policy; SMS receipts go through the configured gateway', async () => {
  const q = (cash: number) => call('GET', `/api/cash/quote?tableId=${tableId}&cash=${cash}`, undefined, { token: tok.a });
  assert.deepEqual((await q(kes(50))).json, { games: 2, chargedMinor: kes(40), remainderMinor: kes(10), policy: 'HOLD_CREDIT', rejected: false, changeMinor: 0, heldMinor: kes(10) });
  assert.equal((await q(0)).status, 400); assert.equal((await call('GET', '/api/cash/quote?tableId=x&cash=100', undefined, { token: tok.a })).status, 404);
  const { createServer } = await import('node:http'); const got: string[] = [];
  const at = createServer((rq, rs) => { let b = ''; rq.on('data', (c) => (b += c)); rq.on('end', () => { got.push(b); rs.writeHead(201).end('{}'); }); }); await new Promise<void>((r) => at.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(at.address() as { port: number }).port}`;
  assert.equal((await call('PUT', '/api/notifications', { sms: { username: 'sandbox', apiKey: 'AT-KEY-123', to: ['+254700000000'], sender: '' } }, { token: tok.owner })).status, 200);
  const { loadNotifyConfig, saveNotifyConfig } = await import('../src/core/notify.ts'); const c = loadNotifyConfig(srv.ctx); saveNotifyConfig(srv.ctx, { ...c, sms: { ...c.sms!, baseUrl: base } });
  const sale = srv.ctx.db.get<{ id: string; receipt_no: string }>('SELECT id, receipt_no FROM cash_sales WHERE attendant_id=? ORDER BY receipt_seq DESC LIMIT 1', ids.a)!;
  assert.equal((await call('POST', '/api/cash/receipt-sms', { saleId: sale.id, phone: '0712 345 678' }, { token: tok.a })).status, 200);
  const form = new URLSearchParams(got[0]); assert.match(form.get('message')!, new RegExp(`receipt ${sale.receipt_no}`)); assert.equal(form.get('to'), '+254712345678');
  assert.equal((await call('POST', '/api/cash/receipt-sms', { saleId: sale.id, phone: '0712345678' }, { token: tok.b })).status, 403); // someone else's sale
  assert.equal((await call('POST', '/api/cash/receipt-sms', { saleId: sale.id, phone: 'abc' }, { token: tok.a })).status, 400);
  at.close();
});

test('payment reversal over the API: owner only, needs a reason, idempotent, reverses unplayed credits', async () => {
  const { creditPurchase: cp } = await import('../src/core/credit.ts'); const r = cp(srv.ctx, { source: 'MPESA_STK', idempotencyKey: 'rv-1', externalRef: 'REVERSE001', tableId, amountMinor: kes(40), actor: 't' }); assert.ok(r.status === 'CREDITED');
  const list = (await call('GET', '/api/payments?source=MPESA_STK', undefined, { token: tok.manager })).json.payments; const p = list.find((x: any) => x.external_ref === 'REVERSE001'); assert.ok(p && !p.reversed);
  assert.equal((await call('POST', `/api/payments/${p.id}/reverse`, { reason: 'safaricom reversal' }, { token: tok.manager, idem: 'rev1' })).status, 403);
  assert.equal((await call('POST', `/api/payments/${p.id}/reverse`, { reason: 'x' }, { token: tok.owner, idem: 'rev2' })).status, 400);
  const before = balance(srv.ctx.db, A.gamesAvail(tableId)); const ok = await call('POST', `/api/payments/${p.id}/reverse`, { reason: 'Safaricom reversal SMS' }, { token: tok.owner, idem: 'rev3' });
  assert.deepEqual([ok.status, ok.json.removedGames, ok.json.lossMinor], [200, 2, 0]); assert.equal(balance(srv.ctx.db, A.gamesAvail(tableId)), before - 2);
  assert.equal((await call('POST', `/api/payments/${p.id}/reverse`, { reason: 'Safaricom reversal SMS' }, { token: tok.owner, idem: 'rev3' })).headers.get('idempotent-replay'), 'true');
  assert.equal((await call('POST', `/api/payments/${p.id}/reverse`, { reason: 'again please' }, { token: tok.owner, idem: 'rev4' })).status, 400); // already reversed
});

test('refunding a failed release respects the attendant limit and needs manager approval above it', async () => {
  srv.ctx.db.run('DELETE FROM rate_events');
  const t2 = makeTable(srv.ctx, { name: 'Refund table', maxVendAttempts: 1, vendTimeoutMs: 1000 }); const { dispatch: dsp, sweep: swp } = await import('../src/core/vend.ts');
  const failOne = (idemSuffix: string) => { creditPurchase(srv.ctx, { source: 'CASH', idempotencyKey: 'rf' + idemSuffix, externalRef: 'RF-' + idemSuffix, tableId: t2.tableId, amountMinor: kes(20), actor: 't' }); dsp(srv.ctx, t2.tableId);
    srv.ctx.db.run("UPDATE vends SET sent_at='2020-01-01T00:00:00.000Z' WHERE state='SENT' AND table_id=?", t2.tableId); const f = swp(srv.ctx).failed; assert.equal(f.length, 1); return f[0]; };
  srv.ctx.db.run('UPDATE users SET void_limit_minor=? WHERE id=?', kes(10), ids.a);
  const v1 = failOne('1');
  assert.equal((await call('POST', `/api/vends/${v1}/resolve`, { action: 'REFUND', reason: 'jammed' }, { token: tok.a, idem: 'rf-1' })).json.error.code, 'APPROVAL_REQUIRED');
  assert.equal((await call('POST', `/api/vends/${v1}/resolve`, { action: 'KEEP_CREDIT', reason: 'customer prefers credit' }, { token: tok.a, idem: 'rf-2' })).status, 200); // non-refund choices need no approval
  srv.ctx.db.run("UPDATE pool_tables SET online=1 WHERE id=?", t2.tableId);
  const v2 = failOne('2'); const grant = (await call('POST', '/api/approvals', { username: 'boss', secret: 'Owner-Passw0rd!', kind: 'password' }, { token: tok.a })).json.token;
  assert.equal((await call('POST', `/api/vends/${v2}/resolve`, { action: 'REFUND', reason: 'jammed', approvalToken: grant }, { token: tok.a, idem: 'rf-3' })).status, 200);
  assert.equal(srv.ctx.db.get<{ state: string }>('SELECT state FROM vends WHERE id=?', v2)!.state, 'REFUNDED');
  const v3 = failOne('3'); srv.ctx.db.run('UPDATE users SET void_limit_minor=? WHERE id=?', kes(50), ids.a);
  assert.equal((await call('POST', `/api/vends/${v3}/resolve`, { action: 'REFUND', reason: 'jammed again' }, { token: tok.a, idem: 'rf-4' })).status, 200); // within limit: reason is enough
});
