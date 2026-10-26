import { createServer, type Server } from 'node:http';
import { darajaPassword } from '../../src/core/daraja.ts';

export type Outcome = 'success' | 'cancel' | 'wrong_pin' | 'insufficient' | 'timeout' | 'lost_callback' | 'processing';
interface Push { checkoutRequestId: string; merchantRequestId: string; amount: number; phone: string; callbackUrl: string; txType: string; outcome: Outcome; partyB: string }

/** Local stand-in for Safaricom Daraja using the documented request/response/callback shapes. */
export class FakeDaraja {
  server!: Server; url = ''; pushes: Push[] = []; tokenCalls = 0; queryCalls = 0;
  nextOutcome: Outcome = 'success'; failNextPush: { status: number; body: unknown } | null = null; tokenTtl = 3599;
  readonly key = 'consumer-key-abc123'; readonly secret = 'consumer-secret-xyz789'; readonly shortcode = '174379'; readonly passkey = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  private seq = 0;
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url?.startsWith('/oauth/v1/generate')) {
          this.tokenCalls++;
          const ok = req.headers.authorization === 'Basic ' + Buffer.from(`${this.key}:${this.secret}`).toString('base64');
          return ok ? send(200, { access_token: `tok${this.tokenCalls}`, expires_in: String(this.tokenTtl) }) : send(400, { errorMessage: 'Bad credentials' });
        }
        if (!req.headers.authorization?.startsWith('Bearer tok')) return send(401, { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' });
        const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (req.url === '/mpesa/stkpush/v1/processrequest') {
          if (this.failNextPush) { const f = this.failNextPush; this.failNextPush = null; return send(f.status, f.body); }
          const pw = darajaPassword(b.BusinessShortCode, this.passkey, b.Timestamp);
          if (b.Password !== pw || !/^\d{14}$/.test(b.Timestamp) || !Number.isInteger(b.Amount) || !/^254\d{9}$/.test(b.PhoneNumber)) return send(400, { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid fields' });
          const n = ++this.seq;
          const p: Push = { checkoutRequestId: `ws_CO_${n}`, merchantRequestId: `MR-${n}`, amount: b.Amount, phone: b.PhoneNumber, callbackUrl: b.CallBackURL, txType: b.TransactionType, outcome: this.nextOutcome, partyB: b.PartyB };
          this.pushes.push(p);
          return send(200, { MerchantRequestID: p.merchantRequestId, CheckoutRequestID: p.checkoutRequestId, ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing', CustomerMessage: 'Success. Request accepted for processing' });
        }
        if (req.url === '/mpesa/stkpushquery/v1/query') {
          this.queryCalls++;
          const p = this.pushes.find((x) => x.checkoutRequestId === b.CheckoutRequestID);
          if (!p || p.outcome === 'processing') return send(500, { requestId: 'x', errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
          const code = this.code(p.outcome);
          return send(200, { ResponseCode: '0', ResponseDescription: 'The service request has been accepted successfully', MerchantRequestID: p.merchantRequestId, CheckoutRequestID: p.checkoutRequestId, ResultCode: String(code), ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'failed' });
        }
        send(404, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> { await new Promise((r) => this.server.close(r)); }
  code(o: Outcome): number { return { success: 0, lost_callback: 0, cancel: 1032, wrong_pin: 2001, insufficient: 1, timeout: 1037, processing: 0 }[o]; }
  /** Documented STK callback payload. */
  callbackBody(checkoutRequestId: string, o: { receipt?: string; amount?: number | string; phone?: string | number; outcome?: Outcome } = {}): unknown {
    const p = this.pushes.find((x) => x.checkoutRequestId === checkoutRequestId)!;
    const outcome = o.outcome ?? p.outcome; const code = this.code(outcome);
    const base = { MerchantRequestID: p.merchantRequestId, CheckoutRequestID: p.checkoutRequestId, ResultCode: code, ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user' };
    if (code !== 0) return { Body: { stkCallback: base } };
    return { Body: { stkCallback: { ...base, CallbackMetadata: { Item: [
      { Name: 'Amount', Value: o.amount ?? p.amount }, { Name: 'MpesaReceiptNumber', Value: o.receipt ?? `RCP${String(this.seq).padStart(7, '0')}X` },
      { Name: 'TransactionDate', Value: 20261020120000 }, { Name: 'PhoneNumber', Value: Number(o.phone ?? p.phone) }] } } } };
  }
}
