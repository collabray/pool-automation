import type { Ctx } from './ctx.ts';
import { getSecretSetting, getSetting, setSecretSetting, setSetting } from './settings.ts';
import { appendAudit } from './audit.ts';

export type DarajaEnv = 'sandbox' | 'production';
export type TxType = 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';

export interface DarajaConfig {
  env: DarajaEnv;
  shortcode: string;      // BusinessShortCode (Paybill number, or head-office/store number for a Till)
  partyB: string;         // receiving shortcode (Paybill number, or the Till number)
  passkey: string;
  consumerKey: string;
  consumerSecret: string;
  txType: TxType;
  callbackBaseUrl: string; // public HTTPS origin, e.g. https://pool.example.com
  callbackToken: string;   // secret path segment
  baseUrlOverride?: string; // tests only (fake Daraja)
}

const URLS: Record<DarajaEnv, string> = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' };

export class DarajaError extends Error {
  status: number; body: unknown;
  constructor(message: string, status = 0, body: unknown = null) { super(message); this.status = status; this.body = body; }
}

/** Daraja timestamps are YYYYMMDDHHmmss in East Africa Time (UTC+3). */
export function darajaTimestamp(d: Date): string {
  const e = new Date(d.getTime() + 3 * 3600_000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${e.getUTCFullYear()}${p(e.getUTCMonth() + 1)}${p(e.getUTCDate())}${p(e.getUTCHours())}${p(e.getUTCMinutes())}${p(e.getUTCSeconds())}`;
}
export function darajaPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(shortcode + passkey + timestamp).toString('base64');
}

export interface StkPushResponse { MerchantRequestID: string; CheckoutRequestID: string; ResponseCode: string; ResponseDescription: string; CustomerMessage?: string }
export interface StkQueryResponse { ResponseCode: string; ResultCode?: string | number; ResultDesc?: string; CheckoutRequestID?: string }

export class DarajaClient {
  private token: { value: string; expiresAt: number } | null = null;
  private cfg: DarajaConfig;
  private now: () => Date;
  private fetchFn: typeof fetch;
  constructor(cfg: DarajaConfig, now: () => Date = () => new Date(), fetchFn: typeof fetch = fetch) { this.cfg = cfg; this.now = now; this.fetchFn = fetchFn; }

  private get base(): string { return this.cfg.baseUrlOverride ?? URLS[this.cfg.env]; }
  get callbackUrl(): string { return `${this.cfg.callbackBaseUrl.replace(/\/$/, '')}/api/mpesa/stk-callback/${this.cfg.callbackToken}`; }

  /** OAuth token, cached until 60 s before expiry; refreshed automatically. */
  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now().getTime() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64');
    const res = await this.fetchFn(`${this.base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: string } | null;
    if (!res.ok || !body?.access_token) throw new DarajaError('OAuth failed', res.status, body);
    this.token = { value: body.access_token, expiresAt: this.now().getTime() + Number(body.expires_in ?? 3599) * 1000 };
    return this.token.value;
  }

  private async post<T>(path: string, payload: unknown, retryAuth = true): Promise<T> {
    const token = await this.getToken();
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as T | null;
    if (res.status === 401 && retryAuth) { await this.getToken(true); return this.post<T>(path, payload, false); }
    if (!res.ok) throw new DarajaError(`Daraja ${path} failed (${res.status})`, res.status, body);
    return body as T;
  }

  async stkPush(a: { amountShillings: number; phone: string; accountRef: string; description: string }): Promise<StkPushResponse> {
    const ts = darajaTimestamp(this.now());
    const r = await this.post<StkPushResponse>('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.cfg.shortcode,
      Password: darajaPassword(this.cfg.shortcode, this.cfg.passkey, ts),
      Timestamp: ts,
      TransactionType: this.cfg.txType,
      Amount: a.amountShillings,
      PartyA: a.phone,
      PartyB: this.cfg.partyB,
      PhoneNumber: a.phone,
      CallBackURL: this.callbackUrl,
      AccountReference: a.accountRef.slice(0, 12),
      TransactionDesc: a.description.slice(0, 13),
    });
    if (r.ResponseCode !== '0') throw new DarajaError(`STK push rejected: ${r.ResponseDescription}`, 200, r);
    return r;
  }

  /** Returns state: 'SUCCESS' | 'FAILED' (with code) | 'PROCESSING'. */
  async stkQuery(checkoutRequestId: string): Promise<{ state: 'SUCCESS' | 'FAILED' | 'PROCESSING'; resultCode?: number; resultDesc?: string }> {
    const ts = darajaTimestamp(this.now());
    try {
      const r = await this.post<StkQueryResponse>('/mpesa/stkpushquery/v1/query', {
        BusinessShortCode: this.cfg.shortcode, Password: darajaPassword(this.cfg.shortcode, this.cfg.passkey, ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId });
      const code = Number(r.ResultCode);
      if (!Number.isFinite(code)) return { state: 'PROCESSING' };
      return { state: code === 0 ? 'SUCCESS' : 'FAILED', resultCode: code, resultDesc: r.ResultDesc };
    } catch (e) {
      // Daraja answers HTTP 500 with errorCode 500.001.1001 while the transaction is still being processed.
      if (e instanceof DarajaError && (e.body as { errorCode?: string } | null)?.errorCode === '500.001.1001') return { state: 'PROCESSING' };
      throw e;
    }
  }
}

// ---- persistence of the admin-editable configuration (secrets encrypted at rest) ----
export function saveDarajaConfig(ctx: Ctx, c: DarajaConfig, actor: string): void {
  ctx.db.tx(() => {
    setSetting(ctx, 'daraja.env', c.env); setSetting(ctx, 'daraja.shortcode', c.shortcode); setSetting(ctx, 'daraja.party_b', c.partyB);
    setSetting(ctx, 'daraja.tx_type', c.txType); setSetting(ctx, 'daraja.callback_base_url', c.callbackBaseUrl);
    setSecretSetting(ctx, 'daraja.passkey', c.passkey); setSecretSetting(ctx, 'daraja.consumer_key', c.consumerKey);
    setSecretSetting(ctx, 'daraja.consumer_secret', c.consumerSecret); setSecretSetting(ctx, 'daraja.callback_token', c.callbackToken);
    appendAudit(ctx.db, ctx.now(), { actor, action: 'daraja.config_saved', entityType: 'settings', entityId: 'daraja', data: { env: c.env, shortcode: c.shortcode, txType: c.txType } });
  });
}
export function loadDarajaConfig(ctx: Ctx): DarajaConfig | null {
  const shortcode = getSetting(ctx, 'daraja.shortcode');
  const passkey = getSecretSetting(ctx, 'daraja.passkey');
  const consumerKey = getSecretSetting(ctx, 'daraja.consumer_key');
  const consumerSecret = getSecretSetting(ctx, 'daraja.consumer_secret');
  const callbackToken = getSecretSetting(ctx, 'daraja.callback_token');
  if (!shortcode || !passkey || !consumerKey || !consumerSecret || !callbackToken) return null;
  return { env: (getSetting(ctx, 'daraja.env') || 'sandbox') as DarajaEnv, shortcode, partyB: getSetting(ctx, 'daraja.party_b') || shortcode,
    passkey, consumerKey, consumerSecret, callbackToken, txType: (getSetting(ctx, 'daraja.tx_type') || 'CustomerPayBillOnline') as TxType,
    callbackBaseUrl: getSetting(ctx, 'daraja.callback_base_url') };
}
/** "Test connection" button: succeeds only if Daraja issues an OAuth token for the stored credentials. */
export async function testDarajaConnection(client: DarajaClient): Promise<{ ok: boolean; message: string }> {
  try { await client.getToken(true); return { ok: true, message: 'Connected: Daraja issued an access token.' }; }
  catch (e) { return { ok: false, message: e instanceof DarajaError ? `${e.message} (HTTP ${e.status})` : 'Network error reaching Daraja' }; }
}
