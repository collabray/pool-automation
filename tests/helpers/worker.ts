import { parentPort, workerData } from 'node:worker_threads';
import { Db } from '../../src/core/db.ts';
import { creditPurchase } from '../../src/core/credit.ts';
import { dispatch } from '../../src/core/vend.ts';
import { idempotent, hashRequest } from '../../src/core/idempotency.ts';
import { MASTER_KEY } from './ctx.ts';
import { handleStkCallback } from '../../src/core/stk.ts';
import { redeemVoucher, VoucherError } from '../../src/core/vouchers.ts';
import { cashSale } from '../../src/core/cash.ts';

// Each worker owns its own SQLite connection, so contention is real (separate connections, separate OS threads).
const { path, op, n, tableId, receipt, amountMinor, startFlag, worker, body, code, attendantId } = workerData as Record<string, any>;
const db = new Db(path);
const ctx = { db, now: () => new Date(), masterKey: MASTER_KEY };
const flag = new Int32Array(startFlag);
Atomics.wait(flag, 0, 0); // barrier: all workers start together

const results: unknown[] = [];
for (let i = 0; i < n; i++) {
  if (op === 'stk-callback') { results.push((await handleStkCallback(ctx, null, body, '127.0.0.1')).verdict); continue; }
  if (op === 'voucher') { try { redeemVoucher(ctx, { code, tableId, ip: `10.0.${worker}.${i}` }); results.push('OK'); } catch (e) { results.push(e instanceof VoucherError ? e.code : 'ERR:' + (e as Error).message); } continue; }
  if (op === 'cash-sale') { const r = cashSale(ctx, { attendantId, tableId, cashReceivedMinor: amountMinor, idempotencyKey: 'dbl-tap' }); results.push(r.duplicate ? 'DUP' : 'NEW'); continue; }
  if (op === 'credit-same-receipt') {
    // Same M-Pesa receipt delivered many times, each delivery with a different idempotency key (worst case).
    results.push(creditPurchase(ctx, { source: 'MPESA_STK', idempotencyKey: `k-${worker}-${i}`, externalRef: receipt, tableId, amountMinor, actor: 'cb' }));
  } else if (op === 'credit-same-key') {
    results.push(creditPurchase(ctx, { source: 'CASH', idempotencyKey: 'one-key', externalRef: `cash-${worker}-${i}`, tableId, amountMinor, actor: 'att' }));
  } else if (op === 'dispatch') {
    results.push(dispatch(ctx, tableId, 'req').length);
  } else if (op === 'idempotent') {
    results.push(idempotent(db, ctx.now(), 'cashsale', 'same-click', hashRequest({ t: tableId }), () => {
      db.run("INSERT INTO settings(key,value) VALUES ('effect-' || hex(randomblob(8)), 'x')");
      return { done: true };
    }).replayed);
  }
}
parentPort!.postMessage(results);
db.close();
