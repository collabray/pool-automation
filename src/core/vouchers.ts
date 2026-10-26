import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { A, postTxn } from './ledger.ts';
import { rateLimit } from './ratelimit.ts';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export class VoucherError extends Error {
  code: 'INVALID' | 'USED' | 'VOID' | 'WRONG_TABLE' | 'RATE_LIMITED' | 'UNKNOWN_TABLE';
  constructor(code: VoucherError['code'], message: string) { super(message); this.code = code; }
}
const hashCode = (c: string): string => createHash('sha256').update(normalize(c)).digest('hex');
const normalize = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
const newCode = (): string => { const b = randomBytes(10); const s = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join(''); return `${s.slice(0, 5)}-${s.slice(5)}`; };

/** Creates a batch. Plaintext codes are returned once; only SHA-256 hashes are stored. */
export function createVoucherBatch(ctx: Ctx, a: { count: number; games: number; tableId?: string | null; actor: string }): { batchId: string; codes: string[] } {
  if (!Number.isInteger(a.count) || a.count < 1 || a.count > 1000) throw new VoucherError('INVALID', 'count must be 1-1000');
  if (!Number.isInteger(a.games) || a.games < 1 || a.games > 100) throw new VoucherError('INVALID', 'games must be 1-100');
  const batchId = randomUUID();
  const codes: string[] = [];
  ctx.db.tx(() => {
    for (let i = 0; i < a.count; i++) {
      for (;;) {
        const code = newCode();
        const r = ctx.db.run(`INSERT OR IGNORE INTO vouchers(id,batch_id,code_hash,code_tail,games,table_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`,
          randomUUID(), batchId, hashCode(code), code.slice(-4), a.games, a.tableId ?? null, a.actor, ctx.now().toISOString());
        if (r.changes === 1) { codes.push(code); break; }
      }
    }
    appendAudit(ctx.db, ctx.now(), { actor: a.actor, action: 'voucher.batch_created', entityType: 'voucher_batch', entityId: batchId, data: { count: a.count, games: a.games, tableId: a.tableId ?? null } });
  });
  return { batchId, codes };
}

/** Race-safe single use: a conditional UPDATE inside the write lock flips ACTIVE->REDEEMED exactly once. */
export function redeemVoucher(ctx: Ctx, a: { code: string; tableId: string; ip: string }): { games: number; duplicate: false } {
  if (!rateLimit(ctx, `voucher:ip:${a.ip}`, 10, 600_000)) throw new VoucherError('RATE_LIMITED', 'Too many attempts. Try again later.');
  return ctx.db.tx(() => {
    const h = hashCode(a.code);
    const v = ctx.db.get<{ id: string; games: number; status: string; table_id: string | null }>('SELECT id, games, status, table_id FROM vouchers WHERE code_hash=?', h);
    if (!v) throw new VoucherError('INVALID', 'Invalid voucher code.');
    if (v.status === 'REDEEMED') throw new VoucherError('USED', 'This voucher has already been used.');
    if (v.status === 'VOID') throw new VoucherError('VOID', 'This voucher is no longer valid.');
    if (v.table_id && v.table_id !== a.tableId) throw new VoucherError('WRONG_TABLE', 'This voucher is for a different table.');
    if (!ctx.db.get('SELECT 1 FROM pool_tables WHERE id=?', a.tableId)) throw new VoucherError('UNKNOWN_TABLE', 'Table not found.');
    const txn = randomUUID();
    const r = ctx.db.run(`UPDATE vouchers SET status='REDEEMED', redeemed_at=?, redeemed_table_id=?, redeemed_txn_id=? WHERE id=? AND status='ACTIVE'`, ctx.now().toISOString(), a.tableId, txn, v.id);
    if (r.changes !== 1) throw new VoucherError('USED', 'This voucher has already been used.');
    postTxn(ctx.db, { txnId: txn, refType: 'voucher', refId: v.id, at: ctx.now().toISOString(), entries: [
      { account: A.gamesIssued, unit: 'GAME', amount: -v.games, tableId: a.tableId }, { account: A.gamesAvail(a.tableId), unit: 'GAME', amount: v.games, tableId: a.tableId }] });
    appendAudit(ctx.db, ctx.now(), { actor: 'customer', action: 'voucher.redeemed', entityType: 'voucher', entityId: v.id, data: { tableId: a.tableId, games: v.games } });
    return { games: v.games, duplicate: false as const };
  });
}

export function voidVoucherBatch(ctx: Ctx, batchId: string, actor: string): number {
  return ctx.db.tx(() => {
    const r = ctx.db.run(`UPDATE vouchers SET status='VOID' WHERE batch_id=? AND status='ACTIVE'`, batchId);
    appendAudit(ctx.db, ctx.now(), { actor, action: 'voucher.batch_voided', entityType: 'voucher_batch', entityId: batchId, data: { voided: r.changes } });
    return r.changes;
  });
}
