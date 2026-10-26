import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { A, balance, postTxn, type Entry } from './ledger.ts';

export class ReversalError extends Error {}

/**
 * Reverses a credited M-Pesa payment (e.g. Safaricom reversal). Unvended credits are removed; credits that were
 * already vended cannot be un-played, so their value is booked to a reversal-loss expense and the owner is alerted.
 */
export function reversePayment(ctx: Ctx, a: { paymentId: string; reason: string; actor: string }): { removedGames: number; lossMinor: number } {
  if (!a.reason.trim()) throw new ReversalError('a reason is required');
  return ctx.db.tx(() => {
    const p = ctx.db.get<{ id: string; table_id: string; source: string; amount_minor: number; games_credited: number; charged_minor: number; wallet_used_minor: number; remainder_minor: number; remainder_action: string; owner_ref: string | null }>('SELECT * FROM payments WHERE id=?', a.paymentId);
    if (!p) throw new ReversalError('payment not found');
    if (!p.source.startsWith('MPESA')) throw new ReversalError('only M-Pesa payments can be reversed here');
    if (p.wallet_used_minor > 0) throw new ReversalError('payments that consumed wallet credit must be reversed manually');
    if (ctx.db.get(`SELECT 1 FROM ledger_entries WHERE ref_type='payment_reversal' AND ref_id=?`, a.paymentId)) throw new ReversalError('already reversed');
    const avail = balance(ctx.db, A.gamesAvail(p.table_id));
    const removed = Math.min(avail, p.games_credited);
    const unreversed = p.games_credited - removed;
    const loss = p.games_credited > 0 ? Math.round((p.charged_minor * unreversed) / p.games_credited) : 0;
    const t = p.table_id;
    const e: Entry[] = [{ account: A.mpesa, unit: 'KES', amount: -p.amount_minor, tableId: t }];
    if (p.charged_minor - loss !== 0) e.push({ account: A.revenue(t), unit: 'KES', amount: p.charged_minor - loss, tableId: t });
    if (loss > 0) e.push({ account: A.reversalLoss, unit: 'KES', amount: loss, tableId: t });
    if (p.remainder_minor > 0) e.push({ account: p.remainder_action === 'REFUND_DUE' ? A.refundDue : A.wallet(t, p.owner_ref || '_table'), unit: 'KES', amount: p.remainder_minor, tableId: t });
    if (removed > 0) { e.push({ account: A.gamesAvail(t), unit: 'GAME', amount: -removed, tableId: t }); e.push({ account: A.gamesIssued, unit: 'GAME', amount: removed, tableId: t }); }
    postTxn(ctx.db, { txnId: randomUUID(), refType: 'payment_reversal', refId: p.id, at: ctx.now().toISOString(), entries: e });
    if (unreversed > 0) ctx.db.run(`INSERT INTO alerts(id,kind,severity,table_id,message,created_at) VALUES (?,?,?,?,?,?)`, randomUUID(), 'REVERSAL_AFTER_VEND', 'HIGH', t,
      `Payment ${p.id} reversed after ${unreversed} game(s) were already played (loss ${loss}).`, ctx.now().toISOString());
    appendAudit(ctx.db, ctx.now(), { actor: a.actor, action: 'payment.reversed', entityType: 'payment', entityId: p.id, data: { reason: a.reason.trim(), removed, lossMinor: loss } });
    return { removedGames: removed, lossMinor: loss };
  });
}
