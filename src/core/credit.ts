import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { A, balance, postTxn, type Entry } from './ledger.ts';
import { assertMinor } from './money.ts';
import { gamesForAmount, parsePricing, quote } from './pricing.ts';

export type PaymentSource = 'MPESA_STK' | 'MPESA_C2B' | 'CASH' | 'VOUCHER';
const NAMESPACE: Record<PaymentSource, 'MPESA' | 'CASH' | 'VOUCHER'> = { MPESA_STK: 'MPESA', MPESA_C2B: 'MPESA', CASH: 'CASH', VOUCHER: 'VOUCHER' };
const ASSET: Record<PaymentSource, string> = { MPESA_STK: A.mpesa, MPESA_C2B: A.mpesa, CASH: A.cash, VOUCHER: A.voucher };

export class CreditError extends Error {
  code: 'UNKNOWN_TABLE' | 'INVALID_INPUT' | 'DUPLICATE_MISMATCH';
  constructor(code: 'UNKNOWN_TABLE' | 'INVALID_INPUT' | 'DUPLICATE_MISMATCH', message: string) { super(message); this.code = code; }
}

export interface CreditInput {
  source: PaymentSource;
  idempotencyKey: string;
  /** M-Pesa receipt number, cash receipt number or voucher code: globally unique within its namespace. */
  externalRef: string;
  tableId: string;
  amountMinor: number;
  /** Hashed phone (or other owner token) for wallet credit. Optional. */
  ownerRef?: string | null;
  /** STK flow: exact number of games the customer chose. Omit for amount-based flows (cash, C2B). */
  gamesRequested?: number;
  /** Cash-sale discount (shown as an expense, never as revenue). */
  discountMinor?: number;
  /** Override the debit account (used when assigning an already-booked unallocated receipt). */
  fundingAccount?: string;
  attendantId?: string | null;
  shiftId?: string | null;
  actor: string;
}

export type CreditResult =
  | { status: 'CREDITED'; paymentId: string; games: number; chargedMinor: number; remainderMinor: number; remainderAction: 'NONE' | 'HELD' | 'REFUND_DUE'; walletUsedMinor: number; duplicate: boolean }
  | { status: 'REJECTED'; reason: 'REMAINDER_NOT_ALLOWED' | 'INSUFFICIENT_AMOUNT'; remainderMinor: number };

interface PaymentRow {
  id: string; table_id: string; amount_minor: number; games_credited: number; charged_minor: number;
  wallet_used_minor: number; remainder_minor: number; remainder_action: 'NONE' | 'HELD' | 'REFUND_DUE';
}

function fromRow(r: PaymentRow, duplicate: boolean): CreditResult {
  return { status: 'CREDITED', paymentId: r.id, games: r.games_credited, chargedMinor: r.charged_minor, remainderMinor: r.remainder_minor,
    remainderAction: r.remainder_action, walletUsedMinor: r.wallet_used_minor, duplicate };
}

/**
 * Turns one confirmed payment into game credits, exactly once.
 * Everything (duplicate check, ledger postings, payment row, audit entry) happens in a single
 * write transaction. Duplicates are detected by (namespace, external_ref) and by idempotency key,
 * both backed by UNIQUE constraints, so even a bug in this function cannot double-credit.
 */
export function creditPurchase(ctx: Ctx, input: CreditInput): CreditResult {
  assertMinor(input.amountMinor, 'amountMinor');
  if (input.amountMinor <= 0) throw new CreditError('INVALID_INPUT', 'amount must be positive');
  if (!NAMESPACE[input.source]) throw new CreditError('INVALID_INPUT', 'unknown payment source');
  if (!input.externalRef || !input.idempotencyKey) throw new CreditError('INVALID_INPUT', 'externalRef and idempotencyKey are required');
  if (input.gamesRequested !== undefined && (!Number.isInteger(input.gamesRequested) || input.gamesRequested < 1)) {
    throw new CreditError('INVALID_INPUT', 'gamesRequested must be a positive integer');
  }
  const { db } = ctx;
  return db.tx(() => {
    const ns = NAMESPACE[input.source];
    const existing =
      db.get<PaymentRow>('SELECT * FROM payments WHERE ref_namespace=? AND external_ref=?', ns, input.externalRef) ??
      db.get<PaymentRow>('SELECT * FROM payments WHERE idempotency_key=?', input.idempotencyKey);
    if (existing) {
      if (existing.table_id !== input.tableId || existing.amount_minor !== input.amountMinor) {
        throw new CreditError('DUPLICATE_MISMATCH', 'reference already used for a different payment');
      }
      return fromRow(existing, true);
    }
    const table = db.get<{ pricing_json: string }>('SELECT pricing_json FROM pool_tables WHERE id=?', input.tableId);
    if (!table) throw new CreditError('UNKNOWN_TABLE', 'table does not exist');
    const cfg = parsePricing(JSON.parse(table.pricing_json));
    const at = ctx.now();
    const reject = (reason: 'REMAINDER_NOT_ALLOWED' | 'INSUFFICIENT_AMOUNT', remainderMinor: number): CreditResult => {
      appendAudit(db, at, { actor: input.actor, action: 'payment.rejected', entityType: 'table', entityId: input.tableId,
        data: { source: input.source, externalRef: input.externalRef, amountMinor: input.amountMinor, reason } });
      return { status: 'REJECTED', reason, remainderMinor };
    };

    const discount = input.discountMinor ?? 0;
    assertMinor(discount, 'discountMinor');
    if (discount < 0) throw new CreditError('INVALID_INPUT', 'discount must not be negative');
    const base = input.amountMinor + discount;
    const owner = input.ownerRef || '_table';
    const policy = cfg.remainderPolicy;
    const walletBal = policy === 'HOLD_CREDIT' ? -balance(db, A.wallet(input.tableId, owner)) : 0;

    let games: number, charged: number, walletUsed: number;
    if (input.gamesRequested !== undefined) {
      const q = quote(cfg, input.gamesRequested, at);
      walletUsed = Math.min(walletBal, Math.max(0, q.totalMinor - base));
      if (base + walletUsed < q.totalMinor) return reject('INSUFFICIENT_AMOUNT', 0);
      games = q.games; charged = q.totalMinor;
    } else {
      walletUsed = walletBal;
      const g = gamesForAmount(cfg, base + walletUsed, at);
      games = g.games; charged = g.costMinor;
      if (policy === 'REJECT' && g.remainderMinor > 0) return reject('REMAINDER_NOT_ALLOWED', g.remainderMinor);
    }
    const remainder = base + walletUsed - charged;
    if (policy === 'REJECT' && remainder > 0) return reject('REMAINDER_NOT_ALLOWED', remainder);
    const remainderAction = remainder === 0 ? 'NONE' : policy === 'REFUND' ? 'REFUND_DUE' : 'HELD';

    const txnId = randomUUID();
    const paymentId = randomUUID();
    const t = input.tableId;
    const entries: Entry[] = [{ account: input.fundingAccount ?? ASSET[input.source], unit: 'KES', amount: input.amountMinor, tableId: t }];
    if (discount > 0) entries.push({ account: A.discounts, unit: 'KES', amount: discount, tableId: t, memo: 'discount' });
    if (walletUsed > 0) entries.push({ account: A.wallet(t, owner), unit: 'KES', amount: walletUsed, tableId: t, memo: 'wallet credit applied' });
    if (charged > 0) entries.push({ account: A.revenue(t), unit: 'KES', amount: -charged, tableId: t });
    if (remainder > 0) {
      entries.push({ account: remainderAction === 'REFUND_DUE' ? A.refundDue : A.wallet(t, owner), unit: 'KES', amount: -remainder, tableId: t, memo: 'remainder' });
    }
    if (games > 0) {
      entries.push({ account: A.gamesIssued, unit: 'GAME', amount: -games, tableId: t });
      entries.push({ account: A.gamesAvail(t), unit: 'GAME', amount: games, tableId: t });
    }
    postTxn(db, { txnId, refType: 'payment', refId: paymentId, entries, at: at.toISOString() });
    db.run(
      `INSERT INTO payments(id,source,ref_namespace,external_ref,idempotency_key,table_id,owner_ref,amount_minor,games_credited,
         charged_minor,wallet_used_minor,remainder_minor,remainder_action,ledger_txn_id,created_at,attendant_id,shift_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      paymentId, input.source, ns, input.externalRef, input.idempotencyKey, t, input.ownerRef ?? null, input.amountMinor, games,
      charged, walletUsed, remainder, remainderAction, txnId, at.toISOString(), input.attendantId ?? null, input.shiftId ?? null,
    );
    appendAudit(db, at, { actor: input.actor, action: 'payment.credited', entityType: 'payment', entityId: paymentId,
      data: { source: input.source, externalRef: input.externalRef, tableId: t, amountMinor: input.amountMinor, games, remainder, remainderAction } });
    return { status: 'CREDITED', paymentId, games, chargedMinor: charged, remainderMinor: remainder, remainderAction, walletUsedMinor: walletUsed, duplicate: false };
  });
}

export function availableGames(ctx: Ctx, tableId: string): number {
  return balance(ctx.db, A.gamesAvail(tableId));
}
