import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { creditPurchase } from './credit.ts';
import { A, postTxn } from './ledger.ts';

export class AssignError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Books a receipt that must NOT vend (other-business money, wrong amount, unknown request...). Idempotent per receipt. */
export function recordUnallocated(ctx: Ctx, p: {
  receipt: string; source: string; amountMinor: number; phoneHash?: string | null; accountRef?: string | null; reason: string; raw: unknown;
}): string {
  return ctx.db.tx(() => {
    const ex = ctx.db.get<{ id: string }>('SELECT id FROM unallocated_payments WHERE receipt=?', p.receipt);
    if (ex) return ex.id;
    const id = randomUUID();
    const at = ctx.now().toISOString();
    ctx.db.run(`INSERT INTO unallocated_payments(id,receipt,source,amount_minor,phone_hash,account_ref,reason,raw_json,received_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, p.receipt, p.source, p.amountMinor, p.phoneHash ?? null, p.accountRef ?? null, p.reason, JSON.stringify(p.raw ?? null), at);
    postTxn(ctx.db, { txnId: randomUUID(), refType: 'unallocated', refId: id, at, entries: [
      { account: A.mpesa, unit: 'KES', amount: p.amountMinor }, { account: A.unallocated, unit: 'KES', amount: -p.amountMinor, memo: p.reason }] });
    appendAudit(ctx.db, ctx.now(), { actor: 'system', action: 'payment.unallocated', entityType: 'unallocated', entityId: id,
      data: { receipt: p.receipt, source: p.source, amountMinor: p.amountMinor, reason: p.reason } });
    return id;
  });
}

/**
 * Owner/manager manually assigns an unallocated payment to a table. Requires a reason, is audit-logged,
 * and is idempotent: repeating the same assignment is a no-op, assigning elsewhere is refused.
 */
export function assignUnallocated(ctx: Ctx, a: { id: string; tableId: string; actorId: string; reason: string }): { duplicate: boolean; games: number; paymentId: string } {
  if (!a.reason.trim()) throw new AssignError('REASON_REQUIRED', 'a reason is required');
  return ctx.db.tx(() => {
    const actor = ctx.db.get<{ role: string; active: number }>('SELECT role, active FROM users WHERE id=?', a.actorId);
    if (!actor || !actor.active || (actor.role !== 'owner' && actor.role !== 'manager')) throw new AssignError('FORBIDDEN', 'only an owner or manager may assign payments');
    const row = ctx.db.get<{ id: string; receipt: string; amount_minor: number; phone_hash: string | null; status: string; assigned_table_id: string | null; payment_id: string | null }>(
      'SELECT * FROM unallocated_payments WHERE id=?', a.id);
    if (!row) throw new AssignError('NOT_FOUND', 'unallocated payment not found');
    if (row.status === 'ASSIGNED') {
      if (row.assigned_table_id !== a.tableId) throw new AssignError('ALREADY_ASSIGNED', 'already assigned to a different table');
      const p = ctx.db.get<{ games_credited: number }>('SELECT games_credited FROM payments WHERE id=?', row.payment_id!)!;
      return { duplicate: true, games: p.games_credited, paymentId: row.payment_id! };
    }
    const r = creditPurchase(ctx, { source: 'MPESA_C2B', idempotencyKey: `assign:${a.id}`, externalRef: row.receipt, tableId: a.tableId,
      amountMinor: row.amount_minor, ownerRef: row.phone_hash, fundingAccount: A.unallocated, actor: a.actorId });
    if (r.status !== 'CREDITED') throw new AssignError('REJECTED', `table policy rejected the amount (${r.reason})`);
    ctx.db.run(`UPDATE unallocated_payments SET status='ASSIGNED', assigned_table_id=?, assigned_by=?, assign_reason=?, assigned_at=?, payment_id=? WHERE id=?`,
      a.tableId, a.actorId, a.reason.trim(), ctx.now().toISOString(), r.paymentId, a.id);
    appendAudit(ctx.db, ctx.now(), { actor: a.actorId, action: 'unallocated.assigned', entityType: 'unallocated', entityId: a.id,
      data: { tableId: a.tableId, reason: a.reason.trim(), games: r.games, receipt: row.receipt } });
    return { duplicate: false, games: r.games, paymentId: r.paymentId };
  });
}

export function listUnallocated(ctx: Ctx, status: 'UNALLOCATED' | 'ASSIGNED' | 'ALL' = 'UNALLOCATED') {
  return ctx.db.all<Record<string, unknown>>(
    `SELECT id, receipt, source, amount_minor, reason, account_ref, status, received_at, assigned_table_id, assigned_by, assign_reason, assigned_at
       FROM unallocated_payments WHERE (?='ALL' OR status=?) ORDER BY received_at DESC`, status, status);
}
