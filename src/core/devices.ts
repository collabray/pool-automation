import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { decryptSecret } from './crypto.ts';
import { recordCoins } from './coins.ts';
import { raiseAlert } from './alerts.ts';
import { getInt } from './settings.ts';
import { commandsForDevice, dispatch, handleAck, onDeviceReconnect, reportReady, setOffline, type AckInput, type Dispatched } from './vend.ts';
import { sweep, grantGame } from './vend.ts';
import { rateLimit } from './ratelimit.ts';

export class DeviceAuthError extends Error {
  code: 'UNKNOWN_DEVICE' | 'BAD_TIMESTAMP' | 'BAD_SIGNATURE' | 'REPLAY' | 'BAD_FORMAT';
  constructor(code: DeviceAuthError['code']) { super(code); this.code = code; }
}
const MAX_SKEW_MS = 120_000;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Request signature: HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nSHA256(body)). The same recipe is implemented in firmware. */
export function signDeviceRequest(secret: string, method: string, path: string, ts: number, nonce: string, body: string): string {
  return createHmac('sha256', secret).update(`${method}\n${path}\n${ts}\n${nonce}\n${sha(body)}`).digest('hex');
}
/** Response signature so the device can authenticate the server independently of TLS. */
export function signDeviceResponse(secret: string, nonce: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(`resp\n${nonce}\n${sha(body)}`).digest('hex');
}

export function verifyDeviceRequest(ctx: Ctx, r: { deviceId: string; ts: string; nonce: string; sig: string; method: string; path: string; body: string }): { tableId: string; secret: string } {
  if (!/^dev_[0-9a-f]{12}$/.test(r.deviceId) || !/^\d{10,16}$/.test(r.ts) || !/^[0-9a-f]{32}$/.test(r.nonce) || !/^[0-9a-f]{64}$/.test(r.sig)) throw new DeviceAuthError('BAD_FORMAT');
  const t = ctx.db.get<{ id: string; device_secret_enc: string | null }>('SELECT id, device_secret_enc FROM pool_tables WHERE device_id=?', r.deviceId);
  if (!t?.device_secret_enc) throw new DeviceAuthError('UNKNOWN_DEVICE');
  const secret = decryptSecret(t.device_secret_enc, ctx.masterKey);
  const want = Buffer.from(signDeviceRequest(secret, r.method, r.path, Number(r.ts), r.nonce, r.body), 'hex');
  const got = Buffer.from(r.sig, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new DeviceAuthError('BAD_SIGNATURE');
  const now = ctx.now().getTime();
  if (Math.abs(now - Number(r.ts)) > MAX_SKEW_MS) throw new DeviceAuthError('BAD_TIMESTAMP');
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM device_nonces WHERE expires_ms<?', now);
    const ins = ctx.db.run('INSERT OR IGNORE INTO device_nonces(device_id,nonce,expires_ms) VALUES (?,?,?)', r.deviceId, r.nonce, now + 2 * MAX_SKEW_MS);
    if (ins.changes === 0) throw new DeviceAuthError('REPLAY');
  });
  return { tableId: t.id, secret };
}

export interface SyncPayload {
  fw?: string; uptimeS?: number; rssi?: number; freeHeap?: number; resetReason?: string;
  sensors?: { ready?: boolean; tamper?: boolean; [k: string]: unknown };
  acks?: AckInput[];
  events?: { id: string; kind: 'coin' | 'tamper' | 'tamper_clear' | 'unauthorized_vend' | 'sensor_fault' | 'vend_done' | 'manual_request'; data?: Record<string, unknown> }[];
}
export interface SyncResult { commands: Dispatched[]; ackResults: unknown[]; config: Record<string, unknown> }
const BAD_RESETS = new Set(['poweron', 'brownout', 'panic', 'wdt', 'int_wdt', 'task_wdt']);

/** One device round-trip: telemetry + acks + events in, signed commands out. Everything is idempotent per event/ack. */
export function processSync(ctx: Ctx, tableId: string, deviceId: string, p: SyncPayload): SyncResult {
  return ctx.db.tx(() => {
    const before = ctx.db.get<{ online: number; ready: number; tamper: number; requires_ready_sensor: number; last_reset_reason: string | null; uptime_s: number | null }>('SELECT online, ready, tamper, requires_ready_sensor, last_reset_reason, uptime_s FROM pool_tables WHERE id=?', tableId)!;
    const rebooted = p.uptimeS !== undefined && before.uptime_s !== null && p.uptimeS < before.uptime_s;
    ctx.db.run(`UPDATE pool_tables SET last_seen_at=?, fw_version=COALESCE(?,fw_version), rssi=?, free_heap=?, uptime_s=?, last_reset_reason=COALESCE(?,last_reset_reason), sensors_json=? WHERE id=?`,
      ctx.now().toISOString(), p.fw ?? null, p.rssi ?? null, p.freeHeap ?? null, p.uptimeS ?? null, p.resetReason ?? null, JSON.stringify(p.sensors ?? {}), tableId);
    if (rebooted && p.resetReason && BAD_RESETS.has(p.resetReason) && p.resetReason !== 'poweron') raiseAlert(ctx, 'DEVICE_RESET', 'MEDIUM', tableId, `Device restarted unexpectedly (${p.resetReason}).`, 600_000);
    if (rebooted) {
      ctx.db.run('INSERT OR IGNORE INTO device_events(device_id,event_id,kind,data_json,at) VALUES (?,?,?,?,?)', deviceId, `boot-${ctx.now().getTime()}`, 'boot', JSON.stringify({ reason: p.resetReason }), ctx.now().toISOString());
      const since = new Date(ctx.now().getTime() - 3_600_000).toISOString();
      const boots = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM device_events WHERE device_id=? AND kind='boot' AND at>=?`, deviceId, since)!.n;
      if (boots >= 3) raiseAlert(ctx, 'POWER_CYCLING', 'HIGH', tableId, `Device restarted ${boots} times in the last hour.`, 3_600_000);
    }
    if (!before.online) onDeviceReconnect(ctx, tableId);

    const ackResults = (p.acks ?? []).map((a) => { try { return handleAck(ctx, a); } catch (e) { return { ok: false, reason: (e as Error).message }; } });

    for (const ev of p.events ?? []) {
      const fresh = ctx.db.run('INSERT OR IGNORE INTO device_events(device_id,event_id,kind,data_json,at) VALUES (?,?,?,?,?)', deviceId, ev.id, ev.kind, JSON.stringify(ev.data ?? {}), ctx.now().toISOString()).changes === 1;
      if (!fresh) continue;
      if (ev.kind === 'coin') recordCoins(ctx, tableId, ev.id, Number(ev.data?.coins ?? 1));
      else if (ev.kind === 'tamper') { ctx.db.run('UPDATE pool_tables SET tamper=1 WHERE id=?', tableId); raiseAlert(ctx, 'TAMPER', 'HIGH', tableId, 'Coin box door / tamper switch opened.', 0); }
      else if (ev.kind === 'tamper_clear') ctx.db.run('UPDATE pool_tables SET tamper=0 WHERE id=?', tableId);
      else if (ev.kind === 'unauthorized_vend') raiseAlert(ctx, 'VEND_WITHOUT_PAYMENT', 'HIGH', tableId, 'Table released balls without a paid credit or coin.', 0);
      else if (ev.kind === 'manual_request') {
        // The physical test button is only a REQUEST. The server decides: feature must be enabled, it is rate limited, always audit-logged and alerted.
        const en = ctx.db.get<{ manual_vend_enabled: number }>('SELECT manual_vend_enabled FROM pool_tables WHERE id=?', tableId)!.manual_vend_enabled;
        if (!en) raiseAlert(ctx, 'MANUAL_BUTTON_DISABLED', 'MEDIUM', tableId, 'Physical test button pressed while manual vend is disabled (ignored).', 600_000);
        else if (!rateLimit(ctx, `btn:${tableId}`, 3, 3_600_000)) raiseAlert(ctx, 'MANUAL_BUTTON_LIMIT', 'MEDIUM', tableId, 'Physical test button limit reached (3 per hour).', 3_600_000);
        else { const owner = ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE role='owner' AND active=1 LIMIT 1`); if (owner) { grantGame(ctx, { tableId, actorId: owner.id, reason: 'Physical test button' }); raiseAlert(ctx, 'MANUAL_BUTTON_USED', 'LOW', tableId, 'A game was released with the physical test button.', 0); } }
      }
      else if (ev.kind === 'sensor_fault') raiseAlert(ctx, 'SENSOR_FAULT', 'MEDIUM', tableId, `Sensor fault: ${JSON.stringify(ev.data ?? {})}`, 3_600_000);
    }
    if (before.requires_ready_sensor && typeof p.sensors?.ready === 'boolean' && p.sensors.ready !== !!before.ready) reportReady(ctx, tableId, p.sensors.ready);
    dispatch(ctx, tableId, 'device');
    const t = ctx.db.get<{ vend_mode: string; vend_params_json: string; manual_vend_enabled: number; confirm_by_sensor: number; requires_ready_sensor: number }>('SELECT vend_mode, vend_params_json, manual_vend_enabled, confirm_by_sensor, requires_ready_sensor FROM pool_tables WHERE id=?', tableId)!;
    const rel = p.fw ? ctx.db.get<{ version: string; sha256: string; signature: string; size: number }>('SELECT version, sha256, signature, size FROM firmware_releases WHERE active=1 AND version<>?', p.fw) : undefined;
    return { commands: commandsForDevice(ctx, tableId), ackResults,
      config: { ...(rel ? { ota: { version: rel.version, sha256: rel.sha256, signature: rel.signature, size: rel.size } } : {}), vendMode: t.vend_mode, vendParams: JSON.parse(t.vend_params_json), manualVendEnabled: !!t.manual_vend_enabled, confirmBySensor: !!t.confirm_by_sensor, requiresReadySensor: !!t.requires_ready_sensor, heartbeatSec: 10, serverTimeMs: ctx.now().getTime() } };
  });
}

/** Periodic watchdog. Pure DB work except where a Daraja client is supplied. */
export function monitorTables(ctx: Ctx): { wentOffline: string[]; swept: { resent: number; failed: number } } {
  const offlineAfter = getInt(ctx, 'device.offline_after_ms');
  const now = ctx.now().getTime();
  const wentOffline: string[] = [];
  for (const t of ctx.db.all<{ id: string; name: string; online: number; last_seen_at: string | null }>('SELECT id, name, online, last_seen_at FROM pool_tables WHERE device_id IS NOT NULL')) {
    if (t.online && (!t.last_seen_at || now - Date.parse(t.last_seen_at) > offlineAfter)) {
      setOffline(ctx, t.id); wentOffline.push(t.id);
      raiseAlert(ctx, 'DEVICE_OFFLINE', 'HIGH', t.id, `${t.name} went offline.`, 600_000);
    }
    const credits = ctx.db.get<{ b: number }>(`SELECT COALESCE(SUM(amount),0) b FROM ledger_entries WHERE account=?`, `games:table:${t.id}`)!.b;
    const delay = getInt(ctx, 'device.credits_waiting_alert_ms');
    if (!t.online && credits > 0 && t.last_seen_at && now - Date.parse(t.last_seen_at) > delay) raiseAlert(ctx, 'CREDITS_WAITING_OFFLINE', 'HIGH', t.id, `${t.name} is offline with ${credits} paid game(s) waiting.`, 3_600_000);
    const failures = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM vend_events e JOIN vends v ON v.id=e.vend_id WHERE v.table_id=? AND e.to_state='FAILED' AND e.at>=?`, t.id, new Date(now - 3_600_000).toISOString())!.n;
    if (failures >= 3) raiseAlert(ctx, 'REPEATED_VEND_FAILURES', 'HIGH', t.id, `${failures} vend failures in the last hour on ${t.name}.`, 3_600_000);
    const rate = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM vends WHERE table_id=? AND created_at>=?`, t.id, new Date(now - 3_600_000).toISOString())!.n;
    if (rate > getInt(ctx, 'vend.max_per_hour')) raiseAlert(ctx, 'UNUSUAL_VEND_RATE', 'MEDIUM', t.id, `${rate} vends in the last hour on ${t.name}.`, 3_600_000);
  }
  const s = sweep(ctx);
  return { wentOffline, swept: { resent: s.resent.length, failed: s.failed.length } };
}
