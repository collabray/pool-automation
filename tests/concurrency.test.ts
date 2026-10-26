import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { newCtx, makeTable } from './helpers/ctx.ts';
import { A, balance, verifyLedger } from '../src/core/ledger.ts';
import { verifyAuditChain } from '../src/core/audit.ts';
import { creditPurchase } from '../src/core/credit.ts';
import { dispatch } from '../src/core/vend.ts';
import { kes } from '../src/core/money.ts';

/** Runs `workers` threads x `perWorker` calls each, all released at the same instant. */
async function storm(path: string, op: string, workers: number, perWorker: number, extra: Record<string, unknown>): Promise<unknown[]> {
  const startFlag = new SharedArrayBuffer(4);
  const pending = Array.from({ length: workers }, (_, w) => new Promise<unknown[]>((res, rej) => {
    const wk = new Worker(new URL('./helpers/worker.ts', import.meta.url), { workerData: { path, op, n: perWorker, startFlag, worker: w, ...extra } });
    wk.once('message', res); wk.once('error', rej);
  }));
  await new Promise((r) => setTimeout(r, 400)); // let every worker open its connection and park on the barrier
  Atomics.store(new Int32Array(startFlag), 0, 1); Atomics.notify(new Int32Array(startFlag), 0);
  return (await Promise.all(pending)).flat();
}

test('100 parallel duplicate callbacks for one KES 100 receipt credit exactly 5 games, once', async () => {
  const c = newCtx(); const { tableId } = makeTable(c);
  const res = await storm(c.path, 'credit-same-receipt', 10, 10, { tableId, receipt: 'QWE123RTY', amountMinor: kes(100) }) as any[];
  assert.equal(res.length, 100);
  assert.equal(res.filter((r) => r.status === 'CREDITED' && !r.duplicate).length, 1);
  assert.equal(res.filter((r) => r.duplicate).length, 99);
  assert.equal(c.db.get<{ n: number }>('SELECT COUNT(*) n FROM payments')!.n, 1);
  assert.equal(balance(c.db, A.gamesAvail(tableId)), 5);
  assert.equal(balance(c.db, A.gamesIssued), -5);
  assert.equal(balance(c.db, A.mpesa), kes(100));
  assert.deepEqual(verifyLedger(c.db), []);
  assert.equal(verifyAuditChain(c.db).ok, true);
});

test('50 parallel vend requests with 5 credits (ALL mode) create exactly 5 vends', async () => {
  const c = newCtx(); const { tableId } = makeTable(c, { releaseMode: 'ALL' });
  creditPurchase(c, { source: 'CASH', idempotencyKey: 'a', externalRef: 'a', tableId, amountMinor: kes(100), actor: 't' });
  const res = await storm(c.path, 'dispatch', 10, 5, { tableId }) as number[];
  assert.equal(res.reduce((a, b) => a + b, 0), 5);
  assert.equal(c.db.get<{ n: number }>('SELECT COUNT(*) n FROM vends')!.n, 5);
  assert.equal(c.db.get<{ n: number }>("SELECT COUNT(*) n FROM vends WHERE state='SENT'")!.n, 5);
  assert.equal(balance(c.db, A.gamesAvail(tableId)), 0);
  assert.equal(balance(c.db, A.gamesInflight(tableId)), 5);
  assert.deepEqual(verifyLedger(c.db), []);
});

test('50 parallel vend requests in ONE mode create exactly 1 vend', async () => {
  const c = newCtx(); const { tableId } = makeTable(c);
  creditPurchase(c, { source: 'CASH', idempotencyKey: 'a', externalRef: 'a', tableId, amountMinor: kes(100), actor: 't' });
  const res = await storm(c.path, 'dispatch', 10, 5, { tableId }) as number[];
  assert.equal(res.reduce((a, b) => a + b, 0), 1);
  assert.equal(c.db.get<{ n: number }>('SELECT COUNT(*) n FROM vends')!.n, 1);
  assert.equal(balance(c.db, A.gamesAvail(tableId)), 4);
});

test('parallel duplicate cash sales with one idempotency key credit once', async () => {
  const c = newCtx(); const { tableId } = makeTable(c);
  const res = await storm(c.path, 'credit-same-key', 10, 5, { tableId, amountMinor: kes(20) }) as any[];
  assert.equal(res.filter((r) => !r.duplicate).length, 1);
  assert.equal(c.db.get<{ n: number }>('SELECT COUNT(*) n FROM payments')!.n, 1);
  assert.equal(balance(c.db, A.gamesAvail(tableId)), 1);
});

test('generic idempotency layer: 50 parallel identical requests run the effect once', async () => {
  const c = newCtx(); const { tableId } = makeTable(c);
  const res = await storm(c.path, 'idempotent', 10, 5, { tableId }) as boolean[];
  assert.equal(res.filter((r) => r === false).length, 1);
  assert.equal(c.db.get<{ n: number }>("SELECT COUNT(*) n FROM settings WHERE key LIKE 'effect-%'")!.n, 1);
});

test('payments racing with dispatch: games issued always equals vended + inflight + available', async () => {
  const c = newCtx(); const { tableId } = makeTable(c, { releaseMode: 'ALL' });
  const pays = storm(c.path, 'credit-same-receipt', 4, 5, { tableId, receipt: 'ONE', amountMinor: kes(60) });
  const disp = storm(c.path, 'dispatch', 4, 10, { tableId });
  await Promise.all([pays, disp]);
  dispatch(c, tableId);
  const total = 3;
  assert.equal(-balance(c.db, A.gamesIssued), total);
  assert.equal(balance(c.db, A.gamesAvail(tableId)) + balance(c.db, A.gamesInflight(tableId)) + balance(c.db, A.gamesVended(tableId)), total);
  assert.equal(c.db.get<{ n: number }>('SELECT COUNT(*) n FROM vends')!.n, total);
  assert.deepEqual(verifyLedger(c.db), []);
});
