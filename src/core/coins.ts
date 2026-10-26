import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { A, postTxn, type Entry } from './ledger.ts';
import { getInt } from './settings.ts';
import { raiseAlert } from './alerts.ts';

/** Real coins counted at the acceptor. Cash games with no server payment; idempotent per (table, device event id). */
export function recordCoins(ctx: Ctx, tableId: string, deviceEventId: string, coins: number): { recorded: boolean } {
  if (!Number.isInteger(coins) || coins < 1 || coins > 50) throw new Error('coin count out of range');
  return ctx.db.tx(() => {
    const t = ctx.db.get<{ coin_value_minor: number }>('SELECT coin_value_minor FROM pool_tables WHERE id=?', tableId);
    if (!t) throw new Error('unknown table');
    const id = randomUUID(); const value = t.coin_value_minor * coins; const at = ctx.now().toISOString();
    const r = ctx.db.run('INSERT OR IGNORE INTO coin_events(id,table_id,device_event_id,coins,value_minor,at) VALUES (?,?,?,?,?,?)', id, tableId, deviceEventId, coins, value, at);
    if (r.changes === 0) return { recorded: false };
    postTxn(ctx.db, { txnId: randomUUID(), refType: 'coin', refId: id, at, entries: [
      { account: A.coinbox, unit: 'KES', amount: value, tableId }, { account: A.revenue(tableId), unit: 'KES', amount: -value, tableId, memo: 'coins' }] });
    return { recorded: true };
  });
}

/** Coin-box collection: expected (from counted coins) vs actually counted cash. Any mismatch is flagged and alerted. */
export function collectCoinBox(ctx: Ctx, a: { tableId: string; actorId: string; countedMinor: number; note?: string }): { expectedCoins: number; expectedMinor: number; countedMinor: number; varianceMinor: number; flagged: boolean } {
  if (!Number.isInteger(a.countedMinor) || a.countedMinor < 0) throw new Error('counted must be a non-negative integer');
  return ctx.db.tx(() => {
    const u = ctx.db.get<{ role: string; active: number }>('SELECT role, active FROM users WHERE id=?', a.actorId);
    if (!u || !u.active) throw new Error('forbidden');
    const agg = ctx.db.get<{ c: number; v: number }>('SELECT COALESCE(SUM(coins),0) c, COALESCE(SUM(value_minor),0) v FROM coin_events WHERE table_id=? AND collection_id IS NULL', a.tableId)!;
    const variance = a.countedMinor - agg.v;
    const flagged = Math.abs(variance) > getInt(ctx, 'coins.variance_threshold_minor');
    const id = randomUUID(); const at = ctx.now().toISOString();
    ctx.db.run('INSERT INTO coin_collections(id,table_id,collected_by,collected_at,expected_coins,expected_minor,counted_minor,variance_minor,flagged,note) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, a.tableId, a.actorId, at, agg.c, agg.v, a.countedMinor, variance, flagged ? 1 : 0, a.note ?? null);
    ctx.db.run('UPDATE coin_events SET collection_id=? WHERE table_id=? AND collection_id IS NULL', id, a.tableId);
    const e: Entry[] = [];
    if (agg.v) e.push({ account: A.coinbox, unit: 'KES', amount: -agg.v, tableId: a.tableId });
    if (a.countedMinor) e.push({ account: A.cash, unit: 'KES', amount: a.countedMinor, tableId: a.tableId });
    if (variance !== 0) e.push({ account: A.coinVariance, unit: 'KES', amount: -variance, tableId: a.tableId });
    if (e.length >= 2) postTxn(ctx.db, { txnId: randomUUID(), refType: 'coin_collection', refId: id, at, entries: e });
    if (flagged) raiseAlert(ctx, 'COIN_BOX_MISMATCH', 'HIGH', a.tableId, `Coin box collection variance ${variance} minor units (expected ${agg.v}, counted ${a.countedMinor}).`, 0);
    appendAudit(ctx.db, ctx.now(), { actor: a.actorId, action: 'coins.collected', entityType: 'table', entityId: a.tableId, data: { expected: agg.v, counted: a.countedMinor, variance, flagged } });
    return { expectedCoins: agg.c, expectedMinor: agg.v, countedMinor: a.countedMinor, varianceMinor: variance, flagged };
  });
}
