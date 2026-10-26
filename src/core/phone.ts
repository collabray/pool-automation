import { createHmac } from 'node:crypto';

export class PhoneError extends Error {}

/**
 * Accepts 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX
 * (spaces, dashes and parentheses are ignored) and returns 254XXXXXXXXX.
 */
export function normalizePhone(input: unknown): string {
  if (typeof input !== 'string') throw new PhoneError('Phone number is required');
  const cleaned = input.trim().replace(/[\s\-().]/g, '');
  const m = /^(?:\+?254|0)([71]\d{8})$/.exec(cleaned);
  if (!m) throw new PhoneError('Enter a valid Safaricom number, e.g. 0712345678');
  return '254' + m[1];
}

/** Keyed hash for lookups/rate limits; the raw number is never used as a lookup key. */
export function hashPhone(normalized: string, pepper: string): string {
  if (!pepper) throw new PhoneError('PHONE_HASH_PEPPER is not configured');
  return createHmac('sha256', pepper).update(normalized).digest('hex');
}

export function maskPhone(normalized: string): string {
  return normalized.slice(0, 5) + '****' + normalized.slice(-3);
}
