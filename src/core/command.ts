import { createHmac, timingSafeEqual } from 'node:crypto';

export type VendMode = 'COIN_PULSE' | 'SOLENOID_SLIDE' | 'GATE_SOLENOID';

/** Fixed field order so the ESP32 can rebuild the exact same string. */
export interface VendCommand {
  v: 1;
  vendId: string;
  tableId: string;
  deviceId: string;
  mode: VendMode;
  pulses: number;
  pulseMs: number;
  gapMs: number;
  holdMs: number;
  nonce: string;
  issuedAt: number; // epoch ms (server clock)
  expiresAt: number; // epoch ms
}

export interface VendParams { pulses: number; pulseMs: number; gapMs: number; holdMs: number }

export class VendParamsError extends Error {}

/** Validates per-mode timing and enforces the hard max-pulse guard (also enforced again in firmware). */
export function parseVendParams(mode: VendMode, raw: unknown): VendParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  const int = (k: string, def: number, min: number, max: number): number => {
    const v = r[k] ?? def;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new VendParamsError(`${k} must be an integer between ${min} and ${max}`);
    }
    return v;
  };
  if (mode === 'COIN_PULSE') {
    return { pulses: int('pulses', 1, 1, 20), pulseMs: int('pulseMs', 50, 10, 1000), gapMs: int('gapMs', 50, 10, 1000), holdMs: 0 };
  }
  if (mode === 'SOLENOID_SLIDE' || mode === 'GATE_SOLENOID') {
    return { pulses: 0, pulseMs: 0, gapMs: 0, holdMs: int('holdMs', mode === 'GATE_SOLENOID' ? 1500 : 400, 50, 5000) };
  }
  throw new VendParamsError('unknown vend mode');
}

export function commandString(c: VendCommand): string {
  return ['v1', c.vendId, c.tableId, c.deviceId, c.mode, c.pulses, c.pulseMs, c.gapMs, c.holdMs, c.nonce, c.issuedAt, c.expiresAt].join('|');
}

function hmacHex(secret: string, msg: string): string {
  return createHmac('sha256', secret).update(msg).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function signCommand(c: VendCommand, secret: string): string {
  return hmacHex(secret, commandString(c));
}

export interface ReplayStore { has(key: string): boolean; add(key: string): void }
export class MemoryReplayStore implements ReplayStore {
  private seen = new Set<string>();
  has(key: string): boolean { return this.seen.has(key); }
  add(key: string): void { this.seen.add(key); }
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'BAD_FORMAT' | 'BAD_SIGNATURE' | 'EXPIRED' | 'NOT_YET_VALID' | 'REPLAY' };

/**
 * Device-side logic reference (the firmware implements the same rules in C++).
 * Signature is checked first, then time window (with drift tolerance), then nonce replay.
 * The nonce is recorded only after every other check passes.
 */
export function verifyCommand(
  c: VendCommand, sigHex: string, secret: string, nowMs: number, replay: ReplayStore, driftMs = 5_000,
): VerifyResult {
  if (c.v !== 1 || !/^[0-9a-f]{32}$/.test(c.nonce) || !/^[0-9a-f]{64}$/.test(sigHex)) return { ok: false, reason: 'BAD_FORMAT' };
  if (!safeEqualHex(signCommand(c, secret), sigHex)) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (nowMs > c.expiresAt + driftMs) return { ok: false, reason: 'EXPIRED' };
  if (nowMs < c.issuedAt - driftMs) return { ok: false, reason: 'NOT_YET_VALID' };
  if (replay.has(c.nonce)) return { ok: false, reason: 'REPLAY' };
  replay.add(c.nonce);
  return { ok: true };
}

export type AckStatus = 'ACK' | 'REJECT' | 'CONFIRMED';
export interface VendAck { vendId: string; nonce: string; status: AckStatus; ts: number }

export function ackString(a: VendAck): string {
  return ['ack1', a.vendId, a.nonce, a.status, a.ts].join('|');
}
export function signAck(a: VendAck, secret: string): string { return hmacHex(secret, ackString(a)); }
export function verifyAck(a: VendAck, sigHex: string, secret: string): boolean {
  return /^[0-9a-f]{64}$/.test(sigHex) && safeEqualHex(signAck(a, secret), sigHex);
}
