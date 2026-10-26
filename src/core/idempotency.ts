import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { canonicalJson } from './audit.ts';

export class IdempotencyConflictError extends Error {}

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * Runs fn at most once per (scope, key). Replays return the stored response.
 * Reusing a key with a different request body is a client bug and is rejected.
 * The key row is written in the same transaction as fn's effects, so a failed fn leaves no key behind.
 */
export function idempotent<T>(
  db: Db, now: Date, scope: string, key: string, requestHash: string, fn: () => T,
): { replayed: boolean; result: T } {
  if (!key || key.length > 200) throw new Error('idempotency key must be 1-200 characters');
  return db.tx(() => {
    const row = db.get<{ request_hash: string; response_json: string }>(
      'SELECT request_hash, response_json FROM idempotency_keys WHERE scope=? AND key=?', scope, key);
    if (row) {
      if (row.request_hash !== requestHash) throw new IdempotencyConflictError('idempotency key reused with a different request');
      return { replayed: true, result: JSON.parse(row.response_json) as T };
    }
    const result = fn();
    db.run('INSERT INTO idempotency_keys(scope, key, request_hash, response_json, created_at) VALUES (?,?,?,?,?)',
      scope, key, requestHash, JSON.stringify(result), now.toISOString());
    return { replayed: false, result };
  });
}
