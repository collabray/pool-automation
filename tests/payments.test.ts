import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newCtx, makeTable, addUser, basePricing, type TestCtx } from './helpers/ctx.ts';
import { FakeDaraja } from './helpers/fake-daraja.ts';
import { DarajaClient, saveDarajaConfig, loadDarajaConfig, testDarajaConnection, darajaTimestamp, darajaPassword, type DarajaConfig } from '../src/core/daraja.ts';
import { initiateStk, handleStkCallback, reconcilePending, parseStkCallback, StkShapeError, StkError, verifyCallbackOrigin, getRequestStatus } from '../src/core/stk.ts';
import { handleC2bConfirmation } from '../src/core/c2b.ts';
import { assignUnallocated, listUnallocated, AssignError } from '../src/core/unallocated.ts';
import { reversePayment } from '../src/core/reversal.ts';
import { dispatch } from '../src/core/vend.ts';
import { signedTableCode } from '../src/core/tablecode.ts';
import { setSetting } from '../src/core/settings.ts';
import { A, balance, verifyLedger } from '../src/core/ledger.ts';
import { verifyAuditChain } from '../src/core/audit.ts';
import { kes } from '../src/core/money.ts';
import { ownerSummary } from '../src/core/reports.ts';

const PEPPER = 'pepper';
let fake: FakeDaraja;
before(async () => { fake = new FakeDaraja(); await fake.start(); });
after(async () => { await fake.stop(); });

const cfg = (o: Partial<DarajaConfig> = {}): DarajaConfig => ({ env: 'sandbox', shortcode: fake.shortcode, partyB: fake.shortcode, passkey: fake.passkey, consumerKey: fake.key, consumerSecret: fake.secret,
  txType: 'CustomerPayBillOnline', callbackBaseUrl: 'https://pool.example.com', callbackToken: 'secrettoken123', baseUrlOverride: fake.url, ...o });
function setup(o: Partial<DarajaConfig> = {}) {
  const ctx = newCtx(); const t = makeTable(ctx); const client = new DarajaClient(cfg(o), ctx.now);
  saveDarajaConfig(ctx, cfg(o), 'owner');
  fake.pushes = []; fake.nextOutcome = 'success'; fake.tokenCalls = 0; fake.queryCalls = 0;
  return { ctx, client, tableId: t.tableId };
}
const pay = (ctx: TestCtx, client: DarajaClient, tableId: string, o: Record<string, unknown> = {}) =>
  initiateStk(ctx, client, { tableId, games: 5, phone: '0712345678', idempotencyKey: `k${Math.random()}`, ip: '1.2.3.4', pepper: PEPPER, ...o });
const credits = (ctx: TestCtx, t: string) => balance(ctx.db, A.gamesAvail(t));

test('daraja: timestamp is EAT, password per spec, config round-trips encrypted', () => {
  assert.equal(darajaTimestamp(new Date('2026-10-20T09:05:07Z')), '20261020120507');
  assert.equal(darajaPassword('174379', 'pk', '20261020120507'), Buffer.from('174379pk20261020120507').toString('base64'));
  const { ctx } = setup();
  assert.deepEqual({ ...loadDarajaConfig(ctx)!, baseUrlOverride: fake.url }, cfg());
  const raw = ctx.db.all<{ value: string }>("SELECT value FROM settings WHERE key LIKE 'daraja.%key%' OR key='daraja.passkey' OR key='daraja.consumer_secret'");
  for (const r of raw) assert.ok(r.value.startsWith('v1:'), 'secret must be encrypted at rest');
});
test('daraja: token cached, refreshed after expiry; test-connection reports good and bad credentials', async () => {
  const { ctx, client } = setup(); fake.tokenTtl = 3599;
  await client.getToken(); await client.getToken();
  assert.equal(fake.tokenCalls, 1);
  ctx.clock.ms += 3_550_000; await client.getToken();
  assert.equal(fake.tokenCalls, 2);
  assert.equal((await testDarajaConnection(client)).ok, true);
  const bad = new DarajaClient(cfg({ consumerSecret: 'wrong' }), ctx.now);
  assert.equal((await testDarajaConnection(bad)).ok, false);
});

test('STK success: push for exact amount, phone normalised, callback credits 5 games, receipt shown', async () => {
  const { ctx, client, tableId } = setup();
  const r = await pay(ctx, client, tableId, { phone: '+254 712 345 678' });
  assert.equal(r.status, 'PENDING'); assert.equal(r.amountMinor, kes(100));
  const push = fake.pushes[0];
  assert.equal(push.amount, 100); assert.equal(push.phone, '254712345678'); assert.equal(push.txType, 'CustomerPayBillOnline');
  assert.equal(push.callbackUrl, 'https://pool.example.com/api/mpesa/stk-callback/secrettoken123');
  const out = await handleStkCallback(ctx, client, fake.callbackBody(push.checkoutRequestId, { receipt: 'SGH7K2L9QW' }), '196.201.214.200');
  assert.deepEqual(out, { verdict: 'CREDITED', tableId });
  assert.equal(credits(ctx, tableId), 5);
  const st = getRequestStatus(ctx, r.requestId)!;
  assert.deepEqual([st.status, st.receipt], ['SUCCESS', 'SGH7K2L9QW']);
  assert.equal(dispatch(ctx, tableId).length, 1);
  assert.deepEqual(verifyLedger(ctx.db), []); assert.equal(verifyAuditChain(ctx.db).ok, true);
});
test('STK: Till transaction type is passed through', async () => {
  const { ctx, client, tableId } = setup({ txType: 'CustomerBuyGoodsOnline', partyB: '5550001' });
  await pay(ctx, client, tableId);
  assert.equal(fake.pushes[0].txType, 'CustomerBuyGoodsOnline'); assert.equal(fake.pushes[0].partyB, '5550001');
});
test('STK double tap: identical idempotency key sent in parallel and again later => exactly one push', async () => {
  const { ctx, client, tableId } = setup();
  const key = 'tap-1';
  const rs = await Promise.all([pay(ctx, client, tableId, { idempotencyKey: key }), pay(ctx, client, tableId, { idempotencyKey: key }), pay(ctx, client, tableId, { idempotencyKey: key })]);
  await pay(ctx, client, tableId, { idempotencyKey: key });
  assert.equal(fake.pushes.length, 1);
  assert.equal(new Set(rs.map((r) => r.requestId)).size, 1);
  assert.equal(rs.filter((r) => !r.duplicate).length, 1);
});
test('STK user outcomes: cancelled, wrong PIN, insufficient funds, timeout, then retry works', async () => {
  const { ctx, client, tableId } = setup();
  for (const [outcome, status] of [['cancel', 'CANCELLED'], ['wrong_pin', 'WRONG_PIN'], ['insufficient', 'INSUFFICIENT_FUNDS'], ['timeout', 'TIMEOUT']] as const) {
    fake.nextOutcome = outcome; ctx.clock.ms += 20_000; // beyond cooldown
    const r = await pay(ctx, client, tableId);
    const out = await handleStkCallback(ctx, client, fake.callbackBody(fake.pushes.at(-1)!.checkoutRequestId), '1.1.1.1');
    assert.equal(out.verdict, 'FAILURE_RECORDED'); assert.equal(getRequestStatus(ctx, r.requestId)!.status, status);
  }
  assert.equal(credits(ctx, tableId), 0);
  fake.nextOutcome = 'success'; ctx.clock.ms += 20_000;
  await pay(ctx, client, tableId); await handleStkCallback(ctx, client, fake.callbackBody(fake.pushes.at(-1)!.checkoutRequestId), '1.1.1.1');
  assert.equal(credits(ctx, tableId), 5);
});
test('STK blocks before payment when table offline, faulted or disabled; no push is sent', async () => {
  const { ctx, client, tableId } = setup();
  const expectBlocked = async (detail: string) => { await assert.rejects(pay(ctx, client, tableId), (e: any) => e instanceof StkError && e.code === 'TABLE_UNAVAILABLE' && e.detail === detail); };
  ctx.db.run('UPDATE pool_tables SET online=0'); await expectBlocked('OFFLINE');
  ctx.db.run("UPDATE pool_tables SET online=1, status='FAULTED'"); await expectBlocked('FAULTED');
  ctx.db.run("UPDATE pool_tables SET status='DISABLED'"); await expectBlocked('DISABLED');
  assert.equal(fake.pushes.length, 0);
});
test('STK validation: bad phone, game limits; rate limits per phone/cooldown/ip/table', async () => {
  const { ctx, client, tableId } = setup();
  await assert.rejects(pay(ctx, client, tableId, { phone: '12345' }), /valid Safaricom/);
  await assert.rejects(pay(ctx, client, tableId, { games: 0 }), (e: any) => e.code === 'INVALID_GAMES');
  await assert.rejects(pay(ctx, client, tableId, { games: 21 }), (e: any) => e.code === 'INVALID_GAMES');
  await pay(ctx, client, tableId);
  await assert.rejects(pay(ctx, client, tableId), (e: any) => e.code === 'RATE_LIMITED' && e.detail === 'COOLDOWN');
  setSetting(ctx, 'stk.cooldown_ms', '1'); setSetting(ctx, 'limits.stk_per_phone_hour', '3');
  ctx.clock.ms += 10; await pay(ctx, client, tableId); ctx.clock.ms += 10; await pay(ctx, client, tableId); ctx.clock.ms += 10;
  await assert.rejects(pay(ctx, client, tableId), (e: any) => e.code === 'RATE_LIMITED');
  await pay(ctx, client, tableId, { phone: '0722000111' }); // another phone is unaffected
  setSetting(ctx, 'limits.stk_per_ip_hour', '4'); ctx.clock.ms += 10;
  await assert.rejects(pay(ctx, client, tableId, { phone: '0733000111' }), (e: any) => e.code === 'RATE_LIMITED');
  setSetting(ctx, 'limits.stk_per_ip_hour', '99'); setSetting(ctx, 'limits.stk_per_table_hour', '4'); ctx.clock.ms += 10;
  await assert.rejects(pay(ctx, client, tableId, { phone: '0744000111', ip: '9.9.9.9' }), (e: any) => e.code === 'RATE_LIMITED');
});
test('STK: Daraja rejection => FAILED; ambiguous network failure => FAILED + owner alert, never a silent loss', async () => {
  const { ctx, client, tableId } = setup();
  fake.failNextPush = { status: 400, body: { errorCode: '400.002.02', errorMessage: 'Bad Request' } };
  assert.equal((await pay(ctx, client, tableId)).status, 'FAILED');
  assert.equal(ctx.db.all("SELECT 1 FROM alerts WHERE kind='STK_UNCERTAIN'").length, 0);
  const dead = new DarajaClient(cfg({ baseUrlOverride: 'http://127.0.0.1:1' }), ctx.now); ctx.clock.ms += 20_000;
  assert.equal((await pay(ctx, dead, tableId, { phone: '0700000001' })).status, 'FAILED');
  assert.equal(ctx.db.all("SELECT 1 FROM alerts WHERE kind='STK_UNCERTAIN'").length, 1);
});
test('late callback after timeout still credits correctly', async () => {
  const { ctx, client, tableId } = setup();
  const r = await pay(ctx, client, tableId); const co = fake.pushes[0].checkoutRequestId;
  ctx.clock.ms += 120_000; await reconcilePending(ctx, null);
  assert.equal(getRequestStatus(ctx, r.requestId)!.status, 'TIMEOUT');
  assert.equal((await handleStkCallback(ctx, client, fake.callbackBody(co), '1.1.1.1')).verdict, 'CREDITED');
  assert.equal(credits(ctx, tableId), 5);
});
test('lost callback: reconciler queries Daraja and credits; a later real callback does not double credit', async () => {
  const { ctx, client, tableId } = setup(); fake.nextOutcome = 'lost_callback';
  const r = await pay(ctx, client, tableId); const co = fake.pushes[0].checkoutRequestId;
  ctx.clock.ms += 31_000;
  const rec = await reconcilePending(ctx, client);
  assert.deepEqual(rec, { credited: [tableId], checked: 1 });
  assert.equal(credits(ctx, tableId), 5);
  const row = ctx.db.get<{ credited_without_receipt: number; receipt: string | null }>('SELECT credited_without_receipt, receipt FROM mpesa_requests WHERE id=?', r.requestId)!;
  assert.equal(row.credited_without_receipt, 1);
  assert.equal((await handleStkCallback(ctx, client, fake.callbackBody(co, { receipt: 'LATEREAL01' }), '1.1.1.1')).verdict, 'DUPLICATE');
  assert.equal(credits(ctx, tableId), 5);
  assert.equal(ctx.db.get<{ receipt: string }>('SELECT receipt FROM mpesa_requests WHERE id=?', r.requestId)!.receipt, 'LATEREAL01');
  assert.deepEqual(await reconcilePending(ctx, client), { credited: [], checked: 0 });
  assert.deepEqual(verifyLedger(ctx.db), []);
});
test('reconciler: processing => exponential backoff, no credit; failed query => terminal status; stale expires', async () => {
  const { ctx, client, tableId } = setup(); fake.nextOutcome = 'processing';
  const r = await pay(ctx, client, tableId); ctx.clock.ms += 31_000;
  await reconcilePending(ctx, client); assert.equal(fake.queryCalls, 1);
  await reconcilePending(ctx, client); assert.equal(fake.queryCalls, 1); // backoff: not due yet
  ctx.clock.ms += 61_000; await reconcilePending(ctx, client); assert.equal(fake.queryCalls, 2);
  fake.pushes[0].outcome = 'cancel'; ctx.clock.ms += 130_000; await reconcilePending(ctx, client);
  assert.equal(getRequestStatus(ctx, r.requestId)!.status, 'CANCELLED'); assert.equal(credits(ctx, tableId), 0);
  fake.nextOutcome = 'processing'; ctx.clock.ms += 20_000;
  const r2 = await pay(ctx, client, tableId); ctx.clock.ms += 2 * 3_600_000; await reconcilePending(ctx, null);
  assert.equal(getRequestStatus(ctx, r2.requestId)!.status, 'EXPIRED');
});
test('duplicate callbacks credit once', async () => {
  const { ctx, client, tableId } = setup(); await pay(ctx, client, tableId);
  const body = fake.callbackBody(fake.pushes[0].checkoutRequestId);
  const v = []; for (let i = 0; i < 5; i++) v.push((await handleStkCallback(ctx, client, body, '1.1.1.1')).verdict);
  assert.deepEqual(v, ['CREDITED', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
  assert.equal(credits(ctx, tableId), 5);
});
test('wrong amount, wrong phone, unknown CheckoutRequestID => unallocated, never vend', async () => {
  const { ctx, client, tableId } = setup();
  await pay(ctx, client, tableId);
  assert.equal((await handleStkCallback(ctx, client, fake.callbackBody(fake.pushes[0].checkoutRequestId, { amount: 20, receipt: 'WRONGAMT01' }), '1.1.1.1')).verdict, 'AMOUNT_MISMATCH');
  ctx.clock.ms += 20_000; await pay(ctx, client, tableId, { phone: '0711111111' });
  assert.equal((await handleStkCallback(ctx, client, fake.callbackBody(fake.pushes[1].checkoutRequestId, { phone: '254799999999', receipt: 'WRONGPHN01' }), '1.1.1.1')).verdict, 'PHONE_MISMATCH');
  const unknown = { Body: { stkCallback: { MerchantRequestID: 'x', CheckoutRequestID: 'ws_CO_UNKNOWN', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 100 }, { Name: 'MpesaReceiptNumber', Value: 'UNKNOWN001' }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } };
  assert.equal((await handleStkCallback(ctx, client, unknown, '1.1.1.1')).verdict, 'UNALLOCATED_UNKNOWN_CHECKOUT');
  assert.equal(credits(ctx, tableId), 0);
  assert.deepEqual(listUnallocated(ctx).map((u) => u.reason).sort(), ['AMOUNT_MISMATCH', 'PHONE_MISMATCH', 'UNKNOWN_CHECKOUT_REQUEST']);
  assert.equal(balance(ctx.db, A.unallocated), -(kes(20) + kes(100) + 10000));
  assert.deepEqual(verifyLedger(ctx.db), []);
});
test('callback shape validation and forged-callback origin checks', async () => {
  const { ctx, client } = setup();
  for (const bad of [null, {}, { Body: {} }, { Body: { stkCallback: { CheckoutRequestID: 'x' } } }, { Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'c', ResultCode: 0, ResultDesc: 'ok' } } },
    { Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'c', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 'abc' }] } } } }])
    assert.throws(() => parseStkCallback(bad), StkShapeError);
  assert.equal((await handleStkCallback(ctx, client, { hello: 'world' }, '6.6.6.6')).verdict, 'INVALID_SHAPE');
  assert.deepEqual(verifyCallbackOrigin(ctx, 'secrettoken123', '196.201.214.200'), { ok: true });
  assert.deepEqual(verifyCallbackOrigin(ctx, 'wrong-token-xxxx', '1.1.1.1'), { ok: false, reason: 'BAD_TOKEN' });
  assert.deepEqual(verifyCallbackOrigin(ctx, 'short', '1.1.1.1'), { ok: false, reason: 'BAD_TOKEN' });
  setSetting(ctx, 'callback.ip_allowlist', '196.201.214.200, 196.201.214.206');
  assert.deepEqual(verifyCallbackOrigin(ctx, 'secrettoken123', '::ffff:196.201.214.206'), { ok: true });
  assert.deepEqual(verifyCallbackOrigin(ctx, 'secrettoken123', '8.8.8.8'), { ok: false, reason: 'IP_NOT_ALLOWED' });
});
test('success claim on an already-CANCELLED request: STK Query disagrees => nothing credited, owner alerted', async () => {
  const { ctx, client, tableId } = setup(); fake.nextOutcome = 'cancel';
  await pay(ctx, client, tableId); const co = fake.pushes[0].checkoutRequestId;
  const forged = fake.callbackBody(co, { outcome: 'success', receipt: 'FORGED0001' });
  ctx.db.run("UPDATE mpesa_requests SET status='CANCELLED'"); // terminal state + success claim = unusual, so verify with Daraja
  assert.equal((await handleStkCallback(ctx, client, forged, '1.1.1.1')).verdict, 'QUERY_NOT_CONFIRMED');
  assert.equal(credits(ctx, tableId), 0);
  assert.equal(ctx.db.all("SELECT 1 FROM alerts WHERE kind='STK_QUERY_DISAGREES'").length, 1);
});
test('reversal: unvended credits removed; after play, loss is booked and owner alerted; ledger stays balanced', async () => {
  const { ctx, client, tableId } = setup(); await pay(ctx, client, tableId); await handleStkCallback(ctx, client, fake.callbackBody(fake.pushes[0].checkoutRequestId), '1.1.1.1');
  const pid = ctx.db.get<{ id: string }>('SELECT id FROM payments')!.id;
  assert.deepEqual(reversePayment(ctx, { paymentId: pid, reason: 'Safaricom reversal', actor: 'owner' }), { removedGames: 5, lossMinor: 0 });
  assert.equal(credits(ctx, tableId), 0); assert.equal(balance(ctx.db, A.mpesa), 0); assert.equal(balance(ctx.db, A.revenue(tableId)), 0);
  assert.throws(() => reversePayment(ctx, { paymentId: pid, reason: 'again', actor: 'o' }), /already reversed/);
  const s2 = setup(); await pay(s2.ctx, s2.client, s2.tableId); await handleStkCallback(s2.ctx, s2.client, fake.callbackBody(fake.pushes[0].checkoutRequestId), '1.1.1.1'); dispatch(s2.ctx, s2.tableId);
  const pid2 = s2.ctx.db.get<{ id: string }>('SELECT id FROM payments')!.id;
  assert.deepEqual(reversePayment(s2.ctx, { paymentId: pid2, reason: 'reversal', actor: 'owner' }), { removedGames: 4, lossMinor: kes(20) });
  assert.equal(s2.ctx.db.all("SELECT 1 FROM alerts WHERE kind='REVERSAL_AFTER_VEND'").length, 1);
  assert.deepEqual(verifyLedger(s2.ctx.db), []);
});

// ---------------- shared till protection -----------------
const c2b = (id: string, amount: string, ref?: string, extra: Record<string, unknown> = {}) => ({ TransactionType: 'Pay Bill', TransID: id, TransAmount: amount, BusinessShortCode: '174379', BillRefNumber: ref, MSISDN: '254712345678', ...extra });
test('shared till: KES 20 drink payment (no pending request) never vends and lands in unallocated', async () => {
  const { ctx, tableId } = setup();
  assert.equal(handleC2bConfirmation(ctx, c2b('DRINK00001', '20.00'), PEPPER).verdict, 'UNALLOCATED_AUTO_CREDIT_OFF');
  assert.equal(credits(ctx, tableId), 0); assert.equal(listUnallocated(ctx).length, 1);
});
test('shared till: C2B on a Till NEVER vends, even with auto-credit ON and a valid code', () => {
  const { ctx, tableId } = setup({ txType: 'CustomerBuyGoodsOnline' }); setSetting(ctx, 'c2b.auto_credit', '1');
  const code = signedTableCode(ctx, ctx.db.get<{ public_code: string }>('SELECT public_code FROM pool_tables')!.public_code);
  assert.equal(handleC2bConfirmation(ctx, c2b('TILL000001', '100', code), PEPPER).verdict, 'UNALLOCATED_TILL_NO_ACCOUNT');
  assert.equal(credits(ctx, tableId), 0);
});
test('shared till: Paybill C2B vends only with auto-credit ON + valid signed code; wrong/missing/forged code never vends', () => {
  const { ctx, tableId } = setup(); const pub = ctx.db.get<{ public_code: string }>('SELECT public_code FROM pool_tables')!.public_code;
  const code = signedTableCode(ctx, pub);
  assert.equal(handleC2bConfirmation(ctx, c2b('PB00000001', '100', code), PEPPER).verdict, 'UNALLOCATED_AUTO_CREDIT_OFF');
  setSetting(ctx, 'c2b.auto_credit', '1');
  for (const [id, ref] of [['PB00000002', undefined], ['PB00000003', 'TABLE1'], ['PB00000004', `${pub}-AAAA`], ['PB00000005', `ZZZZZZ-${code.slice(7)}`], ['PB00000006', code.toLowerCase().replace('-', ' ')]] as const)
    assert.equal(handleC2bConfirmation(ctx, c2b(id, '100', ref as string), PEPPER).verdict, id === 'PB00000006' ? 'UNALLOCATED_NO_VALID_TABLE_CODE' : 'UNALLOCATED_NO_VALID_TABLE_CODE', id);
  assert.equal(credits(ctx, tableId), 0);
  assert.deepEqual(handleC2bConfirmation(ctx, c2b('PB00000007', '100', code), PEPPER), { verdict: 'CREDITED', tableId });
  assert.equal(credits(ctx, tableId), 5);
  assert.equal(handleC2bConfirmation(ctx, c2b('PB00000007', '100', code), PEPPER).verdict, 'DUPLICATE');
  assert.equal(handleC2bConfirmation(ctx, c2b('BAD', 'x'), PEPPER).verdict, 'INVALID');
  assert.equal(credits(ctx, tableId), 5);
  assert.deepEqual(verifyLedger(ctx.db), []);
});
test('shared till: a C2B echo of an STK payment does not credit twice', async () => {
  const { ctx, client, tableId } = setup(); await pay(ctx, client, tableId);
  await handleStkCallback(ctx, client, fake.callbackBody(fake.pushes[0].checkoutRequestId, { receipt: 'ECHO000001' }), '1.1.1.1');
  setSetting(ctx, 'c2b.auto_credit', '1');
  const code = signedTableCode(ctx, ctx.db.get<{ public_code: string }>('SELECT public_code FROM pool_tables')!.public_code);
  assert.equal(handleC2bConfirmation(ctx, c2b('ECHO000001', '100', code), PEPPER).verdict, 'DUPLICATE');
  assert.equal(credits(ctx, tableId), 5);
});
test('manual assignment: role-limited, reason required, audit-logged, idempotent, ledger-correct; reports separate unallocated', () => {
  const { ctx, tableId } = setup(); const owner = addUser(ctx, 'owner'); const att = addUser(ctx, 'attendant');
  handleC2bConfirmation(ctx, c2b('MAN0000001', '100'), PEPPER);
  const id = (listUnallocated(ctx)[0] as { id: string }).id;
  assert.throws(() => assignUnallocated(ctx, { id, tableId, actorId: att, reason: 'x' }), (e: any) => e instanceof AssignError && e.code === 'FORBIDDEN');
  assert.throws(() => assignUnallocated(ctx, { id, tableId, actorId: owner, reason: ' ' }), (e: any) => e.code === 'REASON_REQUIRED');
  assert.equal(credits(ctx, tableId), 0);
  const r1 = assignUnallocated(ctx, { id, tableId, actorId: owner, reason: 'Customer showed SMS' });
  const r2 = assignUnallocated(ctx, { id, tableId, actorId: owner, reason: 'repeat click' });
  assert.deepEqual([r1.games, r1.duplicate, r2.duplicate, r2.paymentId === r1.paymentId], [5, false, true, true]);
  const t2 = makeTable(ctx, { name: 'T2' }).tableId;
  assert.throws(() => assignUnallocated(ctx, { id, tableId: t2, actorId: owner, reason: 'other' }), (e: any) => e.code === 'ALREADY_ASSIGNED');
  assert.equal(credits(ctx, tableId), 5); assert.equal(credits(ctx, t2), 0);
  assert.equal(balance(ctx.db, A.unallocated), 0); assert.equal(balance(ctx.db, A.mpesa), kes(100));
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE action='unallocated.assigned'")!.n, 1);
  assert.deepEqual(verifyLedger(ctx.db), []); assert.equal(verifyAuditChain(ctx.db).ok, true);
  handleC2bConfirmation(ctx, c2b('DRINK00002', '150'), PEPPER);
  const sum = ownerSummary(ctx, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z');
  assert.equal(sum.poolRevenueMinor, kes(100));
  assert.deepEqual(sum.unallocated, { count: 2, totalMinor: kes(250), pendingCount: 1, pendingMinor: kes(150) });
});
