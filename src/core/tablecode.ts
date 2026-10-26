import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.ts';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export function newPublicCode(): string {
  const b = randomBytes(6);
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

function tag(masterKey: Buffer, publicCode: string, len: number): string {
  const key = createHmac('sha256', masterKey).update('table-code-v1').digest();
  const h = createHmac('sha256', key).update(publicCode).digest();
  return Array.from(h.subarray(0, len), (x) => ALPHABET[x % ALPHABET.length]).join('');
}

/** Signed table code, e.g. "K7M2QX-4HTW". Used in QR URLs and as the Paybill account reference. */
export function signedTableCode(ctx: Ctx, publicCode: string): string {
  return `${publicCode}-${tag(ctx.masterKey, publicCode, 4)}`;
}

/** Returns the table id for a valid signed code, otherwise null. Guessing a code needs the key. */
export function resolveTableCode(ctx: Ctx, code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const m = /^([A-Z2-9]{6})-([A-Z2-9]{4})$/.exec(code.trim().toUpperCase());
  if (!m) return null;
  const expected = tag(ctx.masterKey, m[1], 4);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))) return null;
  return ctx.db.get<{ id: string }>('SELECT id FROM pool_tables WHERE public_code=?', m[1])?.id ?? null;
}
