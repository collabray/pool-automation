import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { migrate } from '../../src/core/migrate.ts';
import type { Ctx } from '../../src/core/ctx.ts';
import { createTable, type CreateTableInput } from '../../src/core/tables.ts';
import { kes } from '../../src/core/money.ts';

export const MIGRATIONS = join(import.meta.dirname, '..', '..', 'migrations');
export const MASTER_KEY = Buffer.alloc(32, 7);

export interface TestCtx extends Ctx { path: string; clock: { ms: number } }

export function newCtx(startIso = '2026-10-20T09:00:00Z'): TestCtx {
  const path = join(mkdtempSync(join(tmpdir(), 'pt-')), 'test.db');
  const db = new Db(path);
  migrate(db, MIGRATIONS);
  const clock = { ms: Date.parse(startIso) };
  return { db, path, clock, now: () => new Date(clock.ms), masterKey: MASTER_KEY };
}

export const basePricing = { unitPriceMinor: kes(20), bundles: [], peakWindows: [], minGames: 1, maxGames: 20, remainderPolicy: 'HOLD_CREDIT' };

export function makeTable(ctx: Ctx, o: Partial<CreateTableInput> = {}) {
  const r = createTable(ctx, { name: 'Table 1', vendMode: 'GATE_SOLENOID', pricing: basePricing, actor: 'test', ...o });
  ctx.db.run('UPDATE pool_tables SET online=1 WHERE id=?', r.tableId);
  return r;
}

export function addUser(ctx: Ctx, role: 'owner' | 'manager' | 'attendant', o: Record<string, unknown> = {}): string {
  const id = (o.id as string) ?? `u-${role}-${Math.random().toString(36).slice(2, 8)}`;
  ctx.db.run(`INSERT INTO users(id,username,display_name,role,void_limit_minor,discount_limit_minor,can_see_money,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, (o.username as string) ?? id, (o.name as string) ?? id, role, (o.voidLimit as number) ?? 50000, (o.discountLimit as number) ?? 2000, o.canSeeMoney === false ? 0 : 1, ctx.now().toISOString());
  return id;
}
