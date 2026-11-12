import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import type { Ctx } from './ctx.ts';

export const GENESIS_HASH = '0'.repeat(64);

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

function rowHash(r: { seq: number; ts: string; actor: string; action: string; entity_type: string; entity_id: string; data_json: string; prev_hash: string }): string {
  return createHash('sha256')
    .update([r.seq, r.ts, r.actor, r.action, r.entity_type, r.entity_id, r.data_json, r.prev_hash].join('\n'))
    .digest('hex');
}

/** Append-only, hash-chained. Must run inside a transaction so the chain head cannot fork. */
export function appendAudit(
  db: Db, now: Date,
  e: { actor: string; action: string; entityType: string; entityId: string; data?: unknown },
): number {
  if (!db.inTx) throw new Error('appendAudit must run inside a transaction');
  const last = db.get<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const row = {
    seq: (last?.seq ?? 0) + 1,
    ts: now.toISOString(),
    actor: e.actor,
    action: e.action,
    entity_type: e.entityType,
    entity_id: e.entityId,
    data_json: canonicalJson(e.data ?? {}),
    prev_hash: last?.hash ?? GENESIS_HASH,
  };
  db.run(
    'INSERT INTO audit_log(seq, ts, actor, action, entity_type, entity_id, data_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)',
    row.seq, row.ts, row.actor, row.action, row.entity_type, row.entity_id, row.data_json, row.prev_hash, rowHash(row),
  );
  return row.seq;
}

export function verifyAuditChain(dbOrCtx: Db | Ctx): { ok: true; count: number } | { ok: false; brokenAtSeq: number; reason: string } {
  const db = 'db' in dbOrCtx ? dbOrCtx.db : dbOrCtx;
  const rows = db.all<{ seq: number; ts: string; actor: string; action: string; entity_type: string; entity_id: string; data_json: string; prev_hash: string; hash: string }>(
    'SELECT * FROM audit_log ORDER BY seq ASC',
  );
  let prev = GENESIS_HASH;
  let expectSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectSeq) return { ok: false, brokenAtSeq: r.seq, reason: 'sequence gap (row deleted?)' };
    if (r.prev_hash !== prev) return { ok: false, brokenAtSeq: r.seq, reason: 'prev_hash mismatch' };
    if (rowHash(r) !== r.hash) return { ok: false, brokenAtSeq: r.seq, reason: 'row content altered' };
    prev = r.hash;
    expectSeq++;
  }
  return { ok: true, count: rows.length };
}
