import type { Db } from './db.ts';

export class LedgerError extends Error {}

export type Unit = 'KES' | 'GAME';
export interface Entry { account: string; unit: Unit; amount: number; tableId?: string | null; memo?: string | null }

/** Account naming. Asset/expense-like accounts are positive-normal; revenue/liability/issuance are negative-normal. */
export const A = {
  mpesa: 'asset:mpesa',
  cash: 'asset:cash',
  voucher: 'asset:voucher',
  revenue: (t: string) => `revenue:pool:${t}`,
  wallet: (t: string, owner: string) => `liability:credit:${t}:${owner}`,
  refundDue: 'liability:refund_due',
  unallocated: 'liability:unallocated',
  discounts: 'expense:discounts',
  reversalLoss: 'expense:reversal_loss',
  cashChange: 'asset:cash',
  coinbox: 'asset:coinbox',
  coinVariance: 'expense:coin_variance',
  gamesIssued: 'games:issued',
  gamesAvail: (t: string) => `games:table:${t}`,
  gamesInflight: (t: string) => `games:inflight:${t}`,
  gamesVended: (t: string) => `games:vended:${t}`,
  gamesRefunded: (t: string) => `games:refunded:${t}`,
} as const;

/** Balance guards enforced inside every posting transaction: a safety net against double-spend bugs. */
const SIGN_RULES: { prefix: string; rule: 'nonneg' | 'nonpos' }[] = [
  { prefix: 'games:table:', rule: 'nonneg' },
  { prefix: 'games:inflight:', rule: 'nonneg' },
  { prefix: 'liability:credit:', rule: 'nonpos' },
  { prefix: 'liability:unallocated', rule: 'nonpos' },
];

export function balance(db: Db, account: string): number {
  return db.get<{ b: number }>('SELECT COALESCE(SUM(amount),0) AS b FROM ledger_entries WHERE account=?', account)!.b;
}

export function postTxn(
  db: Db,
  t: { txnId: string; refType: string; refId: string; entries: Entry[]; at: string },
): void {
  if (!db.inTx) throw new LedgerError('postTxn must run inside a transaction');
  if (t.entries.length < 2) throw new LedgerError('a ledger transaction needs at least two entries');
  const sums: Record<Unit, number> = { KES: 0, GAME: 0 };
  for (const e of t.entries) {
    if (!Number.isSafeInteger(e.amount) || e.amount === 0) throw new LedgerError('entry amount must be a non-zero integer');
    if (e.unit !== 'KES' && e.unit !== 'GAME') throw new LedgerError('invalid unit');
    sums[e.unit] += e.amount;
  }
  if (sums.KES !== 0 || sums.GAME !== 0) throw new LedgerError(`unbalanced transaction (KES ${sums.KES}, GAME ${sums.GAME})`);
  for (const e of t.entries) {
    db.run(
      `INSERT INTO ledger_entries(txn_id, account, unit, amount, table_id, ref_type, ref_id, memo, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      t.txnId, e.account, e.unit, e.amount, e.tableId ?? null, t.refType, t.refId, e.memo ?? null, t.at,
    );
  }
  for (const account of new Set(t.entries.map((e) => e.account))) {
    const rule = SIGN_RULES.find((r) => account.startsWith(r.prefix));
    if (!rule) continue;
    const b = balance(db, account);
    if ((rule.rule === 'nonneg' && b < 0) || (rule.rule === 'nonpos' && b > 0)) {
      throw new LedgerError(`balance rule violated for ${account} (${b})`);
    }
  }
}

/** Integrity check: every transaction must net to zero per unit. Returns offending txn ids. */
export function verifyLedger(db: Db): { txnId: string; unit: string; sum: number }[] {
  return db
    .all<{ txn_id: string; unit: string; s: number }>(
      'SELECT txn_id, unit, SUM(amount) AS s FROM ledger_entries GROUP BY txn_id, unit HAVING s <> 0',
    )
    .map((r) => ({ txnId: r.txn_id, unit: r.unit, sum: r.s }));
}
