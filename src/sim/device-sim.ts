import { randomBytes } from 'node:crypto';
import { MemoryReplayStore, signAck, verifyCommand, type AckStatus, type VendCommand, type VendMode } from '../core/command.ts';
import { signDeviceRequest, signDeviceResponse } from '../core/devices.ts';

export interface OutputEvent { vendId: string; mode: VendMode; kind: 'PULSES' | 'HOLD'; pulses?: number; pulseMs?: number; gapMs?: number; holdMs?: number }
export interface SimFaults { sensorFault?: boolean; dropNextAcks?: number; ignoreCommands?: boolean; disconnected?: boolean; rejectUnsigned?: boolean }
export interface Persistent { executed: Record<string, 'ACK' | 'CONFIRMED'>; nonces: string[] }

/**
 * Behavioural twin of the ESP32 firmware's protocol logic: verifies every command (signature, expiry with server-time offset,
 * nonce replay), de-duplicates by vend ID across reboots, enforces the max-pulse guard, and answers with signed acks.
 */
export class DeviceSim {
  baseUrl: string; deviceId: string; secret: string; mode: VendMode; confirmBySensor: boolean;
  faults: SimFaults = {}; outputs: OutputEvent[] = []; rejected: { vendId: string; reason: string }[] = [];
  private persistent: Persistent = { executed: {}, nonces: [] };
  private replay = new MemoryReplayStore();
  private pendingAcks: { vendId: string; nonce: string; status: AckStatus }[] = [];
  private pendingEvents: { id: string; kind: string; data?: Record<string, unknown> }[] = [];
  private serverOffsetMs = 0; private bootMs = Date.now(); private resetReason = 'poweron'; private rebootedOnce = false;
  sensors: { ready: boolean; tamper: boolean } = { ready: true, tamper: false };
  fw = 'sim-1.0.0'; lastConfig: Record<string, unknown> = {}; lastAckResults: unknown[] = []; tamperAuthFailures = 0;

  constructor(o: { baseUrl: string; deviceId: string; secret: string; mode?: VendMode; confirmBySensor?: boolean }) {
    this.baseUrl = o.baseUrl; this.deviceId = o.deviceId; this.secret = o.secret; this.mode = o.mode ?? 'GATE_SOLENOID'; this.confirmBySensor = !!o.confirmBySensor;
  }

  /** Power cycle: RAM state is lost, persistent memory (executed vend IDs, nonces) survives. */
  reboot(reason = 'poweron'): void {
    this.pendingAcks = []; this.pendingEvents = []; this.replay = new MemoryReplayStore(); for (const n of this.persistent.nonces) this.replay.add(n);
    this.bootMs = Date.now(); this.resetReason = reason; this.rebootedOnce = true;
  }
  snapshot(): Persistent { return JSON.parse(JSON.stringify(this.persistent)); }
  restore(p: Persistent): void { this.persistent = p; for (const n of p.nonces) this.replay.add(n); }
  insertCoin(n = 1): void { this.pendingEvents.push({ id: `coin-${randomBytes(6).toString('hex')}`, kind: 'coin', data: { coins: n } }); }
  tamper(open: boolean): void { this.sensors.tamper = open; this.pendingEvents.push({ id: `tamper-${randomBytes(6).toString('hex')}`, kind: open ? 'tamper' : 'tamper_clear' }); }
  pressButton(): void { this.pendingEvents.push({ id: `btn-${randomBytes(6).toString('hex')}`, kind: 'manual_request' }); }
  unauthorizedVend(): void { this.pendingEvents.push({ id: `uv-${randomBytes(6).toString('hex')}`, kind: 'unauthorized_vend' }); }
  /** Sensor reports balls captured/vend confirmed for a vend. */
  confirmVend(vendId: string, nonce: string): void { this.pendingAcks.push({ vendId, nonce, status: 'CONFIRMED' }); this.persistent.executed[vendId] = 'CONFIRMED'; }
  setReady(r: boolean): void { this.sensors.ready = r; }

  private async post(body: unknown): Promise<{ status: number; json: any; sigOk: boolean }> {
    const text = JSON.stringify(body); const path = '/api/device/sync'; const ts = Date.now(); const nonce = randomBytes(16).toString('hex');
    const res = await fetch(this.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': this.deviceId, 'X-Ts': String(ts), 'X-Nonce': nonce, 'X-Sig': signDeviceRequest(this.secret, 'POST', path, ts, nonce, text) }, body: text });
    const resText = await res.text();
    const sig = res.headers.get('x-resp-sig');
    const sigOk = !!sig && sig === signDeviceResponse(this.secret, nonce, resText);
    const st = res.headers.get('x-server-time'); if (st) this.serverOffsetMs = Number(st) - Date.now();
    return { status: res.status, json: resText ? JSON.parse(resText) : null, sigOk };
  }

  async downloadOta(version: string): Promise<{ status: number; bytes: Buffer; sigOk: boolean }> {
    const path = `/api/device/ota/${version}`; const ts = Date.now(); const nonce = randomBytes(16).toString('hex');
    const res = await fetch(this.baseUrl + path, { headers: { 'X-Device-Id': this.deviceId, 'X-Ts': String(ts), 'X-Nonce': nonce, 'X-Sig': signDeviceRequest(this.secret, 'GET', path, ts, nonce, '') } });
    const bytes = Buffer.from(await res.arrayBuffer()); const sig = res.headers.get('x-resp-sig');
    return { status: res.status, bytes, sigOk: res.status === 200 && !!sig && sig === signDeviceResponse(this.secret, nonce, bytes) };
  }
  /** One round trip. Returns commands executed in this round. */
  async sync(wait = 0): Promise<{ executed: string[]; status: number }> {
    if (this.faults.disconnected) throw new Error('simulated network down');
    const acks = this.pendingAcks.splice(0, this.pendingAcks.length);
    const dropped = Math.min(this.faults.dropNextAcks ?? 0, acks.length);
    if (dropped) { this.faults.dropNextAcks = (this.faults.dropNextAcks ?? 0) - dropped; acks.splice(0, dropped); }
    const events = this.pendingEvents.splice(0, this.pendingEvents.length);
    const payload = { fw: this.fw, uptimeS: Math.floor((Date.now() - this.bootMs) / 1000), rssi: -55, freeHeap: 180000, resetReason: this.rebootedOnce ? this.resetReason : 'poweron', sensors: { ...this.sensors },
      wait, acks: acks.map((a) => ({ vendId: a.vendId, nonce: a.nonce, status: a.status, ts: Date.now(), signature: signAck({ vendId: a.vendId, nonce: a.nonce, status: a.status, ts: Date.now() }, this.secret) })), events };
    // ack timestamps must match what was signed: rebuild with a single ts
    payload.acks = acks.map((a) => { const ts = Date.now(); return { vendId: a.vendId, nonce: a.nonce, status: a.status, ts, signature: signAck({ vendId: a.vendId, nonce: a.nonce, status: a.status, ts }, this.secret) }; });
    const r = await this.post(payload);
    if (r.status !== 200) { if (process.env.SIM_DEBUG) console.log("SIM non-200", r.status, JSON.stringify(r.json)); return { executed: [], status: r.status }; }
    if (!r.sigOk) { this.tamperAuthFailures++; return { executed: [], status: 598 }; } // never act on an unauthenticated response
    this.lastConfig = r.json.config; this.lastAckResults = r.json.ackResults;
    const executed: string[] = [];
    if (this.faults.ignoreCommands) return { executed, status: 200 };
    for (const c of r.json.commands as { command: VendCommand; signature: string }[]) { if (this.handle(c.command, c.signature)) executed.push(c.command.vendId); }
    return { executed, status: 200 };
  }

  private handle(cmd: VendCommand, sig: string): boolean {
    const serverNow = Date.now() + this.serverOffsetMs;
    if (cmd.deviceId !== this.deviceId) { this.rejected.push({ vendId: cmd.vendId, reason: 'WRONG_DEVICE' }); return false; }
    const v = verifyCommand(cmd, sig, this.secret, serverNow, this.replay);
    if (!v.ok) { this.rejected.push({ vendId: cmd.vendId, reason: v.reason }); return false; }
    this.persistent.nonces.push(cmd.nonce); if (this.persistent.nonces.length > 200) this.persistent.nonces.shift();
    if (this.persistent.executed[cmd.vendId]) { // duplicate vend ID (resend after lost ack / reboot): acknowledge again, never vend again
      this.pendingAcks.push({ vendId: cmd.vendId, nonce: cmd.nonce, status: this.persistent.executed[cmd.vendId] === 'CONFIRMED' ? 'CONFIRMED' : 'ACK' }); return false;
    }
    if (this.faults.sensorFault || cmd.pulses > 20 || cmd.pulseMs > 1000 || cmd.holdMs > 5000 || cmd.mode !== this.mode) {
      this.rejected.push({ vendId: cmd.vendId, reason: this.faults.sensorFault ? 'SENSOR_FAULT' : cmd.mode !== this.mode ? 'MODE_MISMATCH' : 'GUARD' });
      this.pendingAcks.push({ vendId: cmd.vendId, nonce: cmd.nonce, status: 'REJECT' }); return false;
    }
    this.outputs.push(cmd.mode === 'COIN_PULSE' ? { vendId: cmd.vendId, mode: cmd.mode, kind: 'PULSES', pulses: cmd.pulses, pulseMs: cmd.pulseMs, gapMs: cmd.gapMs } : { vendId: cmd.vendId, mode: cmd.mode, kind: 'HOLD', holdMs: cmd.holdMs });
    this.persistent.executed[cmd.vendId] = 'ACK';
    this.sensors.ready = false; // balls are out; the game is in progress until the table reports ready again
    this.pendingAcks.push({ vendId: cmd.vendId, nonce: cmd.nonce, status: 'ACK' });
    return true;
  }
}
