import type { Ctx } from './ctx.ts';

export type Period = 'today' | 'yesterday' | 'week' | 'month';
const OFFSET_MIN = 180; // Africa/Nairobi, no DST

/** Local-midnight boundaries as UTC ISO strings. Week starts Monday. */
export function periodRange(p: Period, now: Date, offsetMin = OFFSET_MIN): { from: string; to: string } {
  const local = new Date(now.getTime() + offsetMin * 60_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMin * 60_000;
  const day = 86_400_000;
  const dow = (local.getUTCDay() + 6) % 7;
  let from = midnight, to = midnight + day;
  if (p === 'yesterday') { from = midnight - day; to = midnight; }
  if (p === 'week') from = midnight - dow * day;
  if (p === 'month') from = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offsetMin * 60_000;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

interface SaleRow { id: string; source: string; amount_minor: number; games_credited: number; charged_minor: number; table_id: string; created_at: string; voided: number }
const hourOf = (iso: string, off = OFFSET_MIN) => new Date(Date.parse(iso) + off * 60_000).getUTCHours();
const dayOf = (iso: string, off = OFFSET_MIN) => new Date(Date.parse(iso) + off * 60_000).toISOString().slice(0, 10);

const SALES_SQL = `SELECT p.id, p.source, p.amount_minor, p.games_credited, p.charged_minor, p.table_id, p.created_at,
  CASE WHEN cs.status='VOIDED' OR EXISTS(SELECT 1 FROM ledger_entries l WHERE l.ref_type='payment_reversal' AND l.ref_id=p.id) THEN 1 ELSE 0 END AS voided
  FROM payments p LEFT JOIN cash_sales cs ON cs.payment_id=p.id`;

export interface AttendantStats {
  attendantId: string; from: string; to: string; moneyVisible: boolean;
  salesCount: number; gamesSold: number; totalMinor: number | null; averageSaleMinor: number | null;
  byMethod: Record<string, { sales: number; games: number; totalMinor: number | null }>;
  byTable: { tableId: string; name: string; games: number; totalMinor: number | null }[];
  byHour: { hour: number; sales: number; totalMinor: number | null }[];
  voids: { count: number; amountMinor: number | null };
  refunds: { count: number };
  variances: { shiftId: string; varianceMinor: number | null; flagged: boolean }[];
}

/** An attendant's own numbers. `moneyVisible=false` removes every money figure (owner-configurable permission). */
export function attendantStats(ctx: Ctx, attendantId: string, from: string, to: string, moneyVisible: boolean): AttendantStats {
  const m = (v: number) => (moneyVisible ? v : null);
  const rows = ctx.db.all<SaleRow>(`${SALES_SQL} WHERE p.attendant_id=? AND p.created_at>=? AND p.created_at<?`, attendantId, from, to);
  const live = rows.filter((r) => !r.voided);
  const money = (r: SaleRow) => r.charged_minor;
  const byMethod: AttendantStats['byMethod'] = {};
  for (const r of live) {
    const k = r.source === 'CASH' ? 'CASH' : r.source.startsWith('MPESA') ? 'MPESA' : 'VOUCHER';
    const x = (byMethod[k] ??= { sales: 0, games: 0, totalMinor: 0 });
    x.sales++; x.games += r.games_credited; x.totalMinor = (x.totalMinor ?? 0) + money(r);
  }
  for (const x of Object.values(byMethod)) x.totalMinor = x.totalMinor === null ? null : m(x.totalMinor);
  const tables = new Map<string, { games: number; total: number }>();
  const hours = new Map<number, { sales: number; total: number }>();
  for (const r of live) {
    const t = tables.get(r.table_id) ?? { games: 0, total: 0 }; t.games += r.games_credited; t.total += money(r); tables.set(r.table_id, t);
    const h = hours.get(hourOf(r.created_at)) ?? { sales: 0, total: 0 }; h.sales++; h.total += money(r); hours.set(hourOf(r.created_at), h);
  }
  const total = live.reduce((s, r) => s + money(r), 0);
  const voided = rows.filter((r) => r.voided);
  const vendRefunds = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM vend_events WHERE to_state='REFUNDED' AND actor=? AND at>=? AND at<?`, attendantId, from, to)!.n;
  const shifts = ctx.db.all<{ id: string; variance_minor: number; variance_flagged: number }>(`SELECT id, variance_minor, variance_flagged FROM shifts WHERE attendant_id=? AND status='CLOSED' AND closed_at>=? AND closed_at<?`, attendantId, from, to);
  return {
    attendantId, from, to, moneyVisible,
    salesCount: live.length, gamesSold: live.reduce((s, r) => s + r.games_credited, 0), totalMinor: m(total),
    averageSaleMinor: live.length ? m(Math.round(total / live.length)) : m(0), byMethod,
    byTable: [...tables].map(([tableId, v]) => ({ tableId, name: ctx.db.get<{ name: string }>('SELECT name FROM pool_tables WHERE id=?', tableId)?.name ?? tableId, games: v.games, totalMinor: m(v.total) })),
    byHour: [...hours].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, sales: v.sales, totalMinor: m(v.total) })),
    voids: { count: voided.length, amountMinor: m(voided.reduce((s, r) => s + r.amount_minor, 0)) },
    refunds: { count: vendRefunds },
    variances: shifts.map((s) => ({ shiftId: s.id, varianceMinor: m(s.variance_minor), flagged: !!s.variance_flagged })),
  };
}

export interface OwnerSummary {
  from: string; to: string;
  poolRevenueMinor: number; gamesSold: number; gamesPlayed: number; vendFailures: number; refundsMinor: number;
  byMethod: Record<string, { sales: number; games: number; totalMinor: number }>;
  byTable: { tableId: string; name: string; revenueMinor: number; gamesSold: number; gamesPlayed: number }[];
  byDay: { day: string; revenueMinor: number; games: number }[];
  byHour: { hour: number; revenueMinor: number; games: number }[];
  unallocated: { count: number; totalMinor: number; pendingCount: number; pendingMinor: number }; // other-business receipts, NOT pool revenue
}

export function ownerSummary(ctx: Ctx, from: string, to: string): OwnerSummary {
  const rows = ctx.db.all<SaleRow>(`${SALES_SQL} WHERE p.created_at>=? AND p.created_at<?`, from, to).filter((r) => !r.voided);
  const byMethod: OwnerSummary['byMethod'] = {};
  const tbl = new Map<string, { rev: number; sold: number }>(), day = new Map<string, { rev: number; g: number }>(), hr = new Map<number, { rev: number; g: number }>();
  for (const r of rows) {
    const k = r.source === 'CASH' ? 'CASH' : 'MPESA';
    const x = (byMethod[k] ??= { sales: 0, games: 0, totalMinor: 0 }); x.sales++; x.games += r.games_credited; x.totalMinor += r.charged_minor;
    const t = tbl.get(r.table_id) ?? { rev: 0, sold: 0 }; t.rev += r.charged_minor; t.sold += r.games_credited; tbl.set(r.table_id, t);
    const d = day.get(dayOf(r.created_at)) ?? { rev: 0, g: 0 }; d.rev += r.charged_minor; d.g += r.games_credited; day.set(dayOf(r.created_at), d);
    const h = hr.get(hourOf(r.created_at)) ?? { rev: 0, g: 0 }; h.rev += r.charged_minor; h.g += r.games_credited; hr.set(hourOf(r.created_at), h);
  }
  const v = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM vouchers WHERE status='REDEEMED' AND redeemed_at>=? AND redeemed_at<?`, from, to)!.n;
  const vg = ctx.db.get<{ g: number }>(`SELECT COALESCE(SUM(games),0) g FROM vouchers WHERE status='REDEEMED' AND redeemed_at>=? AND redeemed_at<?`, from, to)!.g;
  const coin = ctx.db.get<{ n: number; c: number; v: number }>(`SELECT COUNT(*) n, COALESCE(SUM(coins),0) c, COALESCE(SUM(value_minor),0) v FROM coin_events WHERE at>=? AND at<?`, from, to)!;
  if (coin.n) byMethod.COIN = { sales: coin.n, games: coin.c, totalMinor: coin.v };
  if (v) byMethod.VOUCHER = { sales: v, games: vg, totalMinor: 0 };
  const played = ctx.db.all<{ table_id: string; n: number }>(`SELECT table_id, COUNT(*) n FROM vends WHERE state='CONFIRMED' AND confirmed_at>=? AND confirmed_at<? GROUP BY table_id`, from, to);
  const playedMap = new Map(played.map((p) => [p.table_id, p.n]));
  const rev = -ctx.db.get<{ s: number }>(`SELECT COALESCE(SUM(amount),0) s FROM ledger_entries WHERE unit='KES' AND account LIKE 'revenue:pool:%' AND created_at>=? AND created_at<?`, from, to)!.s;
  const unalloc = ctx.db.get<{ c: number; t: number; pc: number; pt: number }>(
    `SELECT COUNT(*) c, COALESCE(SUM(amount_minor),0) t, COALESCE(SUM(status='UNALLOCATED'),0) pc, COALESCE(SUM(CASE WHEN status='UNALLOCATED' THEN amount_minor ELSE 0 END),0) pt FROM unallocated_payments WHERE received_at>=? AND received_at<?`, from, to)!;
  const names = new Map(ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM pool_tables').map((t) => [t.id, t.name]));
  const ids = new Set([...tbl.keys(), ...playedMap.keys()]);
  return {
    from, to, poolRevenueMinor: rev, gamesSold: rows.reduce((s, r) => s + r.games_credited, 0) + vg + coin.c, gamesPlayed: played.reduce((s, p) => s + p.n, 0),
    vendFailures: ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM vend_events WHERE to_state='FAILED' AND at>=? AND at<?`, from, to)!.n,
    refundsMinor: ctx.db.get<{ s: number }>(`SELECT COALESCE(SUM(value_minor),0) s FROM vends WHERE state='REFUNDED' AND updated_at>=? AND updated_at<?`, from, to)!.s,
    byMethod,
    byTable: [...ids].map((id) => ({ tableId: id, name: names.get(id) ?? id, revenueMinor: tbl.get(id)?.rev ?? 0, gamesSold: tbl.get(id)?.sold ?? 0, gamesPlayed: playedMap.get(id) ?? 0 })),
    byDay: [...day].sort().map(([d, x]) => ({ day: d, revenueMinor: x.rev, games: x.g })),
    byHour: [...hr].sort((a, b) => a[0] - b[0]).map(([h, x]) => ({ hour: h, revenueMinor: x.rev, games: x.g })),
    unallocated: { count: unalloc.c, totalMinor: unalloc.t, pendingCount: unalloc.pc, pendingMinor: unalloc.pt },
  };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

/** Flat sales listing for CSV/PDF export. attendantId=null means all (owner/manager only). */
export function salesRows(ctx: Ctx, from: string, to: string, attendantId: string | null): Record<string, unknown>[] {
  return ctx.db.all<Record<string, unknown>>(
    `SELECT p.created_at AS time, t.name AS "table", p.source AS method, p.external_ref AS reference, p.games_credited AS games,
            ROUND(p.charged_minor/100.0,2) AS amount_kes, COALESCE(u.username,'') AS attendant,
            CASE WHEN cs.status='VOIDED' THEN 'VOIDED' ELSE 'OK' END AS status
       FROM payments p JOIN pool_tables t ON t.id=p.table_id LEFT JOIN users u ON u.id=p.attendant_id LEFT JOIN cash_sales cs ON cs.payment_id=p.id
      WHERE p.created_at>=? AND p.created_at<? AND (? IS NULL OR p.attendant_id=?) ORDER BY p.created_at`, from, to, attendantId, attendantId);
}
