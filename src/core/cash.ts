import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { creditPurchase } from './credit.ts';
import { A, balance, postTxn } from './ledger.ts';
import { assertMinor } from './money.ts';
import { getInt, getSetting } from './settings.ts';

export class CashError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
interface UserRow { id: string; role: 'owner' | 'manager' | 'attendant'; active: number; void_limit_minor: number; discount_limit_minor: number }
const user = (ctx: Ctx, id: string): UserRow => {
  const u = ctx.db.get<UserRow>('SELECT id, role, active, void_limit_minor, discount_limit_minor FROM users WHERE id=?', id);
  if (!u || !u.active) throw new CashError('FORBIDDEN', 'unknown or inactive user');
  return u;
};
const isManager = (u: UserRow) => u.role === 'owner' || u.role === 'manager';
/** Manager approval must come from a different, active manager/owner than the person asking (unless they are one themselves above their own limit: owners self-approve). */
function requireApproval(ctx: Ctx, actor: UserRow, approvedBy: string | undefined, what: string): string {
  if (!approvedBy) throw new CashError('APPROVAL_REQUIRED', `${what} exceeds your limit: manager approval required`);
  const m = user(ctx, approvedBy);
  if (!isManager(m)) throw new CashError('APPROVAL_INVALID', 'approver must be a manager or owner');
  if (m.id === actor.id && m.role !== 'owner') throw new CashError('APPROVAL_INVALID', 'you cannot approve your own action');
  return m.id;
}

const SHIFT_ROW = 'id, attendant_id, status, float_minor, opened_at, closed_at, counted_minor, expected_minor, variance_minor, variance_flagged';

export function openShift(ctx: Ctx, attendantId: string, floatMinor: number): { shiftId: string } {
  assertMinor(floatMinor, 'float'); if (floatMinor < 0) throw new CashError('INVALID', 'float must not be negative');
  return ctx.db.tx(() => {
    user(ctx, attendantId);
    if (ctx.db.get(`SELECT 1 FROM shifts WHERE attendant_id=? AND status='OPEN'`, attendantId)) throw new CashError('SHIFT_ALREADY_OPEN', 'a shift is already open');
    const id = randomUUID();
    ctx.db.run(`INSERT INTO shifts(id,attendant_id,float_minor,opened_at) VALUES (?,?,?,?)`, id, attendantId, floatMinor, ctx.now().toISOString());
    appendAudit(ctx.db, ctx.now(), { actor: attendantId, action: 'shift.opened', entityType: 'shift', entityId: id, data: { floatMinor } });
    return { shiftId: id };
  });
}
export const openShiftOf = (ctx: Ctx, attendantId: string) => ctx.db.get<{ id: string }>(`SELECT id FROM shifts WHERE attendant_id=? AND status='OPEN'`, attendantId)?.id ?? null;

/** Gap-detectable sequential receipt numbers; a rolled-back sale never consumes a number. */
function nextReceipt(ctx: Ctx): { no: string; seq: number } {
  ctx.db.run(`INSERT INTO receipt_counters(name,n) VALUES ('cash',0) ON CONFLICT(name) DO NOTHING`);
  ctx.db.run(`UPDATE receipt_counters SET n=n+1 WHERE name='cash'`);
  const n = ctx.db.get<{ n: number }>(`SELECT n FROM receipt_counters WHERE name='cash'`)!.n;
  return { no: `C-${String(n).padStart(6, '0')}`, seq: n };
}
export function receiptGaps(ctx: Ctx): number[] {
  const rows = ctx.db.all<{ receipt_seq: number }>('SELECT receipt_seq FROM cash_sales ORDER BY receipt_seq');
  const gaps: number[] = []; let prev = 0;
  for (const r of rows) { for (let s = prev + 1; s < r.receipt_seq; s++) gaps.push(s); prev = r.receipt_seq; }
  return gaps;
}

export interface CashSaleInput {
  attendantId: string; tableId: string; cashReceivedMinor: number; idempotencyKey: string;
  discountMinor?: number; discountReason?: string; approvedBy?: string; offline?: boolean;
}
export interface CashSaleResult { saleId: string; receiptNo: string; games: number; changeMinor: number; heldMinor: number; duplicate: boolean }

export function cashSale(ctx: Ctx, i: CashSaleInput): CashSaleResult {
  assertMinor(i.cashReceivedMinor, 'cash'); if (i.cashReceivedMinor <= 0) throw new CashError('INVALID', 'cash must be positive');
  const discount = i.discountMinor ?? 0;
  return ctx.db.tx(() => {
    const u = user(ctx, i.attendantId);
    const key = `cash:${i.attendantId}:${i.idempotencyKey}`;
    const dup = ctx.db.get<{ id: string; receipt_no: string; games: number; change_minor: number; payment_id: string }>(
      'SELECT s.id, s.receipt_no, s.games, s.change_minor, s.payment_id FROM cash_sales s JOIN payments p ON p.id=s.payment_id WHERE p.idempotency_key=?', key);
    if (dup) return { saleId: dup.id, receiptNo: dup.receipt_no, games: dup.games, changeMinor: dup.change_minor, heldMinor: 0, duplicate: true };

    const shiftId = openShiftOf(ctx, i.attendantId);
    if (!shiftId) throw new CashError('NO_OPEN_SHIFT', 'open a shift before taking cash');
    if (i.offline) {
      if (getSetting(ctx, 'cash.offline_enabled') !== '1') throw new CashError('OFFLINE_DISABLED', 'offline sales are disabled');
      if (i.cashReceivedMinor > getInt(ctx, 'cash.offline_max_minor')) throw new CashError('OFFLINE_CAP', 'amount exceeds the offline sale cap');
    }
    let approver: string | null = null;
    if (discount > 0) {
      if (!i.discountReason?.trim()) throw new CashError('REASON_REQUIRED', 'a discount needs a reason');
      if (discount > u.discount_limit_minor) approver = requireApproval(ctx, u, i.approvedBy, 'discount');
    }
    const receipt = nextReceipt(ctx);
    const r = creditPurchase(ctx, { source: 'CASH', idempotencyKey: key, externalRef: receipt.no, tableId: i.tableId, amountMinor: i.cashReceivedMinor,
      discountMinor: discount, attendantId: i.attendantId, shiftId, actor: i.attendantId });
    if (r.status === 'REJECTED') throw new CashError(r.reason, r.reason === 'REMAINDER_NOT_ALLOWED' ? 'amount is not an exact multiple of the price' : 'amount too low');
    let change = 0, held = 0;
    if (r.remainderAction === 'REFUND_DUE') {
      change = r.remainderMinor;
      // The remainder is handed back in cash straight away.
      postTxn(ctx.db, { txnId: randomUUID(), refType: 'cash_change', refId: r.paymentId, at: ctx.now().toISOString(), entries: [
        { account: A.refundDue, unit: 'KES', amount: change, tableId: i.tableId }, { account: A.cash, unit: 'KES', amount: -change, tableId: i.tableId }] });
    } else if (r.remainderAction === 'HELD') held = r.remainderMinor;
    const id = randomUUID();
    ctx.db.run(`INSERT INTO cash_sales(id,receipt_no,receipt_seq,shift_id,attendant_id,table_id,payment_id,cash_received_minor,discount_minor,discount_reason,change_minor,games,offline,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, receipt.no, receipt.seq, shiftId, i.attendantId, i.tableId, r.paymentId, i.cashReceivedMinor, discount,
      i.discountReason?.trim() ?? null, change, r.games, i.offline ? 1 : 0, ctx.now().toISOString());
    appendAudit(ctx.db, ctx.now(), { actor: i.attendantId, action: 'cash.sale', entityType: 'cash_sale', entityId: id,
      data: { receiptNo: receipt.no, tableId: i.tableId, cash: i.cashReceivedMinor, games: r.games, change, discount, approvedBy: approver } });
    return { saleId: id, receiptNo: receipt.no, games: r.games, changeMinor: change, heldMinor: held, duplicate: false };
  });
}

/** Voids an unused cash sale: credits must still be unvended. Needs a reason, an open shift, and approval above the actor's limit. */
export function voidCashSale(ctx: Ctx, a: { saleId: string; actorId: string; reason: string; approvedBy?: string }): { refundCashMinor: number } {
  if (!a.reason.trim()) throw new CashError('REASON_REQUIRED', 'a reason is required');
  return ctx.db.tx(() => {
    const actor = user(ctx, a.actorId);
    const s = ctx.db.get<{ id: string; status: string; shift_id: string; attendant_id: string; table_id: string; payment_id: string; cash_received_minor: number; change_minor: number; games: number }>('SELECT * FROM cash_sales WHERE id=?', a.saleId);
    if (!s) throw new CashError('NOT_FOUND', 'sale not found');
    if (s.status === 'VOIDED') throw new CashError('ALREADY_VOIDED', 'sale already voided');
    if (!isManager(actor) && actor.id !== s.attendant_id) throw new CashError('FORBIDDEN', 'you can only void your own sales');
    const shift = ctx.db.get<{ status: string }>('SELECT status FROM shifts WHERE id=?', s.shift_id)!;
    if (shift.status !== 'OPEN') throw new CashError('SHIFT_CLOSED', 'closed shifts are immutable; ask the owner for an adjustment');
    const net = s.cash_received_minor - s.change_minor;
    let approver: string | null = null;
    if (!isManager(actor) && net > actor.void_limit_minor) approver = requireApproval(ctx, actor, a.approvedBy, 'void');
    if (balance(ctx.db, A.gamesAvail(s.table_id)) < s.games) throw new CashError('GAMES_ALREADY_USED', 'some of these games were already released; use the vend refund flow');
    reverseByRef(ctx, 'payment', s.payment_id); reverseByRef(ctx, 'cash_change', s.payment_id);
    ctx.db.run(`UPDATE cash_sales SET status='VOIDED', void_reason=?, voided_by=?, void_approved_by=?, voided_at=? WHERE id=?`, a.reason.trim(), a.actorId, approver, ctx.now().toISOString(), s.id);
    appendAudit(ctx.db, ctx.now(), { actor: a.actorId, action: 'cash.void', entityType: 'cash_sale', entityId: s.id, data: { reason: a.reason.trim(), net, approvedBy: approver } });
    return { refundCashMinor: net };
  });
}

/** Posts the exact negation of every ledger entry carrying (refType, refId). The ledger itself is never edited. */
export function reverseByRef(ctx: Ctx, refType: string, refId: string): void {
  const rows = ctx.db.all<{ account: string; unit: 'KES' | 'GAME'; amount: number; table_id: string | null }>('SELECT account, unit, amount, table_id FROM ledger_entries WHERE ref_type=? AND ref_id=?', refType, refId);
  if (!rows.length) return;
  postTxn(ctx.db, { txnId: randomUUID(), refType: `${refType}_reversal`, refId, at: ctx.now().toISOString(),
    entries: rows.map((r) => ({ account: r.account, unit: r.unit, amount: -r.amount, tableId: r.table_id, memo: 'reversal' })) });
}

export function expectedCash(ctx: Ctx, shiftId: string): number {
  const sh = ctx.db.get<{ float_minor: number }>('SELECT float_minor FROM shifts WHERE id=?', shiftId);
  if (!sh) throw new CashError('NOT_FOUND', 'shift not found');
  const s = ctx.db.get<{ t: number }>(`SELECT COALESCE(SUM(cash_received_minor - change_minor),0) t FROM cash_sales WHERE shift_id=? AND status='ACTIVE'`, shiftId)!.t;
  return sh.float_minor + s;
}

export function closeShift(ctx: Ctx, a: { shiftId: string; actorId: string; countedMinor: number }): { expectedMinor: number; countedMinor: number; varianceMinor: number; flagged: boolean } {
  assertMinor(a.countedMinor, 'counted'); if (a.countedMinor < 0) throw new CashError('INVALID', 'counted cash must not be negative');
  return ctx.db.tx(() => {
    const actor = user(ctx, a.actorId);
    const sh = ctx.db.get<{ attendant_id: string; status: string }>('SELECT attendant_id, status FROM shifts WHERE id=?', a.shiftId);
    if (!sh) throw new CashError('NOT_FOUND', 'shift not found');
    if (sh.status === 'CLOSED') throw new CashError('SHIFT_CLOSED', 'shift already closed');
    if (!isManager(actor) && actor.id !== sh.attendant_id) throw new CashError('FORBIDDEN', 'not your shift');
    const expected = expectedCash(ctx, a.shiftId);
    const variance = a.countedMinor - expected;
    const flagged = Math.abs(variance) > getInt(ctx, 'cash.variance_threshold_minor');
    ctx.db.run(`UPDATE shifts SET status='CLOSED', closed_at=?, counted_minor=?, expected_minor=?, variance_minor=?, variance_flagged=? WHERE id=?`,
      ctx.now().toISOString(), a.countedMinor, expected, variance, flagged ? 1 : 0, a.shiftId);
    if (flagged) ctx.db.run(`INSERT INTO alerts(id,kind,severity,table_id,message,created_at) VALUES (?,?,?,?,?,?)`, randomUUID(), 'SHIFT_VARIANCE', 'HIGH', null,
      `Shift ${a.shiftId} variance ${variance} minor units (expected ${expected}, counted ${a.countedMinor}).`, ctx.now().toISOString());
    appendAudit(ctx.db, ctx.now(), { actor: a.actorId, action: 'shift.closed', entityType: 'shift', entityId: a.shiftId, data: { expected, counted: a.countedMinor, variance, flagged } });
    return { expectedMinor: expected, countedMinor: a.countedMinor, varianceMinor: variance, flagged };
  });
}

/** Closed shifts never change. The owner may record an adjustment alongside (with a reason). */
export function adjustClosedShift(ctx: Ctx, a: { shiftId: string; ownerId: string; amountMinor: number; reason: string }): string {
  assertMinor(a.amountMinor, 'amount');
  if (!a.reason.trim()) throw new CashError('REASON_REQUIRED', 'a reason is required');
  return ctx.db.tx(() => {
    const o = user(ctx, a.ownerId);
    if (o.role !== 'owner') throw new CashError('FORBIDDEN', 'only the owner can adjust a closed shift');
    const sh = ctx.db.get<{ status: string }>('SELECT status FROM shifts WHERE id=?', a.shiftId);
    if (!sh || sh.status !== 'CLOSED') throw new CashError('INVALID', 'only closed shifts take adjustments');
    const id = randomUUID();
    ctx.db.run('INSERT INTO shift_adjustments(id,shift_id,amount_minor,reason,approved_by,created_at) VALUES (?,?,?,?,?,?)', id, a.shiftId, a.amountMinor, a.reason.trim(), a.ownerId, ctx.now().toISOString());
    appendAudit(ctx.db, ctx.now(), { actor: a.ownerId, action: 'shift.adjusted', entityType: 'shift', entityId: a.shiftId, data: { amountMinor: a.amountMinor, reason: a.reason.trim() } });
    return id;
  });
}

export function getShift(ctx: Ctx, id: string) { return ctx.db.get<Record<string, unknown>>(`SELECT ${SHIFT_ROW} FROM shifts WHERE id=?`, id); }
