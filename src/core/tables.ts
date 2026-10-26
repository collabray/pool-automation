import { randomBytes, randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { encryptSecret } from './crypto.ts';
import { parseVendParams, type VendMode } from './command.ts';
import { parsePricing } from './pricing.ts';
import { newPublicCode } from './tablecode.ts';

export interface CreateTableInput {
  id?: string;
  name: string;
  kind?: string;
  vendMode: VendMode;
  vendParams?: Record<string, unknown>;
  pricing: Record<string, unknown>;
  releaseMode?: 'ONE' | 'ALL';
  requiresReadySensor?: boolean;
  confirmBySensor?: boolean;
  vendTimeoutMs?: number;
  maxVendAttempts?: number;
  commandTtlMs?: number;
  actor: string;
}

/** Creates a table and its device credentials. The returned deviceSecret is shown once; only its encryption is stored. */
export function createTable(ctx: Ctx, i: CreateTableInput): { tableId: string; deviceId: string; deviceSecret: string } {
  if (!i.name.trim()) throw new Error('table name is required');
  parseVendParams(i.vendMode, i.vendParams ?? {});
  parsePricing(i.pricing);
  const tableId = i.id ?? randomUUID();
  const deviceId = 'dev_' + randomBytes(6).toString('hex');
  const deviceSecret = randomBytes(32).toString('hex');
  const at = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO pool_tables(id,name,kind,vend_mode,vend_params_json,pricing_json,release_mode,requires_ready_sensor,
         confirm_by_sensor,vend_timeout_ms,max_vend_attempts,command_ttl_ms,device_id,device_secret_enc,created_at,updated_at,public_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tableId, i.name.trim(), i.kind ?? 'pool', i.vendMode, JSON.stringify(i.vendParams ?? {}), JSON.stringify(i.pricing),
      i.releaseMode ?? 'ONE', i.requiresReadySensor ? 1 : 0, i.confirmBySensor ? 1 : 0, i.vendTimeoutMs ?? 15000,
      i.maxVendAttempts ?? 3, i.commandTtlMs ?? 30000, deviceId, encryptSecret(deviceSecret, ctx.masterKey), at, at, newPublicCode(),
    );
    appendAudit(ctx.db, ctx.now(), { actor: i.actor, action: 'table.created', entityType: 'table', entityId: tableId, data: { name: i.name, vendMode: i.vendMode } });
  });
  return { tableId, deviceId, deviceSecret };
}

export interface UpdateTableInput {
  name?: string; status?: 'ACTIVE' | 'DISABLED'; pricing?: Record<string, unknown>; vendParams?: Record<string, unknown>; vendMode?: VendMode;
  releaseMode?: 'ONE' | 'ALL'; requiresReadySensor?: boolean; confirmBySensor?: boolean; vendTimeoutMs?: number; maxVendAttempts?: number;
  commandTtlMs?: number; coinValueMinor?: number; manualVendEnabled?: boolean;
}
/** Whitelisted, validated update (no mass assignment: unknown keys never reach SQL). */
export function updateTable(ctx: Ctx, tableId: string, u: UpdateTableInput, actor: string): void {
  ctx.db.tx(() => {
    const cur = ctx.db.get<{ vend_mode: VendMode; vend_params_json: string }>('SELECT vend_mode, vend_params_json FROM pool_tables WHERE id=?', tableId);
    if (!cur) throw new Error('table not found');
    const sets: string[] = []; const vals: (string | number)[] = [];
    const set = (col: string, v: string | number) => { sets.push(`${col}=?`); vals.push(v); };
    if (u.name !== undefined) { if (!u.name.trim()) throw new Error('name required'); set('name', u.name.trim()); }
    if (u.status !== undefined) set('status', u.status);
    if (u.pricing !== undefined) { parsePricing(u.pricing); set('pricing_json', JSON.stringify(u.pricing)); }
    if (u.vendMode !== undefined || u.vendParams !== undefined) {
      const mode = u.vendMode ?? cur.vend_mode; const params = u.vendParams ?? JSON.parse(cur.vend_params_json);
      parseVendParams(mode, params); set('vend_mode', mode); set('vend_params_json', JSON.stringify(params));
    }
    if (u.releaseMode !== undefined) set('release_mode', u.releaseMode);
    if (u.requiresReadySensor !== undefined) set('requires_ready_sensor', u.requiresReadySensor ? 1 : 0);
    if (u.confirmBySensor !== undefined) set('confirm_by_sensor', u.confirmBySensor ? 1 : 0);
    if (u.vendTimeoutMs !== undefined) set('vend_timeout_ms', u.vendTimeoutMs);
    if (u.maxVendAttempts !== undefined) set('max_vend_attempts', u.maxVendAttempts);
    if (u.commandTtlMs !== undefined) set('command_ttl_ms', u.commandTtlMs);
    if (u.coinValueMinor !== undefined) set('coin_value_minor', u.coinValueMinor);
    if (u.manualVendEnabled !== undefined) set('manual_vend_enabled', u.manualVendEnabled ? 1 : 0);
    if (!sets.length) return;
    ctx.db.run(`UPDATE pool_tables SET ${sets.join(', ')}, updated_at=? WHERE id=?`, ...vals, ctx.now().toISOString(), tableId);
    appendAudit(ctx.db, ctx.now(), { actor, action: 'table.updated', entityType: 'table', entityId: tableId, data: { fields: Object.keys(u) } });
  });
}

/** Issues a new device secret (shown once). The old one stops working immediately. */
export function rotateDeviceSecret(ctx: Ctx, tableId: string, actor: string): { deviceId: string; deviceSecret: string } {
  const deviceSecret = randomBytes(32).toString('hex');
  return ctx.db.tx(() => {
    const t = ctx.db.get<{ device_id: string }>('SELECT device_id FROM pool_tables WHERE id=?', tableId);
    if (!t) throw new Error('table not found');
    ctx.db.run('UPDATE pool_tables SET device_secret_enc=?, updated_at=? WHERE id=?', encryptSecret(deviceSecret, ctx.masterKey), ctx.now().toISOString(), tableId);
    appendAudit(ctx.db, ctx.now(), { actor, action: 'table.device_secret_rotated', entityType: 'table', entityId: tableId });
    return { deviceId: t.device_id, deviceSecret };
  });
}
