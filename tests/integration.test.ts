import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newCtx, makeTable, basePricing } from './helpers/ctx.ts';
import { A, balance, postTxn, verifyLedger, LedgerError } from '../src/core/ledger.ts';
import { appendAudit, verifyAuditChain } from '../src/core/audit.ts';
import { idempotent, hashRequest, IdempotencyConflictError } from '../src/core/idempotency.ts';
import { creditPurchase, availableGames, CreditError } from '../src/core/credit.ts';
import { dispatch, handleAck, sweep, onDeviceReconnect, resolveFailed, reportReady, setOffline, VendError } from '../src/core/vend.ts';
import { signAck, verifyCommand, MemoryReplayStore } from '../src/core/command.ts';
import { decryptSecret } from '../src/core/crypto.ts';
import { IllegalTransitionError } from '../src/core/vend-state.ts';
import { kes } from '../src/core/money.ts';
import type { TestCtx } from './helpers/ctx.ts';

const at = (c: TestCtx) => c.now().toISOString();
const pay = (c: TestCtx, tableId: string, ref: string, amountKes: number, extra: Record<string, unknown> = {}) =>
  creditPurchase(c, { source: 'MPESA_STK', idempotencyKey: 'k-' + ref, externalRef: ref, tableId, amountMinor: kes(amountKes), actor: 'test', ...extra });
const states = (c: TestCtx, t: string) => c.db.all<{ state: string }>('SELECT state FROM vends WHERE table_id=? ORDER BY seq', t).map((r) => r.state);
const secretOf = (c: TestCtx, t: string) => decryptSecret(c.db.get<{ s: string }>('SELECT device_secret_enc AS s FROM pool_tables WHERE id=?', t)!.s, c.masterKey);
const ack = (c: TestCtx, d: { vendId: string; command: { nonce: string } }, t: string, status: 'ACK' | 'REJECT' | 'CONFIRMED' = 'ACK') => {
  const a = { vendId: d.vendId, nonce: d.command.nonce, status, ts: c.clock.ms };
  return handleAck(c, { ...a, signature: signAck(a, secretOf(c, t)) });
};

test('ledger: balanced posting works; unbalanced, single-entry, zero and float rejected; immutable', () => {
  const c = newCtx();
  const ok = (entries: any[]) => c.db.tx(() => postTxn(c.db, { txnId: randomUUID(), refType: 'x', refId: 'x', entries, at: at(c) }));
  ok([{ account: 'asset:cash', unit: 'KES', amount: 100 }, { account: 'revenue:x', unit: 'KES', amount: -100 }]);
  assert.equal(balance(c.db, 'asset:cash'), 100);
  assert.throws(() => ok([{ account: 'a', unit: 'KES', amount: 100 }, { account: 'b', unit: 'KES', amount: -99 }]), LedgerError);
  assert.throws(() => ok([{ account: 'a', unit: 'KES', amount: 1 }, { account: 'b', unit: 'GAME', amount: -1 }]), LedgerError);
  assert.throws(() => ok([{ account: 'a', unit: 'KES', amount: 0 }, { account: 'b', unit: 'KES', amount: 0 }]), LedgerError);
  assert.throws(() => ok([{ account: 'a', unit: 'KES', amount: 1.5 }, { account: 'b', unit: 'KES', amount: -1.5 }]), LedgerError);
  assert.throws(() => ok([{ account: 'a', unit: 'KES', amount: 1 }]), LedgerError);
  assert.throws(() => postTxn(c.db, { txnId: 'x', refType: 'x', refId: 'x', entries: [], at: at(c) }), LedgerError); // outside tx
  assert.throws(() => c.db.run('UPDATE ledger_entries SET amount=5'), /immutable/);
  assert.throws(() => c.db.run('DELETE FROM ledger_entries'), /immutable/);
  assert.equal(balance(c.db, 'asset:cash'), 100);
  assert.deepEqual(verifyLedger(c.db), []);
});
test('ledger: balances that must not go negative are guarded and the posting rolls back', () => {
  const c = newCtx();
  assert.throws(() => c.db.tx(() => postTxn(c.db, { txnId: 'z', refType: 'x', refId: 'x', at: at(c),
    entries: [{ account: A.gamesAvail('t'), unit: 'GAME', amount: -1 }, { account: A.gamesVended('t'), unit: 'GAME', amount: 1 }] })), /balance rule/);
  assert.equal(c.db.get<{ n: number }>('SELECT COUNT(*) n FROM ledger_entries')!.n, 0);
});

test('audit: chain verifies, UPDATE/DELETE blocked, tampering and deletion detected', () => {
  const c = newCtx();
  for (let i = 0; i < 5; i++) c.db.tx(() => appendAudit(c.db, c.now(), { actor: 'a', action: 'x', entityType: 'e', entityId: String(i), data: { i } }));
  assert.deepEqual(verifyAuditChain(c.db), { ok: true, count: 5 });
  assert.throws(() => appendAudit(c.db, c.now(), { actor: 'a', action: 'x', entityType: 'e', entityId: '1' }), /transaction/);
  assert.throws(() => c.db.run("UPDATE audit_log SET actor='evil' WHERE seq=2"), /append-only/);
  assert.throws(() => c.db.run('DELETE FROM audit_log WHERE seq=2'), /append-only/);
  // Simulate an attacker with raw file access who drops the trigger.
  c.db.raw.exec('DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;');
  c.db.run("UPDATE audit_log SET data_json='{\"i\":99}' WHERE seq=3");
  assert.deepEqual(verifyAuditChain(c.db), { ok: false, brokenAtSeq: 3, reason: 'row content altered' });
  const c2 = newCtx();
  for (let i = 0; i < 4; i++) c2.db.tx(() => appendAudit(c2.db, c2.now(), { actor: 'a', action: 'x', entityType: 'e', entityId: String(i) }));
  c2.db.raw.exec('DROP TRIGGER audit_no_delete;'); c2.db.run('DELETE FROM audit_log WHERE seq=2');
  assert.deepEqual(verifyAuditChain(c2.db), { ok: false, brokenAtSeq: 3, reason: 'sequence gap (row deleted?)' });
});

test('idempotency: runs once, replays stored result, rejects key reuse with different body, rolls back on failure', () => {
  const c = newCtx(); let runs = 0;
  const h = hashRequest({ a: 1, b: [1, 2] });
  assert.equal(hashRequest({ b: [1, 2], a: 1 }), h);
  const first = idempotent(c.db, c.now(), 's', 'k1', h, () => { runs++; return { n: 42 }; });
  const second = idempotent(c.db, c.now(), 's', 'k1', h, () => { runs++; return { n: 43 }; });
  assert.deepEqual([first, second], [{ replayed: false, result: { n: 42 } }, { replayed: true, result: { n: 42 } }]);
  assert.equal(runs, 1);
  assert.throws(() => idempotent(c.db, c.now(), 's', 'k1', hashRequest({ x: 1 }), () => 1), IdempotencyConflictError);
  assert.throws(() => idempotent(c.db, c.now(), 's', 'k2', h, () => { throw new Error('boom'); }), /boom/);
  assert.equal(idempotent(c.db, c.now(), 's', 'k2', h, () => 7).replayed, false); // key was not consumed by the failure
  assert.equal(idempotent(c.db, c.now(), 'other-scope', 'k1', h, () => 8).replayed, false);
});

test('credit: KES 100 = exactly 5 game credits, ledger balanced, revenue recorded', () => {
  const c = newCtx(); const { tableId } = makeTable(c);
  const r = pay(c, tableId, 'RCP001', 100);
  assert.ok(r.status === 'CREDITED' && r.games === 5 && r.remainderMinor === 0 && !r.duplicate);
  assert.equal(availableGames(c, tableId), 5);
  assert.equal(balance(c.db, A.mpesa), kes(100));
  assert.equal(balance(c.db, A.revenue(tableId)), -kes(100));
  assert.equal(balance(c.db, A.gamesIssued), -5);
  assert.deepEqual(verifyLedger(c.db), []);
  assert.equal(verifyAuditChain(c.db).ok, true);
});
test('credit: duplicate receipt or key never credits twice; mismatched reuse is an error', () => {
  const c = newCtx(); const { tableId } = makeTable(c); const t2 = makeTable(c, { name: 'T2' }).tableId;
  pay(c, tableId, 'RCP002', 100);
  const dup = pay(c, tableId, 'RCP002', 100);
  const dupKey = creditPurchase(c, { source: 'MPESA_C2B', idempotencyKey: 'k-RCP002', externalRef: 'OTHER', tableId, amountMinor: kes(100), actor: 't' });
  assert.ok(dup.status === 'CREDITED' && dup.duplicate && dupKey.status === 'CREDITED' && dupKey.duplicate);
  assert.equal(availableGames(c, tableId), 5);
  assert.throws(() => pay(c, tableId, 'RCP002', 200), (e: any) => e instanceof CreditError && e.code === 'DUPLICATE_MISMATCH');
  assert.throws(() => pay(c, t2, 'RCP002', 100), (e: any) => e.code === 'DUPLICATE_MISMATCH');
  assert.throws(() => pay(c, 'nope', 'R9', 20), (e: any) => e.code === 'UNKNOWN_TABLE');
  assert.throws(() => pay(c, tableId, 'R10', 0), CreditError);
  assert.equal(c.db.get<{ n: number }>('SELECT COUNT(*) n FROM payments')!.n, 1);
});
test('credit: same receipt number in different namespaces (cash vs M-Pesa) is allowed', () => {
  const c = newCtx(); const { tableId } = makeTable(c);
  pay(c, tableId, 'X1', 20);
  const r = creditPurchase(c, { source: 'CASH', idempotencyKey: 'cash-1', externalRef: 'X1', tableId, amountMinor: kes(20), actor: 'att' });
  assert.ok(r.status === 'CREDITED' && !r.duplicate);
  assert.equal(availableGames(c, tableId), 2);
  assert.equal(balance(c.db, A.cash), kes(20));
});
test('credit: remainder HOLD_CREDIT holds, and held credit is applied to the next payment', () => {
  const c = newCtx(); const { tableId } = makeTable(c);
  const r1 = pay(c, tableId, 'R1', 50, { source: 'MPESA_C2B', ownerRef: 'phoneHash1' });
  assert.ok(r1.status === 'CREDITED' && r1.games === 2 && r1.remainderMinor === kes(10) && r1.remainderAction === 'HELD');
  assert.equal(balance(c.db, A.wallet(tableId, 'phoneHash1')), -kes(10));
  const r2 = pay(c, tableId, 'R2', 10, { source: 'MPESA_C2B', ownerRef: 'phoneHash1' });
  assert.ok(r2.status === 'CREDITED' && r2.games === 1 && r2.walletUsedMinor === kes(10) && r2.remainderMinor === 0);
  assert.equal(balance(c.db, A.wallet(tableId, 'phoneHash1')), 0);
  const other = pay(c, tableId, 'R3', 10, { source: 'MPESA_C2B', ownerRef: 'someoneElse' });
  assert.ok(other.status === 'CREDITED' && other.games === 0 && other.remainderAction === 'HELD'); // other owner cannot use it
  assert.deepEqual(verifyLedger(c.db), []);
});
test('credit: remainder REFUND books refund-due; REJECT writes nothing but an audit entry', () => {
  const c = newCtx(); const refund = makeTable(c, { name: 'R', pricing: { ...basePricing, remainderPolicy: 'REFUND' } }).tableId;
  const rej = makeTable(c, { name: 'J', pricing: { ...basePricing, remainderPolicy: 'REJECT' } }).tableId;
  const r = pay(c, refund, 'RF1', 50, { source: 'MPESA_C2B' });
  assert.ok(r.status === 'CREDITED' && r.games === 2 && r.remainderAction === 'REFUND_DUE');
  assert.equal(balance(c.db, A.refundDue), -kes(10));
  const j = pay(c, rej, 'RJ1', 50, { source: 'MPESA_C2B' });
  assert.deepEqual(j, { status: 'REJECTED', reason: 'REMAINDER_NOT_ALLOWED', remainderMinor: kes(10) });
  assert.equal(availableGames(c, rej), 0);
  assert.equal(c.db.get('SELECT 1 FROM payments WHERE external_ref=?', 'RJ1'), undefined);
  assert.equal(pay(c, rej, 'RJ2', 40, { source: 'MPESA_C2B' }).status, 'CREDITED'); // exact multiple passes
  assert.deepEqual(verifyLedger(c.db), []);
});
test('credit: STK flow with exact games; underpayment rejected; bundle pricing applies', () => {
  const c = newCtx(); const { tableId } = makeTable(c, { pricing: { ...basePricing, bundles: [{ games: 6, priceMinor: kes(100) }] } });
  const r = pay(c, tableId, 'S1', 100, { gamesRequested: 6 });
  assert.ok(r.status === 'CREDITED' && r.games === 6 && r.chargedMinor === kes(100));
  assert.deepEqual(pay(c, tableId, 'S2', 80, { gamesRequested: 5 }), { status: 'REJECTED', reason: 'INSUFFICIENT_AMOUNT', remainderMinor: 0 });
  assert.equal(availableGames(c, tableId), 6);
  const over = pay(c, tableId, 'S3', 100, { gamesRequested: 1, ownerRef: 'p' });
  assert.ok(over.status === 'CREDITED' && over.games === 1 && over.remainderMinor === kes(80) && over.remainderAction === 'HELD');
});

test('vend: happy path ONE mode, signed command verifies with device secret, ack confirms, ledger consistent', () => {
  const c = newCtx(); const { tableId } = makeTable(c, { vendMode: 'COIN_PULSE', vendParams: { pulses: 2, pulseMs: 60, gapMs: 70 } });
  pay(c, tableId, 'V1', 60);
  const [d, ...rest] = dispatch(c, tableId); assert.equal(rest.length, 0);
  assert.equal(verifyCommand(d.command, d.signature, secretOf(c, tableId), c.clock.ms, new MemoryReplayStore()).ok, true);
  assert.equal(d.command.mode, 'COIN_PULSE'); assert.equal(d.command.pulses, 2);
  assert.deepEqual(dispatch(c, tableId), []); // one in flight; nothing more released
  assert.equal(availableGames(c, tableId), 2);
  assert.deepEqual(ack(c, d, tableId), { ok: true, state: 'CONFIRMED', duplicate: false });
  assert.deepEqual(ack(c, d, tableId), { ok: true, state: 'CONFIRMED', duplicate: true }); // duplicate ack is a no-op
  assert.equal(balance(c.db, A.gamesVended(tableId)), 1);
  assert.equal(dispatch(c, tableId).length, 1);
  assert.deepEqual(states(c, tableId), ['CONFIRMED', 'SENT']);
  assert.deepEqual(verifyLedger(c.db), []);
});
test('vend: queue ordering is FIFO by seq; ALL mode releases everything at once', () => {
  const c = newCtx(); const one = makeTable(c, { name: 'one' }).tableId; const all = makeTable(c, { name: 'all', releaseMode: 'ALL' }).tableId;
  pay(c, one, 'Q1', 60); pay(c, all, 'Q2', 100);
  const seqs: number[] = [];
  for (let i = 0; i < 3; i++) { const [d] = dispatch(c, one); seqs.push(c.db.get<{ seq: number }>('SELECT seq FROM vends WHERE id=?', d.vendId)!.seq); ack(c, d, one); }
  assert.deepEqual(seqs, [1, 2, 3]); assert.deepEqual(dispatch(c, one), []);
  assert.equal(dispatch(c, all).length, 5); assert.deepEqual(dispatch(c, all), []);
  assert.equal(balance(c.db, A.gamesInflight(all)), 5);
});
test('vend: bad signature, unknown nonce rejected; illegal transitions rejected', () => {
  const c = newCtx(); const { tableId } = makeTable(c); pay(c, tableId, 'B1', 20);
  const [d] = dispatch(c, tableId);
  const a = { vendId: d.vendId, nonce: d.command.nonce, status: 'ACK' as const, ts: 1 };
  assert.deepEqual(handleAck(c, { ...a, signature: signAck(a, 'wrong-secret') }), { ok: false, reason: 'BAD_SIGNATURE' });
  const b = { ...a, nonce: 'f'.repeat(32) };
  assert.deepEqual(handleAck(c, { ...b, signature: signAck(b, secretOf(c, tableId)) }), { ok: false, reason: 'UNKNOWN_NONCE' });
  assert.deepEqual(states(c, tableId), ['SENT']);
  ack(c, d, tableId);
  assert.throws(() => resolveFailed(c, d.vendId, 'REFUND', 'm', 'x'), IllegalTransitionError); // confirmed vend cannot be refunded
  assert.throws(() => resolveFailed(c, d.vendId, 'REFUND', 'm', ' '), VendError);
});
test('vend: sensor-confirm tables wait for CONFIRMED; ready gating releases next credit only when ready', () => {
  const c = newCtx(); const { tableId } = makeTable(c, { confirmBySensor: true, requiresReadySensor: true });
  pay(c, tableId, 'G1', 40);
  const [d] = dispatch(c, tableId);
  assert.equal(c.db.get<{ ready: number }>('SELECT ready FROM pool_tables WHERE id=?', tableId)!.ready, 0);
  assert.equal(ack(c, d, tableId).ok && (ack(c, d, tableId) as any).state, 'ACKED');
  assert.deepEqual(ack(c, d, tableId, 'CONFIRMED'), { ok: true, state: 'CONFIRMED', duplicate: false });
  assert.deepEqual(dispatch(c, tableId), []); // table not ready yet (previous game still in progress)
  assert.equal(reportReady(c, tableId, false).length, 0);
  assert.equal(reportReady(c, tableId, true).length, 1); // balls captured -> next game released
});
test('vend: offline table stores credits, releases on reconnect, nothing lost', () => {
  const c = newCtx(); const { tableId } = makeTable(c); setOffline(c, tableId);
  pay(c, tableId, 'O1', 60);
  assert.deepEqual(dispatch(c, tableId), []);
  assert.equal(availableGames(c, tableId), 3);
  const cmds = onDeviceReconnect(c, tableId);
  assert.equal(cmds.length, 1); assert.equal(availableGames(c, tableId), 2);
});
test('vend: power loss mid-vend. Reconnect re-issues the SAME vend id with a new nonce, never a second vend', () => {
  const c = newCtx(); const { tableId } = makeTable(c); pay(c, tableId, 'P1', 40);
  const [d1] = dispatch(c, tableId);
  setOffline(c, tableId);
  c.clock.ms += 120_000;
  assert.deepEqual(sweep(c), { resent: [], failed: [] }); // offline: attempts are not burned
  const [d2, ...extra] = onDeviceReconnect(c, tableId);
  assert.equal(extra.length, 0); assert.equal(d2.vendId, d1.vendId); assert.notEqual(d2.command.nonce, d1.command.nonce);
  assert.deepEqual(states(c, tableId), ['SENT']);
  assert.equal(c.db.get<{ attempts: number }>('SELECT attempts FROM vends')!.attempts, 1);
  assert.equal(availableGames(c, tableId), 1);
  assert.equal(ack(c, d1, tableId).ok, true); // late ack for the old nonce is still honoured
  assert.deepEqual(states(c, tableId), ['CONFIRMED']);
});
test('vend: timeout retries then FAILED with alert, table FAULTED, next game blocked', () => {
  const c = newCtx(); const { tableId } = makeTable(c, { maxVendAttempts: 3, vendTimeoutMs: 5000 }); pay(c, tableId, 'T1', 40);
  dispatch(c, tableId);
  assert.deepEqual(sweep(c), { resent: [], failed: [] }); // not yet timed out
  const vendId = c.db.get<{ id: string }>('SELECT id FROM vends')!.id;
  for (const n of [2, 3]) { c.clock.ms += 5_001; const r = sweep(c); assert.equal(r.resent.length, 1); assert.equal(r.resent[0].vendId, vendId); assert.equal(c.db.get<{ a: number }>('SELECT attempts a FROM vends')!.a, n); }
  c.clock.ms += 5_001;
  assert.deepEqual(sweep(c), { resent: [], failed: [vendId] });
  assert.deepEqual(states(c, tableId), ['FAILED']);
  assert.equal(c.db.get<{ status: string }>('SELECT status FROM pool_tables')!.status, 'FAULTED');
  assert.equal(c.db.all('SELECT * FROM alerts WHERE kind=\'VEND_FAILED\'').length, 1);
  assert.deepEqual(dispatch(c, tableId), []);
});
test('vend: FAILED then RETRY / KEEP_CREDIT / REFUND all keep ledger balanced and never create extra vends', () => {
  for (const action of ['RETRY', 'KEEP_CREDIT', 'REFUND'] as const) {
    const c = newCtx(); const { tableId } = makeTable(c, { maxVendAttempts: 1, vendTimeoutMs: 1000 }); pay(c, tableId, 'F' + action, 20);
    dispatch(c, tableId); c.clock.ms += 1_001; sweep(c);
    const vendId = c.db.get<{ id: string }>('SELECT id FROM vends')!.id;
    const out = resolveFailed(c, vendId, action, 'mgr', 'customer complained');
    assert.deepEqual(verifyLedger(c.db), [], action);
    assert.equal(c.db.get<{ status: string }>('SELECT status FROM pool_tables')!.status, 'ACTIVE');
    if (action === 'RETRY') { assert.ok(out); assert.deepEqual(states(c, tableId), ['SENT']); assert.equal(ack(c, out, tableId).ok, true); }
    if (action === 'KEEP_CREDIT') { assert.deepEqual(states(c, tableId), ['CANCELLED']); assert.equal(availableGames(c, tableId), 1); }
    if (action === 'REFUND') { assert.deepEqual(states(c, tableId), ['REFUNDED']); assert.equal(balance(c.db, A.refundDue), -kes(20)); assert.equal(availableGames(c, tableId), 0); }
    assert.equal(c.db.get<{ n: number }>('SELECT COUNT(*) n FROM vends')!.n, 1);
    assert.throws(() => resolveFailed(c, vendId, 'REFUND', 'mgr', 'again'), IllegalTransitionError);
  }
});
test('vend: late ack after FAILED proves the device vended: vend becomes CONFIRMED, no refund possible', () => {
  const c = newCtx(); const { tableId } = makeTable(c, { maxVendAttempts: 1, vendTimeoutMs: 1000 }); pay(c, tableId, 'L1', 20);
  const [d] = dispatch(c, tableId); c.clock.ms += 1_001; sweep(c);
  assert.deepEqual(states(c, tableId), ['FAILED']);
  assert.deepEqual(ack(c, d, tableId), { ok: true, state: 'CONFIRMED', duplicate: false });
  assert.equal(c.db.get<{ status: string }>('SELECT status FROM pool_tables')!.status, 'ACTIVE');
  assert.throws(() => resolveFailed(c, d.vendId, 'REFUND', 'm', 'x'), IllegalTransitionError);
});
test('vend: device REJECT fails the vend immediately', () => {
  const c = newCtx(); const { tableId } = makeTable(c); pay(c, tableId, 'D1', 20);
  const [d] = dispatch(c, tableId);
  assert.deepEqual(ack(c, d, tableId, 'REJECT'), { ok: true, state: 'FAILED', duplicate: false });
});
test('vend: faulted/disabled tables do not dispatch but still accept payment (paid games are never lost)', () => {
  const c = newCtx(); const { tableId } = makeTable(c);
  c.db.run("UPDATE pool_tables SET status='DISABLED'"); pay(c, tableId, 'X', 20);
  assert.deepEqual(dispatch(c, tableId), []); assert.equal(availableGames(c, tableId), 1);
});
