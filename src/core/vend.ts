import { randomBytes, randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { decryptSecret } from './crypto.ts';
import {
  parseVendParams, signCommand, verifyAck,
  type AckStatus, type VendCommand, type VendMode,
} from './command.ts';
import { A, balance, postTxn, type Entry } from './ledger.ts';
import { minGameValueMinor, parsePricing } from './pricing.ts';
import { assertTransition, type VendState } from './vend-state.ts';

export class VendError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

interface TableRow {
  id: string; status: string; fault_reason: string | null; online: number; ready: number;
  requires_ready_sensor: number; confirm_by_sensor: number; release_mode: 'ONE' | 'ALL';
  vend_mode: VendMode; vend_params_json: string; pricing_json: string; vend_timeout_ms: number;
  max_vend_attempts: number; command_ttl_ms: number; device_id: string | null; device_secret_enc: string | null;
}
interface VendRow {
  id: string; table_id: string; seq: number; state: VendState; attempts: number; value_minor: number;
  sent_at: string | null; acked_at: string | null;
}
export interface Dispatched { vendId: string; deviceId: string; command: VendCommand; signature: string }

const getTable = (ctx: Ctx, id: string): TableRow => {
  const t = ctx.db.get<TableRow>('SELECT * FROM pool_tables WHERE id=?', id);
  if (!t) throw new VendError('UNKNOWN_TABLE', 'table does not exist');
  return t;
};
const getVend = (ctx: Ctx, id: string): VendRow => {
  const v = ctx.db.get<VendRow>('SELECT * FROM vends WHERE id=?', id);
  if (!v) throw new VendError('UNKNOWN_VEND', 'vend does not exist');
  return v;
};
const iso = (ctx: Ctx) => ctx.now().toISOString();

function alert(ctx: Ctx, kind: string, severity: 'LOW' | 'MEDIUM' | 'HIGH', tableId: string, message: string): void {
  ctx.db.run('INSERT INTO alerts(id,kind,severity,table_id,message,created_at) VALUES (?,?,?,?,?,?)',
    randomUUID(), kind, severity, tableId, message, iso(ctx));
}

/** Ledger side effects of a state change. Game credits move: available -> inflight -> vended | available | refunded. */
function ledgerFor(v: VendRow, to: VendState): Entry[] | null {
  const t = v.table_id;
  const g = (account: string, amount: number): Entry => ({ account, unit: 'GAME', amount, tableId: t });
  if (to === 'CONFIRMED') return [g(A.gamesInflight(t), -1), g(A.gamesVended(t), 1)];
  if (to === 'CANCELLED') return [g(A.gamesInflight(t), -1), g(A.gamesAvail(t), 1)];
  if (to === 'REFUNDED') {
    const e = [g(A.gamesInflight(t), -1), g(A.gamesRefunded(t), 1)];
    if (v.value_minor > 0) {
      e.push({ account: A.revenue(t), unit: 'KES', amount: v.value_minor, tableId: t, memo: 'vend refund' });
      e.push({ account: A.refundDue, unit: 'KES', amount: -v.value_minor, tableId: t, memo: 'vend refund' });
    }
    return e;
  }
  return null;
}

function transition(ctx: Ctx, vendId: string, to: VendState, actor: string, reason?: string): VendRow {
  const { db } = ctx;
  const v = getVend(ctx, vendId);
  assertTransition(v.state, to);
  const at = iso(ctx);
  db.run(
    `UPDATE vends SET state=?, updated_at=?, acked_at=CASE WHEN ?='ACKED' THEN ? ELSE acked_at END,
       confirmed_at=CASE WHEN ?='CONFIRMED' THEN ? ELSE confirmed_at END,
       failure_reason=CASE WHEN ?='FAILED' THEN ? WHEN ?='ACKED' THEN NULL ELSE failure_reason END WHERE id=?`,
    to, at, to, at, to, at, to, reason ?? null, to, vendId);
  db.run('INSERT INTO vend_events(vend_id,from_state,to_state,reason,actor,at) VALUES (?,?,?,?,?,?)', vendId, v.state, to, reason ?? null, actor, at);
  const entries = ledgerFor(v, to);
  if (entries) postTxn(db, { txnId: randomUUID(), refType: 'vend', refId: vendId, entries, at });
  appendAudit(db, ctx.now(), { actor, action: `vend.${to.toLowerCase()}`, entityType: 'vend', entityId: vendId, data: { from: v.state, reason } });
  return { ...v, state: to };
}

/** Builds, signs and records a command. Same vend ID on every resend: the device de-duplicates by vend ID. */
function issueCommand(ctx: Ctx, table: TableRow, vend: VendRow, countAttempt: boolean): Dispatched {
  const secret = decryptSecret(table.device_secret_enc!, ctx.masterKey);
  const p = parseVendParams(table.vend_mode, JSON.parse(table.vend_params_json));
  const iat = ctx.now().getTime();
  const command: VendCommand = {
    v: 1, vendId: vend.id, tableId: table.id, deviceId: table.device_id!, mode: table.vend_mode,
    pulses: p.pulses, pulseMs: p.pulseMs, gapMs: p.gapMs, holdMs: p.holdMs,
    nonce: randomBytes(16).toString('hex'), issuedAt: iat, expiresAt: iat + table.command_ttl_ms,
  };
  const signature = signCommand(command, secret);
  ctx.db.run('INSERT INTO vend_commands(vend_id,nonce,issued_at_ms,expires_at_ms,command_json,signature) VALUES (?,?,?,?,?,?)', vend.id, command.nonce, iat, command.expiresAt, JSON.stringify(command), signature);
  ctx.db.run(
    `UPDATE vends SET nonce=?, issued_at=?, expires_at=?, sent_at=?, attempts=attempts+?, updated_at=? WHERE id=?`,
    command.nonce, new Date(iat).toISOString(), new Date(command.expiresAt).toISOString(), new Date(iat).toISOString(),
    countAttempt ? 1 : 0, new Date(iat).toISOString(), vend.id);
  return { vendId: vend.id, deviceId: table.device_id!, command, signature };
}

function sendQueued(ctx: Ctx, table: TableRow, vendId: string, actor: string): Dispatched {
  transition(ctx, vendId, 'SENT', actor);
  return issueCommand(ctx, table, getVend(ctx, vendId), true);
}

function clearVendFault(ctx: Ctx, tableId: string): void {
  const failed = ctx.db.get('SELECT 1 FROM vends WHERE table_id=? AND state=\'FAILED\'', tableId);
  if (!failed) {
    ctx.db.run(`UPDATE pool_tables SET status='ACTIVE', fault_reason=NULL, updated_at=? WHERE id=? AND status='FAULTED' AND fault_reason='VEND_FAILED'`, iso(ctx), tableId);
  }
}

function failVend(ctx: Ctx, vendId: string, reason: string, actor: string): void {
  const v = transition(ctx, vendId, 'FAILED', actor, reason);
  ctx.db.run(`UPDATE pool_tables SET status='FAULTED', fault_reason='VEND_FAILED', updated_at=? WHERE id=? AND status='ACTIVE'`, iso(ctx), v.table_id);
  alert(ctx, 'VEND_FAILED', 'HIGH', v.table_id, `Vend ${vendId} failed: ${reason}`);
}

/**
 * Moves paid credits to the device as signed commands. Safe to call any number of times, from any
 * number of concurrent callers: it runs under the write lock and consumes the ledger balance, so the
 * number of vends can never exceed the number of credited games.
 */
export function dispatch(ctx: Ctx, tableId: string, actor = 'system'): Dispatched[] {
  return ctx.db.tx(() => {
    const t = getTable(ctx, tableId);
    if (t.status !== 'ACTIVE' || !t.online || !t.device_id || !t.device_secret_enc) return [];
    if (t.requires_ready_sensor && !t.ready) return [];
    if (t.release_mode === 'ONE') {
      const busy = ctx.db.get(`SELECT 1 FROM vends WHERE table_id=? AND state IN ('QUEUED','SENT','ACKED','FAILED')`, tableId);
      if (busy) return [];
    }
    const avail = balance(ctx.db, A.gamesAvail(tableId));
    const n = t.release_mode === 'ONE' ? Math.min(1, avail) : avail;
    if (n <= 0) return [];
    const value = minGameValueMinor(parsePricing(JSON.parse(t.pricing_json)), ctx.now());
    const out: Dispatched[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      const seq = ctx.db.get<{ s: number }>('SELECT COALESCE(MAX(seq),0)+1 AS s FROM vends WHERE table_id=?', tableId)!.s;
      ctx.db.run('INSERT INTO vends(id,table_id,seq,state,value_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', id, tableId, seq, 'QUEUED', value, iso(ctx), iso(ctx));
      ctx.db.run('INSERT INTO vend_events(vend_id,from_state,to_state,reason,actor,at) VALUES (?,?,?,?,?,?)', id, null, 'QUEUED', null, actor, iso(ctx));
      postTxn(ctx.db, { txnId: randomUUID(), refType: 'vend', refId: id, at: iso(ctx), entries: [
        { account: A.gamesAvail(tableId), unit: 'GAME', amount: -1, tableId }, { account: A.gamesInflight(tableId), unit: 'GAME', amount: 1, tableId }] });
      out.push(sendQueued(ctx, t, id, actor));
    }
    if (t.requires_ready_sensor) ctx.db.run('UPDATE pool_tables SET ready=0, updated_at=? WHERE id=?', iso(ctx), tableId);
    return out;
  });
}

export interface AckInput { vendId: string; nonce: string; status: AckStatus; ts: number; signature: string }
export type AckResult = { ok: true; state: VendState; duplicate: boolean } | { ok: false; reason: 'BAD_SIGNATURE' | 'UNKNOWN_NONCE' };

/** Handles a signed device acknowledgement (ACK / REJECT / CONFIRMED). Idempotent. */
export function handleAck(ctx: Ctx, a: AckInput): AckResult {
  return ctx.db.tx(() => {
    const v = getVend(ctx, a.vendId);
    const t = getTable(ctx, v.table_id);
    const secret = decryptSecret(t.device_secret_enc!, ctx.masterKey);
    if (!verifyAck({ vendId: a.vendId, nonce: a.nonce, status: a.status, ts: a.ts }, a.signature, secret)) return { ok: false, reason: 'BAD_SIGNATURE' } as const;
    // Any nonce we issued for this vend is acceptable: a late ack for an older resend still proves the device acted.
    if (!ctx.db.get('SELECT 1 FROM vend_commands WHERE vend_id=? AND nonce=?', a.vendId, a.nonce)) return { ok: false, reason: 'UNKNOWN_NONCE' } as const;
    let state = v.state;
    if (a.status === 'REJECT') {
      if (state === 'SENT') { failVend(ctx, v.id, 'device rejected command', 'device'); state = 'FAILED'; }
      return { ok: true, state, duplicate: false } as const;
    }
    let progressed = false;
    if (state === 'SENT' || state === 'FAILED') { transition(ctx, v.id, 'ACKED', 'device', state === 'FAILED' ? 'late ack after failure' : undefined); state = 'ACKED'; progressed = true; clearVendFault(ctx, v.table_id); }
    const finish = a.status === 'CONFIRMED' || (a.status === 'ACK' && !t.confirm_by_sensor);
    if (state === 'ACKED' && finish) { transition(ctx, v.id, 'CONFIRMED', 'device'); state = 'CONFIRMED'; progressed = true; }
    return { ok: true, state, duplicate: !progressed } as const;
  });
}

/** Stuck-vend detector. Resends timed-out commands (same vend ID, new nonce), fails after max attempts. */
export function sweep(ctx: Ctx): { resent: Dispatched[]; failed: string[] } {
  return ctx.db.tx(() => {
    const resent: Dispatched[] = [];
    const failed: string[] = [];
    const now = ctx.now().getTime();
    const rows = ctx.db.all<VendRow>(`SELECT * FROM vends WHERE state IN ('SENT','ACKED')`);
    for (const v of rows) {
      const t = getTable(ctx, v.table_id);
      if (v.state === 'SENT') {
        if (!t.online) continue; // offline: do not burn attempts; reconnect re-sends.
        if (now - Date.parse(v.sent_at!) < t.vend_timeout_ms) continue;
        if (v.attempts < t.max_vend_attempts) resent.push(issueCommand(ctx, t, v, true));
        else { failVend(ctx, v.id, `no acknowledgement after ${v.attempts} attempts`, 'system'); failed.push(v.id); }
      } else if (t.confirm_by_sensor && now - Date.parse(v.acked_at!) >= t.vend_timeout_ms) {
        failVend(ctx, v.id, 'no sensor confirmation', 'system'); failed.push(v.id);
      }
    }
    return { resent, failed };
  });
}

/** Device (re)connected: re-issue unacknowledged commands (no new vends, no attempt burned), then dispatch stored credits. */
export function onDeviceReconnect(ctx: Ctx, tableId: string): Dispatched[] {
  return ctx.db.tx(() => {
    ctx.db.run('UPDATE pool_tables SET online=1, updated_at=? WHERE id=?', iso(ctx), tableId);
    const t = getTable(ctx, tableId);
    const out = ctx.db.all<VendRow>(`SELECT * FROM vends WHERE table_id=? AND state='SENT' ORDER BY seq`, tableId)
      .map((v) => issueCommand(ctx, t, v, false));
    if (t.status === 'ACTIVE') {
      // Vends parked in QUEUED (e.g. a retry chosen while the device was offline) are sent now.
      for (const q of ctx.db.all<VendRow>(`SELECT * FROM vends WHERE table_id=? AND state='QUEUED' ORDER BY seq`, tableId)) out.push(sendQueued(ctx, t, q.id, 'system'));
    }
    return out.concat(dispatch(ctx, tableId, 'system'));
  });
}

export function setOffline(ctx: Ctx, tableId: string): void {
  ctx.db.run('UPDATE pool_tables SET online=0, updated_at=? WHERE id=?', iso(ctx), tableId);
}

/** Device reports the "balls captured / ready" sensor. A ready report triggers the next queued credit. */
export function reportReady(ctx: Ctx, tableId: string, ready: boolean): Dispatched[] {
  return ctx.db.tx(() => {
    ctx.db.run('UPDATE pool_tables SET ready=?, updated_at=? WHERE id=?', ready ? 1 : 0, iso(ctx), tableId);
    return ready ? dispatch(ctx, tableId, 'device') : [];
  });
}

export type FailedResolution = 'RETRY' | 'REFUND' | 'KEEP_CREDIT';

/** Attendant/customer decision for a FAILED vend. Requires a reason; replays on an already-resolved vend are rejected. */
export function resolveFailed(ctx: Ctx, vendId: string, action: FailedResolution, actor: string, reason: string): Dispatched | null {
  if (!reason.trim()) throw new VendError('REASON_REQUIRED', 'a reason is required');
  return ctx.db.tx(() => {
    const v = getVend(ctx, vendId);
    if (action === 'REFUND') { transition(ctx, vendId, 'REFUNDED', actor, reason); clearVendFault(ctx, v.table_id); return null; }
    if (action === 'KEEP_CREDIT') { transition(ctx, vendId, 'CANCELLED', actor, reason); clearVendFault(ctx, v.table_id); return null; }
    transition(ctx, vendId, 'QUEUED', actor, reason);
    clearVendFault(ctx, v.table_id);
    const t = getTable(ctx, v.table_id);
    if (t.status !== 'ACTIVE' || !t.online) return null; // stays QUEUED; reconnect/dispatch path handles it below
    return sendQueued(ctx, t, vendId, actor);
  });
}

/**
 * Commands the device should execute now (used by the device sync endpoint). Expired commands for still-SENT vends are
 * re-issued with a fresh nonce without burning a retry attempt; the vend ID never changes, so the device cannot double-vend.
 */
export function commandsForDevice(ctx: Ctx, tableId: string): Dispatched[] {
  return ctx.db.tx(() => {
    const t = getTable(ctx, tableId);
    if (!t.device_id || !t.device_secret_enc || t.status === 'DISABLED') return [];
    const now = ctx.now().getTime();
    const out: Dispatched[] = [];
    for (const v of ctx.db.all<VendRow & { nonce: string }>(`SELECT * FROM vends WHERE table_id=? AND state='SENT' ORDER BY seq`, tableId)) {
      const row = ctx.db.get<{ command_json: string; signature: string; expires_at_ms: number }>('SELECT command_json, signature, expires_at_ms FROM vend_commands WHERE vend_id=? AND nonce=?', v.id, v.nonce);
      const cmd = row ? (JSON.parse(row.command_json) as VendCommand) : null;
      if (!cmd || row!.expires_at_ms <= now) { out.push(issueCommand(ctx, t, v, false)); continue; }
      out.push({ vendId: v.id, deviceId: t.device_id, command: cmd, signature: row!.signature });
    }
    return out;
  });
}

/** Operator-approved free game (comp / owner remote open). Credits one game with a reason, then dispatches. */
export function grantGame(ctx: Ctx, a: { tableId: string; actorId: string; reason: string; shiftId?: string | null }): Dispatched[] {
  if (!a.reason.trim()) throw new VendError('REASON_REQUIRED', 'a reason is required');
  return ctx.db.tx(() => {
    getTable(ctx, a.tableId);
    const id = randomUUID();
    ctx.db.run('INSERT INTO manual_vends(id,table_id,actor_id,shift_id,reason,created_at) VALUES (?,?,?,?,?,?)', id, a.tableId, a.actorId, a.shiftId ?? null, a.reason.trim(), iso(ctx));
    postTxn(ctx.db, { txnId: randomUUID(), refType: 'manual_vend', refId: id, at: iso(ctx), entries: [
      { account: A.gamesIssued, unit: 'GAME', amount: -1, tableId: a.tableId }, { account: A.gamesAvail(a.tableId), unit: 'GAME', amount: 1, tableId: a.tableId }] });
    appendAudit(ctx.db, ctx.now(), { actor: a.actorId, action: 'vend.manual', entityType: 'table', entityId: a.tableId, data: { reason: a.reason.trim(), manualVendId: id } });
    return dispatch(ctx, a.tableId, a.actorId);
  });
}
