import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { newCtx, makeTable, addUser, basePricing, type TestCtx } from './helpers/ctx.ts';
import { openShift, cashSale, voidCashSale, closeShift, adjustClosedShift, expectedCash, receiptGaps, CashError } from '../src/core/cash.ts';
import { createVoucherBatch, redeemVoucher, voidVoucherBatch, VoucherError } from '../src/core/vouchers.ts';
import { attendantStats, ownerSummary, periodRange, toCsv } from '../src/core/reports.ts';
import { dispatch, handleAck, resolveFailed } from '../src/core/vend.ts';
import { signAck } from '../src/core/command.ts';
import { decryptSecret } from '../src/core/crypto.ts';
import { setSetting } from '../src/core/settings.ts';
import { A, balance, verifyLedger } from '../src/core/ledger.ts';
import { verifyAuditChain } from '../src/core/audit.ts';
import { kes } from '../src/core/money.ts';

const mk = (o: Record<string, unknown> = {}) => { const ctx = newCtx(); const t = makeTable(ctx, o); const att = addUser(ctx, 'attendant', { id: 'att1' }); const mgr = addUser(ctx, 'manager', { id: 'mgr1' }); const owner = addUser(ctx, 'owner', { id: 'own1' }); return { ctx, tableId: t.tableId, att, mgr, owner }; };
const sale = (ctx: TestCtx, att: string, tableId: string, cash: number, key: string, o: Record<string, unknown> = {}) => cashSale(ctx, { attendantId: att, tableId, cashReceivedMinor: kes(cash), idempotencyKey: key, ...o });
const credits = (ctx: TestCtx, t: string) => balance(ctx.db, A.gamesAvail(t));

test('cash: blocked without an open shift; works after opening; one open shift per attendant', () => {
  const { ctx, att, tableId } = mk();
  assert.throws(() => sale(ctx, att, tableId, 100, 'a'), (e: any) => e instanceof CashError && e.code === 'NO_OPEN_SHIFT');
  openShift(ctx, att, kes(500));
  assert.throws(() => openShift(ctx, att, 0), (e: any) => e.code === 'SHIFT_ALREADY_OPEN');
  const r = sale(ctx, att, tableId, 100, 'a');
  assert.deepEqual([r.games, r.changeMinor, r.receiptNo, r.duplicate], [5, 0, 'C-000001', false]);
  assert.equal(credits(ctx, tableId), 5); assert.equal(balance(ctx.db, A.cash), kes(100));
  assert.deepEqual(verifyLedger(ctx.db), []); assert.equal(verifyAuditChain(ctx.db).ok, true);
});
test('cash: remainder policies. HOLD keeps table credit, REFUND gives change, REJECT refuses (and burns no receipt number)', () => {
  const a = mk(); openShift(a.ctx, a.att, 0);
  const h = sale(a.ctx, a.att, a.tableId, 50, 'h'); assert.deepEqual([h.games, h.changeMinor, h.heldMinor], [2, 0, kes(10)]);
  const b = mk({ pricing: { ...basePricing, remainderPolicy: 'REFUND' } }); openShift(b.ctx, b.att, 0);
  const r = sale(b.ctx, b.att, b.tableId, 50, 'r'); assert.deepEqual([r.games, r.changeMinor], [2, kes(10)]);
  assert.equal(balance(b.ctx.db, A.cash), kes(40)); assert.equal(expectedCash(b.ctx, (b.ctx.db.get<{ id: string }>('SELECT id FROM shifts')!).id), kes(40));
  const c = mk({ pricing: { ...basePricing, remainderPolicy: 'REJECT' } }); openShift(c.ctx, c.att, 0);
  assert.throws(() => sale(c.ctx, c.att, c.tableId, 50, 'x'), (e: any) => e.code === 'REMAINDER_NOT_ALLOWED');
  assert.equal(sale(c.ctx, c.att, c.tableId, 60, 'y').receiptNo, 'C-000001');
  for (const x of [a, b, c]) assert.deepEqual(verifyLedger(x.ctx.db), []);
});
test('cash: duplicate sale (same idempotency key) returns the original receipt, no extra credits', () => {
  const { ctx, att, tableId } = mk(); openShift(ctx, att, 0);
  const a = sale(ctx, att, tableId, 100, 'tap'); const b = sale(ctx, att, tableId, 100, 'tap');
  assert.deepEqual([b.duplicate, b.receiptNo === a.receiptNo, credits(ctx, tableId)], [true, true, 5]);
});
test('cash: receipt numbers are sequential with no gaps across sales, failures and voids', () => {
  const { ctx, att, tableId } = mk({ pricing: { ...basePricing, remainderPolicy: 'REJECT' } }); openShift(ctx, att, 0);
  const nos: string[] = [];
  for (let i = 0; i < 6; i++) { try { nos.push(sale(ctx, att, tableId, i % 2 ? 25 : 20, `k${i}`).receiptNo); } catch { /* rejected sale */ } }
  assert.deepEqual(nos, ['C-000001', 'C-000002', 'C-000003']);
  assert.deepEqual(receiptGaps(ctx), []);
  ctx.db.raw.exec('PRAGMA foreign_keys=OFF'); ctx.db.run("DELETE FROM cash_sales WHERE receipt_seq=2");
  assert.deepEqual(receiptGaps(ctx), [2]);
});
test('cash: discounts need a reason and respect limits; above the limit needs a different manager', () => {
  const { ctx, att, mgr, tableId } = mk(); openShift(ctx, att, 0);
  assert.throws(() => sale(ctx, att, tableId, 75, 'd1', { discountMinor: kes(25) }), (e: any) => e.code === 'REASON_REQUIRED');
  assert.throws(() => sale(ctx, att, tableId, 75, 'd1', { discountMinor: kes(25), discountReason: 'regular' }), (e: any) => e.code === 'APPROVAL_REQUIRED');
  assert.throws(() => sale(ctx, att, tableId, 75, 'd1', { discountMinor: kes(25), discountReason: 'regular', approvedBy: att }), (e: any) => e.code === 'APPROVAL_INVALID');
  const r = sale(ctx, att, tableId, 75, 'd1', { discountMinor: kes(25), discountReason: 'regular', approvedBy: mgr });
  assert.equal(r.games, 5); assert.equal(balance(ctx.db, A.cash), kes(75)); assert.equal(balance(ctx.db, A.discounts), kes(25)); assert.equal(balance(ctx.db, A.revenue(tableId)), -kes(100));
  const small = sale(ctx, att, tableId, 18, 'd2', { discountMinor: kes(2), discountReason: 'rounding' }); assert.equal(small.games, 1);
  assert.deepEqual(verifyLedger(ctx.db), []);
});
test('cash: void needs reason, own sale, open shift, unvended games, and approval above the attendant limit', () => {
  const { ctx, att, mgr, tableId } = mk(); const other = addUser(ctx, 'attendant', { id: 'att2' });
  openShift(ctx, att, 0); openShift(ctx, other, 0);
  const small = sale(ctx, att, tableId, 20, 's'); const big = sale(ctx, att, tableId, 100, 'b');
  assert.throws(() => voidCashSale(ctx, { saleId: small.saleId, actorId: att, reason: '' }), (e: any) => e.code === 'REASON_REQUIRED');
  assert.throws(() => voidCashSale(ctx, { saleId: small.saleId, actorId: other, reason: 'x' }), (e: any) => e.code === 'FORBIDDEN');
  assert.deepEqual(voidCashSale(ctx, { saleId: small.saleId, actorId: att, reason: 'wrong table' }), { refundCashMinor: kes(20) });
  assert.throws(() => voidCashSale(ctx, { saleId: small.saleId, actorId: att, reason: 'again' }), (e: any) => e.code === 'ALREADY_VOIDED');
  ctx.db.run('UPDATE users SET void_limit_minor=? WHERE id=?', kes(50), att);
  assert.throws(() => voidCashSale(ctx, { saleId: big.saleId, actorId: att, reason: 'customer left' }), (e: any) => e.code === 'APPROVAL_REQUIRED');
  voidCashSale(ctx, { saleId: big.saleId, actorId: att, reason: 'customer left', approvedBy: mgr });
  assert.equal(credits(ctx, tableId), 0); assert.equal(balance(ctx.db, A.cash), 0); assert.equal(balance(ctx.db, A.revenue(tableId)), 0);
  assert.deepEqual(verifyLedger(ctx.db), []);
  const used = sale(ctx, att, tableId, 20, 'u'); dispatch(ctx, tableId);
  assert.throws(() => voidCashSale(ctx, { saleId: used.saleId, actorId: att, reason: 'x' }), (e: any) => e.code === 'GAMES_ALREADY_USED');
});
test('failed vend: manager refund keeps the ledger balanced and the refund shows in attendant refund stats', async () => {
  const { ctx, att, mgr, tableId } = mk({ maxVendAttempts: 1, vendTimeoutMs: 1000 }); openShift(ctx, att, 0); sale(ctx, att, tableId, 20, 'f');
  dispatch(ctx, tableId); ctx.clock.ms += 1_001;
  const { sweep } = await import('../src/core/vend.ts'); const sw = sweep(ctx); assert.equal(sw.failed.length, 1);
  resolveFailed(ctx, sw.failed[0], 'REFUND', att, 'balls jammed');
  assert.deepEqual(verifyLedger(ctx.db), []); assert.equal(balance(ctx.db, A.refundDue), -kes(20));
  const { from, to } = periodRange('today', ctx.now()); assert.equal(attendantStats(ctx, att, from, to, true).refunds.count, 1);
});
test('shift close: expected vs counted, variance saved and flagged above threshold; closed shifts immutable', () => {
  const { ctx, att, mgr, owner, tableId } = mk(); const { shiftId } = openShift(ctx, att, kes(500));
  sale(ctx, att, tableId, 100, 'a'); sale(ctx, att, tableId, 40, 'b');
  assert.equal(expectedCash(ctx, shiftId), kes(640));
  assert.throws(() => closeShift(ctx, { shiftId, actorId: addUser(ctx, 'attendant', { id: 'x2' }), countedMinor: 1 }), (e: any) => e.code === 'FORBIDDEN');
  const r = closeShift(ctx, { shiftId, actorId: att, countedMinor: kes(630) });
  assert.deepEqual(r, { expectedMinor: kes(640), countedMinor: kes(630), varianceMinor: -kes(10), flagged: false });
  assert.throws(() => closeShift(ctx, { shiftId, actorId: att, countedMinor: 1 }), (e: any) => e.code === 'SHIFT_CLOSED');
  assert.throws(() => ctx.db.run('UPDATE shifts SET counted_minor=999999 WHERE id=?', shiftId), /immutable/);
  assert.throws(() => ctx.db.run('DELETE FROM shifts WHERE id=?', shiftId), /cannot be deleted/);
  assert.throws(() => sale(ctx, att, tableId, 20, 'late'), (e: any) => e.code === 'NO_OPEN_SHIFT');
  assert.throws(() => adjustClosedShift(ctx, { shiftId, ownerId: mgr, amountMinor: kes(10), reason: 'found cash' }), (e: any) => e.code === 'FORBIDDEN');
  assert.throws(() => adjustClosedShift(ctx, { shiftId, ownerId: owner, amountMinor: kes(10), reason: '' }), (e: any) => e.code === 'REASON_REQUIRED');
  adjustClosedShift(ctx, { shiftId, ownerId: owner, amountMinor: kes(10), reason: 'cash found in drawer' });
  assert.equal(ctx.db.get<{ variance_minor: number }>('SELECT variance_minor FROM shifts')!.variance_minor, -kes(10)); // original untouched
  const s2 = openShift(ctx, att, 0).shiftId; sale(ctx, att, tableId, 20, 'c');
  const bad = closeShift(ctx, { shiftId: s2, actorId: att, countedMinor: 0 });
  assert.deepEqual([bad.varianceMinor, bad.flagged], [-kes(20), false]); // KES 20 < default KES 50 threshold
  const s3 = openShift(ctx, att, 0).shiftId; sale(ctx, att, tableId, 100, 'd');
  assert.equal(closeShift(ctx, { shiftId: s3, actorId: att, countedMinor: kes(30) }).flagged, true);
  assert.equal(ctx.db.all("SELECT 1 FROM alerts WHERE kind='SHIFT_VARIANCE'").length, 1);
});
test('cash: offline queue is off by default, capped when on, and idempotent on sync', () => {
  const { ctx, att, tableId } = mk(); openShift(ctx, att, 0);
  assert.throws(() => sale(ctx, att, tableId, 20, 'o1', { offline: true }), (e: any) => e.code === 'OFFLINE_DISABLED');
  setSetting(ctx, 'cash.offline_enabled', '1'); setSetting(ctx, 'cash.offline_max_minor', String(kes(60)));
  assert.throws(() => sale(ctx, att, tableId, 100, 'o2', { offline: true }), (e: any) => e.code === 'OFFLINE_CAP');
  const a = sale(ctx, att, tableId, 40, 'o3', { offline: true }), b = sale(ctx, att, tableId, 40, 'o3', { offline: true });
  assert.deepEqual([a.duplicate, b.duplicate, credits(ctx, tableId)], [false, true, 2]);
});

// ---------- vouchers ----------
test('vouchers: codes stored hashed, single use, table-restricted, voidable, normalised input', () => {
  const { ctx, tableId } = mk(); const t2 = makeTable(ctx, { name: 'T2' }).tableId;
  const { codes, batchId } = createVoucherBatch(ctx, { count: 4, games: 3, tableId, actor: 'own1' });
  assert.equal(new Set(codes).size, 4); assert.match(codes[0], /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(ctx.db.all(`SELECT 1 FROM vouchers WHERE code_hash LIKE '%${codes[0].slice(0, 5)}%'`).length, 0);
  assert.throws(() => redeemVoucher(ctx, { code: codes[0], tableId: t2, ip: '1' }), (e: any) => e.code === 'WRONG_TABLE');
  assert.equal(redeemVoucher(ctx, { code: codes[0].toLowerCase().replace('-', ' '), tableId, ip: '1' }).games, 3);
  assert.equal(credits(ctx, tableId), 3);
  assert.throws(() => redeemVoucher(ctx, { code: codes[0], tableId, ip: '1' }), (e: any) => e.code === 'USED');
  assert.throws(() => redeemVoucher(ctx, { code: 'AAAAA-AAAAA', tableId, ip: '1' }), (e: any) => e.code === 'INVALID');
  assert.equal(voidVoucherBatch(ctx, batchId, 'own1'), 3);
  assert.throws(() => redeemVoucher(ctx, { code: codes[1], tableId, ip: '1' }), (e: any) => e.code === 'VOID');
  assert.deepEqual(verifyLedger(ctx.db), []);
});
test('vouchers: guessing is rate limited per IP', () => {
  const { ctx, tableId } = mk();
  for (let i = 0; i < 10; i++) assert.throws(() => redeemVoucher(ctx, { code: 'AAAAA-AAAA' + i, tableId, ip: '6.6.6.6' }), (e: any) => e.code === 'INVALID');
  assert.throws(() => redeemVoucher(ctx, { code: 'AAAAA-AAAAZ', tableId, ip: '6.6.6.6' }), (e: any) => e.code === 'RATE_LIMITED');
});

// ---------- analytics ----------
test('analytics: attendant stats (by method/table/hour, voids, variances), money hidden when not permitted, own-data scoping', () => {
  const { ctx, att, tableId } = mk(); const other = addUser(ctx, 'attendant', { id: 'att2' });
  const t2 = makeTable(ctx, { name: 'Table 2' }).tableId;
  const { shiftId } = openShift(ctx, att, 0); openShift(ctx, other, 0);
  sale(ctx, att, tableId, 100, 'a'); ctx.clock.ms += 3_600_000; sale(ctx, att, t2, 40, 'b'); const v = sale(ctx, att, t2, 20, 'c');
  voidCashSale(ctx, { saleId: v.saleId, actorId: att, reason: 'mistake' });
  sale(ctx, other, tableId, 200, 'z'); // someone else's sale must never appear
  closeShift(ctx, { shiftId, actorId: att, countedMinor: kes(130) });
  const { from, to } = periodRange('today', ctx.now());
  const s = attendantStats(ctx, att, from, to, true);
  assert.deepEqual([s.salesCount, s.gamesSold, s.totalMinor, s.averageSaleMinor], [2, 7, kes(140), kes(70)]);
  assert.deepEqual(s.byMethod.CASH, { sales: 2, games: 7, totalMinor: kes(140) });
  assert.deepEqual(s.voids, { count: 1, amountMinor: kes(20) });
  assert.deepEqual(s.byHour.map((h) => [h.hour, h.sales]), [[12, 1], [13, 1]]);
  assert.deepEqual(s.byTable.map((t) => [t.name, t.games]).sort(), [['Table 1', 5], ['Table 2', 2]]);
  assert.deepEqual(s.variances, [{ shiftId, varianceMinor: -kes(10), flagged: false }]);
  const hidden = attendantStats(ctx, att, from, to, false);
  assert.equal(hidden.totalMinor, null); assert.equal(hidden.byMethod.CASH.totalMinor, null); assert.equal(hidden.gamesSold, 7); assert.equal(hidden.variances[0].varianceMinor, null);
  assert.equal(attendantStats(ctx, other, from, to, true).totalMinor, kes(200));
});
test('analytics: period ranges (Nairobi midnight, Monday weeks) and owner summary', () => {
  const now = new Date('2026-10-21T22:30:00Z'); // Thu 22 Oct 01:30 Nairobi
  assert.deepEqual(periodRange('today', now), { from: '2026-10-21T21:00:00.000Z', to: '2026-10-22T21:00:00.000Z' });
  assert.deepEqual(periodRange('yesterday', now), { from: '2026-10-20T21:00:00.000Z', to: '2026-10-21T21:00:00.000Z' });
  assert.equal(periodRange('week', now).from, '2026-10-18T21:00:00.000Z'); // Monday 19 Oct 00:00 EAT
  assert.equal(periodRange('month', now).from, '2026-09-30T21:00:00.000Z');
  const { ctx, att, tableId } = mk(); openShift(ctx, att, 0); sale(ctx, att, tableId, 100, 'a');
  const [d] = dispatch(ctx, tableId); const sec = decryptSecret(ctx.db.get<{ s: string }>('SELECT device_secret_enc s FROM pool_tables')!.s, ctx.masterKey);
  const a = { vendId: d.vendId, nonce: d.command.nonce, status: 'ACK' as const, ts: 1 }; handleAck(ctx, { ...a, signature: signAck(a, sec) });
  const sum = ownerSummary(ctx, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z');
  assert.deepEqual([sum.poolRevenueMinor, sum.gamesSold, sum.gamesPlayed, sum.vendFailures], [kes(100), 5, 1, 0]);
  assert.equal(sum.byMethod.CASH.totalMinor, kes(100)); assert.equal(sum.byTable[0].gamesPlayed, 1);
});
test('csv export escapes quotes/commas and neutralises spreadsheet formulas', () => {
  assert.equal(toCsv([{ a: 'x,y', b: '=HYPERLINK("evil")', c: 'say "hi"' }]), 'a,b,c\n"x,y","\'=HYPERLINK(""evil"")","say ""hi"""\n');
});

// ---------- concurrency ----------
async function storm(path: string, op: string, workers: number, per: number, extra: Record<string, unknown>): Promise<unknown[]> {
  const flag = new SharedArrayBuffer(4);
  const ps = Array.from({ length: workers }, (_, w) => new Promise<unknown[]>((res, rej) => { const wk = new Worker(new URL('./helpers/worker.ts', import.meta.url), { workerData: { path, op, n: per, startFlag: flag, worker: w, ...extra } }); wk.once('message', res); wk.once('error', rej); }));
  await new Promise((r) => setTimeout(r, 400)); Atomics.store(new Int32Array(flag), 0, 1); Atomics.notify(new Int32Array(flag), 0);
  return (await Promise.all(ps)).flat();
}
test('concurrency: 10 parallel redemptions of one voucher => exactly one success', async () => {
  const { ctx, tableId } = mk(); const { codes } = createVoucherBatch(ctx, { count: 1, games: 4, actor: 'o' });
  const res = await storm(ctx.path, 'voucher', 10, 5, { tableId, code: codes[0] });
  assert.equal(res.filter((r) => r === 'OK').length, 1); assert.equal(res.filter((r) => r === 'USED').length, 49);
  assert.equal(credits(ctx, tableId), 4); assert.deepEqual(verifyLedger(ctx.db), []);
});
test('concurrency: parallel duplicate cash sales (double tap on Confirm) create exactly one sale', async () => {
  const { ctx, att, tableId } = mk(); openShift(ctx, att, 0);
  const res = await storm(ctx.path, 'cash-sale', 8, 5, { tableId, attendantId: att, amountMinor: kes(100) });
  assert.equal(res.filter((r) => r === 'NEW').length, 1); assert.equal(res.filter((r) => r === 'DUP').length, 39);
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM cash_sales')!.n, 1); assert.equal(credits(ctx, tableId), 5); assert.deepEqual(receiptGaps(ctx), []);
});
test('concurrency: 20 parallel duplicate STK callbacks across connections credit exactly once (KES 100 = 5 games)', async () => {
  const { ctx, tableId } = mk();
  ctx.db.run(`INSERT INTO mpesa_requests(id,idempotency_key,table_id,games,amount_minor,phone_hash,phone_enc,status,checkout_request_id,created_at,expires_at_ms)
    VALUES ('r1','k',?,5,?, 'h', ?, 'PENDING','ws_CO_1',?,?)`, tableId, kes(100), (await import('../src/core/crypto.ts')).encryptSecret('254712345678', ctx.masterKey), ctx.now().toISOString(), ctx.clock.ms + 90000);
  const body = { Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: 100 }, { Name: 'MpesaReceiptNumber', Value: 'PARALLEL01X' }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } };
  const res = await storm(ctx.path, 'stk-callback', 4, 5, { body });
  assert.equal(res.filter((r) => r === 'CREDITED').length, 1); assert.equal(res.filter((r) => r === 'DUPLICATE').length, 19);
  assert.equal(credits(ctx, tableId), 5); assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM payments')!.n, 1); assert.deepEqual(verifyLedger(ctx.db), []);
});
