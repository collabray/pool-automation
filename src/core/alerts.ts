import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';

/** Inserts an alert unless an unresolved alert of the same kind+table was raised within dedupeMs (0 = never dedupe). */
export function raiseAlert(ctx: Ctx, kind: string, severity: 'LOW' | 'MEDIUM' | 'HIGH', tableId: string | null, message: string, dedupeMs = 3_600_000): boolean {
  return ctx.db.tx(() => {
    if (dedupeMs > 0) {
      const since = new Date(ctx.now().getTime() - dedupeMs).toISOString();
      if (ctx.db.get(`SELECT 1 FROM alerts WHERE kind=? AND COALESCE(table_id,'')=? AND resolved_at IS NULL AND created_at>=?`, kind, tableId ?? '', since)) return false;
    }
    ctx.db.run('INSERT INTO alerts(id,kind,severity,table_id,message,created_at) VALUES (?,?,?,?,?,?)', randomUUID(), kind, severity, tableId, message, ctx.now().toISOString());
    return true;
  });
}
export const listAlerts = (ctx: Ctx, onlyOpen = true) => ctx.db.all<Record<string, unknown>>(`SELECT id, kind, severity, table_id, message, created_at, resolved_at FROM alerts ${onlyOpen ? 'WHERE resolved_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 200`);
export const resolveAlert = (ctx: Ctx, id: string) => ctx.db.run('UPDATE alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL', ctx.now().toISOString(), id).changes;
