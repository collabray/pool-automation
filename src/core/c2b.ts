import type { Ctx } from './ctx.ts';
import { creditPurchase } from './credit.ts';
import { loadDarajaConfig } from './daraja.ts';
import { hashPhone } from './phone.ts';
import { getSetting } from './settings.ts';
import { resolveTableCode } from './tablecode.ts';
import { recordUnallocated } from './unallocated.ts';

export interface C2bBody { TransactionType?: string; TransID?: string; TransAmount?: string | number; BusinessShortCode?: string; BillRefNumber?: string; MSISDN?: string }

function minor(v: unknown): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0) : null;
}

/**
 * C2B confirmation. Shared-till rules:
 *  - on a Till (CustomerBuyGoodsOnline) a C2B payment NEVER vends (no account field exists);
 *  - on a Paybill it vends only if the owner enabled auto-credit AND the account reference is a valid signed table code;
 *  - everything else is booked as an unallocated (other-business) receipt.
 */
export function handleC2bConfirmation(ctx: Ctx, body: C2bBody, pepper: string): { verdict: string; tableId?: string } {
  const receipt = body.TransID, amount = minor(body.TransAmount);
  if (typeof receipt !== 'string' || !/^[A-Z0-9]{8,14}$/.test(receipt) || amount === null || amount <= 0) return { verdict: 'INVALID' };
  return ctx.db.tx(() => {
    const seen = ctx.db.get('SELECT 1 FROM mpesa_receipts WHERE receipt=?', receipt);
    if (seen) return { verdict: 'DUPLICATE' };
    const phoneHash = body.MSISDN && /^\d{9,15}$/.test(body.MSISDN) ? hashPhone(body.MSISDN, pepper) : body.MSISDN ? String(body.MSISDN).slice(0, 64) : null;
    const reg = (refId: string) => ctx.db.run(`INSERT INTO mpesa_receipts(receipt,kind,ref_id,created_at) VALUES (?, 'C2B', ?, ?)`, receipt, refId, ctx.now().toISOString());
    const park = (reason: string) => {
      const id = recordUnallocated(ctx, { receipt, source: 'MPESA_C2B', amountMinor: amount, phoneHash, accountRef: body.BillRefNumber ?? null, reason, raw: body });
      reg(id);
      return { verdict: `UNALLOCATED_${reason}` };
    };
    const cfg = loadDarajaConfig(ctx);
    if (!cfg || cfg.txType === 'CustomerBuyGoodsOnline') return park('TILL_NO_ACCOUNT');
    if (getSetting(ctx, 'c2b.auto_credit') !== '1') return park('AUTO_CREDIT_OFF');
    const tableId = resolveTableCode(ctx, body.BillRefNumber);
    if (!tableId) return park('NO_VALID_TABLE_CODE');
    const r = creditPurchase(ctx, { source: 'MPESA_C2B', idempotencyKey: `c2b:${receipt}`, externalRef: receipt, tableId, amountMinor: amount, ownerRef: phoneHash, actor: 'mpesa' });
    if (r.status === 'REJECTED') return park('TABLE_POLICY_REJECTED');
    reg(r.paymentId);
    return { verdict: 'CREDITED', tableId };
  });
}
