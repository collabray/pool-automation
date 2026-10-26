import type { Ctx } from './ctx.ts';
import { appendAudit } from './audit.ts';
import { encryptSecret } from './crypto.ts';
import { hashPhone, normalizePhone } from './phone.ts';
import { getInt } from './settings.ts';

/** Kenya Data Protection Act support: access/export, erasure of personal identifiers, retention. Financial records are kept (legal retention) but de-identified. */
export function exportPersonalData(ctx: Ctx, phone: string, pepper: string): Record<string, unknown> {
  const h = hashPhone(normalizePhone(phone), pepper);
  return {
    mpesaRequests: ctx.db.all('SELECT id, table_id, games, amount_minor, status, receipt, created_at FROM mpesa_requests WHERE phone_hash=?', h),
    payments: ctx.db.all('SELECT id, table_id, source, external_ref, amount_minor, games_credited, created_at FROM payments WHERE owner_ref=?', h),
    unallocated: ctx.db.all('SELECT id, receipt, amount_minor, reason, received_at FROM unallocated_payments WHERE phone_hash=?', h),
  };
}
export function erasePersonalData(ctx: Ctx, phone: string, pepper: string, actor: string, reason: string): { requests: number; payments: number; unallocated: number } {
  if (!reason.trim()) throw new Error('a reason is required');
  const h = hashPhone(normalizePhone(phone), pepper);
  return ctx.db.tx(() => {
    const redacted = encryptSecret('ERASED', ctx.masterKey);
    const a = ctx.db.run(`UPDATE mpesa_requests SET phone_enc=?, phone_hash='erased:'||id WHERE phone_hash=?`, redacted, h).changes;
    const b = ctx.db.run('UPDATE payments SET owner_ref=NULL WHERE owner_ref=?', h).changes;
    const c = ctx.db.run('UPDATE unallocated_payments SET phone_hash=NULL WHERE phone_hash=?', h).changes;
    appendAudit(ctx.db, ctx.now(), { actor, action: 'privacy.erased', entityType: 'subject', entityId: h.slice(0, 12), data: { reason: reason.trim(), requests: a, payments: b, unallocated: c } });
    return { requests: a, payments: b, unallocated: c };
  });
}
/** Scheduled: removes recoverable phone numbers from old requests. Hashes remain only for abuse prevention until erased. */
export function enforceRetention(ctx: Ctx): number {
  const cutoff = new Date(ctx.now().getTime() - getInt(ctx, 'retention.phone_days') * 86_400_000).toISOString();
  return ctx.db.run(`UPDATE mpesa_requests SET phone_enc=?, phone_hash='expired:'||id WHERE created_at<? AND phone_hash NOT LIKE 'expired:%' AND phone_hash NOT LIKE 'erased:%' AND status NOT IN ('PENDING','INITIATING','TIMEOUT')`,
    encryptSecret('EXPIRED', ctx.masterKey), cutoff).changes;
}
