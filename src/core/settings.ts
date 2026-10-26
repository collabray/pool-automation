import type { Ctx } from './ctx.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';

export const DEFAULTS: Record<string, string> = {
  'c2b.auto_credit': '0',            // owner opt-in; OFF by default
  'stk.expiry_ms': '90000',          // how long the customer screen waits
  'stk.late_window_ms': '3600000',   // keep reconciling this long after timeout
  'stk.verify_with_query': '1',
  'stk.cooldown_ms': '15000',
  'limits.stk_per_phone_hour': '6',
  'limits.stk_per_ip_hour': '30',
  'limits.stk_per_table_hour': '60',
  'cash.variance_threshold_minor': '5000', // KES 50
  'cash.offline_enabled': '0',
  'cash.offline_max_minor': '200000',
  'callback.ip_allowlist': '',
  'device.offline_after_ms': '90000',
  'device.credits_waiting_alert_ms': '600000',
  'vend.max_per_hour': '40',
  'coins.variance_threshold_minor': '0',
  'manual.max_per_shift': '3',
  'notify.min_severity': 'HIGH',
  'retention.phone_days': '90',
  'business.name': 'Pool Table',
  'public.base_url': '',
  'brand.color': '#0b6e4f',       // comma separated; empty = not enforced
};

export function getSetting(ctx: Ctx, key: string): string {
  return ctx.db.get<{ value: string }>('SELECT value FROM settings WHERE key=?', key)?.value ?? DEFAULTS[key] ?? '';
}
export function getInt(ctx: Ctx, key: string): number { return Number(getSetting(ctx, key)); }
export function setSetting(ctx: Ctx, key: string, value: string): void {
  ctx.db.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
}
export function setSecretSetting(ctx: Ctx, key: string, plain: string): void { setSetting(ctx, key, encryptSecret(plain, ctx.masterKey)); }
export function getSecretSetting(ctx: Ctx, key: string): string | null {
  const v = ctx.db.get<{ value: string }>('SELECT value FROM settings WHERE key=?', key)?.value;
  return v ? decryptSecret(v, ctx.masterKey) : null;
}
