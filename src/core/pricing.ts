import { assertMinor } from './money.ts';

export class PricingError extends Error {}

export type RemainderPolicy = 'HOLD_CREDIT' | 'REFUND' | 'REJECT';
export interface Bundle { games: number; priceMinor: number }
/** days: 0=Sunday..6=Saturday (local time). Minutes are minutes after local midnight; start>end wraps midnight. */
export interface PeakWindow { days: number[]; startMin: number; endMin: number; priceMinor: number }
export interface PricingConfig {
  unitPriceMinor: number;
  bundles: Bundle[];
  peakWindows: PeakWindow[];
  utcOffsetMinutes: number; // Kenya: 180 (no DST)
  minGames: number;
  maxGames: number;
  remainderPolicy: RemainderPolicy;
}

const DP_LIMIT = 1000;

export function parsePricing(raw: unknown): PricingConfig {
  if (typeof raw !== 'object' || raw === null) throw new PricingError('pricing must be an object');
  const r = raw as Record<string, unknown>;
  const int = (v: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
      throw new PricingError(`${name} must be an integer between ${min} and ${max}`);
    }
    return v;
  };
  const unitPriceMinor = int(r.unitPriceMinor, 'unitPriceMinor', 1);
  const minGames = int(r.minGames ?? 1, 'minGames', 1, DP_LIMIT);
  const maxGames = int(r.maxGames ?? 20, 'maxGames', minGames, DP_LIMIT);
  const utcOffsetMinutes = int(r.utcOffsetMinutes ?? 180, 'utcOffsetMinutes', -720, 840);
  const policy = (r.remainderPolicy ?? 'HOLD_CREDIT') as string;
  if (!['HOLD_CREDIT', 'REFUND', 'REJECT'].includes(policy)) throw new PricingError('invalid remainderPolicy');
  const bundlesRaw = r.bundles ?? [];
  const windowsRaw = r.peakWindows ?? [];
  if (!Array.isArray(bundlesRaw) || !Array.isArray(windowsRaw)) throw new PricingError('bundles/peakWindows must be arrays');
  const bundles = bundlesRaw.map((b: Record<string, unknown>, i) => ({
    games: int(b.games, `bundles[${i}].games`, 2, DP_LIMIT),
    priceMinor: int(b.priceMinor, `bundles[${i}].priceMinor`, 1),
  }));
  const peakWindows = windowsRaw.map((w: Record<string, unknown>, i) => {
    const days = w.days;
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new PricingError(`peakWindows[${i}].days invalid`);
    }
    return {
      days: days as number[],
      startMin: int(w.startMin, `peakWindows[${i}].startMin`, 0, 1439),
      endMin: int(w.endMin, `peakWindows[${i}].endMin`, 0, 1440),
      priceMinor: int(w.priceMinor, `peakWindows[${i}].priceMinor`, 1),
    };
  });
  return { unitPriceMinor, bundles, peakWindows, utcOffsetMinutes, minGames, maxGames, remainderPolicy: policy as RemainderPolicy };
}

function localParts(cfg: PricingConfig, at: Date): { day: number; minute: number } {
  const local = new Date(at.getTime() + cfg.utcOffsetMinutes * 60_000);
  return { day: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** Price of a single (non-bundled) game at a point in time. First matching peak window wins. */
export function unitPriceAt(cfg: PricingConfig, at: Date): number {
  const { day, minute } = localParts(cfg, at);
  const prevDay = (day + 6) % 7;
  for (const w of cfg.peakWindows) {
    const wraps = w.startMin > w.endMin;
    let hit: boolean;
    if (!wraps) hit = w.days.includes(day) && minute >= w.startMin && minute < w.endMin;
    else if (minute >= w.startMin) hit = w.days.includes(day);
    else hit = w.days.includes(prevDay) && minute < w.endMin; // after midnight: belongs to the previous day's window
    if (hit) return w.priceMinor;
  }
  return cfg.unitPriceMinor;
}

export interface QuoteLine { kind: 'bundle' | 'single'; games: number; count: number; unitMinor: number; subtotalMinor: number }
export interface Quote { games: number; totalMinor: number; lines: QuoteLine[] }

/** cost[n] = cheapest price for exactly n games using singles and bundles. */
function costTable(cfg: PricingConfig, at: Date, upTo: number): { cost: number[]; choice: number[] } {
  const unit = unitPriceAt(cfg, at);
  const cost = new Array<number>(upTo + 1).fill(Infinity);
  const choice = new Array<number>(upTo + 1).fill(-1); // -1 single, else bundle index
  cost[0] = 0;
  for (let n = 1; n <= upTo; n++) {
    cost[n] = cost[n - 1] + unit;
    choice[n] = -1;
    cfg.bundles.forEach((b, i) => {
      if (b.games <= n && cost[n - b.games] + b.priceMinor < cost[n]) {
        cost[n] = cost[n - b.games] + b.priceMinor;
        choice[n] = i;
      }
    });
  }
  return { cost, choice };
}

export function quote(cfg: PricingConfig, games: number, at: Date): Quote {
  if (!Number.isInteger(games) || games < cfg.minGames || games > cfg.maxGames) {
    throw new PricingError(`games must be between ${cfg.minGames} and ${cfg.maxGames}`);
  }
  const unit = unitPriceAt(cfg, at);
  const { cost, choice } = costTable(cfg, at, games);
  const counts = new Map<number, number>();
  let n = games;
  while (n > 0) {
    const c = choice[n];
    counts.set(c, (counts.get(c) ?? 0) + 1);
    n -= c === -1 ? 1 : cfg.bundles[c].games;
  }
  const lines: QuoteLine[] = [];
  for (const [c, count] of counts) {
    if (c === -1) lines.push({ kind: 'single', games: 1, count, unitMinor: unit, subtotalMinor: count * unit });
    else {
      const b = cfg.bundles[c];
      lines.push({ kind: 'bundle', games: b.games, count, unitMinor: b.priceMinor, subtotalMinor: count * b.priceMinor });
    }
  }
  return { games, totalMinor: cost[games], lines };
}

/** Most games obtainable for an amount (no min/max applied) and what is left over. */
export function gamesForAmount(cfg: PricingConfig, amountMinor: number, at: Date): { games: number; costMinor: number; remainderMinor: number } {
  assertMinor(amountMinor);
  if (amountMinor < 0) throw new PricingError('amount must not be negative');
  const unit = unitPriceAt(cfg, at);
  const cheapest = Math.min(unit, ...cfg.bundles.map((b) => b.priceMinor / b.games));
  const upTo = Math.min(DP_LIMIT, Math.floor(amountMinor / cheapest));
  const { cost } = costTable(cfg, at, upTo);
  let best = 0;
  for (let n = 1; n <= upTo; n++) if (cost[n] <= amountMinor) best = n;
  return { games: best, costMinor: cost[best], remainderMinor: amountMinor - cost[best] };
}

/** Conservative per-game value used when refunding a single game: never more than the customer could have paid. */
export function minGameValueMinor(cfg: PricingConfig, at: Date): number {
  const unit = unitPriceAt(cfg, at);
  return Math.floor(Math.min(unit, ...cfg.bundles.map((b) => b.priceMinor / b.games)));
}
