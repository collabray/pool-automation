import type { Ctx } from './ctx.ts';

/** Sliding-window limiter stored in the DB so limits hold across restarts and processes. Returns true if allowed (and records the hit). */
export function rateLimit(ctx: Ctx, key: string, limit: number, windowMs: number): boolean {
  return ctx.db.tx(() => {
    const now = ctx.now().getTime();
    ctx.db.run('DELETE FROM rate_events WHERE key=? AND at_ms<?', key, now - windowMs);
    const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM rate_events WHERE key=?', key)!.n;
    if (n >= limit) return false;
    ctx.db.run('INSERT INTO rate_events(key, at_ms) VALUES (?,?)', key, now);
    return true;
  });
}

export function pruneRateEvents(ctx: Ctx, olderThanMs = 86_400_000): void {
  ctx.db.run('DELETE FROM rate_events WHERE at_ms<?', ctx.now().getTime() - olderThanMs);
}
