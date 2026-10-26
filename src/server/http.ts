import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Ctx } from '../core/ctx.ts';
import { AuthError, authenticate, type Principal, type Role } from '../core/auth.ts';
import { hashRequest, idempotent, IdempotencyConflictError } from '../core/idempotency.ts';
import { rateLimit } from '../core/ratelimit.ts';
import { DeviceAuthError, verifyDeviceRequest } from '../core/devices.ts';
import { PhoneError } from '../core/phone.ts';
import { PricingError } from '../core/pricing.ts';
import { VendParamsError } from '../core/command.ts';
import { CashError } from '../core/cash.ts';
import { StkError } from '../core/stk.ts';
import { VoucherError } from '../core/vouchers.ts';
import { AssignError } from '../core/unallocated.ts';
import { ReversalError } from '../core/reversal.ts';
import { CreditError } from '../core/credit.ts';
import { VendError } from '../core/vend.ts';
import { IllegalTransitionError } from '../core/vend-state.ts';
import { MoneyError } from '../core/money.ts';
import { validate, ValidationError, type Field } from './schema.ts';

export interface Req {
  method: string; path: string; params: Record<string, string>; query: URLSearchParams; body: any; rawBody: string;
  headers: IncomingMessage['headers']; ip: string; user?: Principal; device?: { tableId: string; deviceId: string; secret: string; nonce: string };
}
export interface Res { status?: number; body?: unknown; headers?: Record<string, string>; raw?: Buffer | string; contentType?: string; stream?: (res: ServerResponse) => void }
export type Handler = (req: Req) => Res | Promise<Res>;
export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; auth: 'public' | 'user' | 'device'; roles?: Role[];
  body?: Record<string, Field>; idem?: 'required' | 'optional'; limit?: { per: number; windowMs: number }; maxBody?: number; handler: Handler;
}
export interface HttpOptions { trustProxy: boolean; corsOrigins: string[]; webRoot: string | null; hsts: boolean; log?: (line: string) => void }

const compile = (p: string) => { const names: string[] = []; const re = new RegExp('^' + p.replace(/:([A-Za-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$'); return { re, names }; };
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Maps domain errors to HTTP. Anything unexpected becomes an opaque 500 (details are logged, never returned). */
export function mapError(e: unknown): { status: number; code: string; message: string; details?: unknown } | null {
  if (e instanceof ValidationError) return { status: 400, code: 'VALIDATION', message: 'Invalid request', details: e.details };
  if (e instanceof AuthError) return { status: e.code === 'RATE_LIMITED' ? 429 : e.code === 'LOCKED' ? 423 : e.code === 'FORBIDDEN' ? 403 : e.code === 'EXISTS' || e.code === 'WEAK_SECRET' ? 400 : 401, code: e.code, message: e.message };
  if (e instanceof DeviceAuthError) return { status: e.code === 'REPLAY' ? 409 : 401, code: 'DEVICE_' + e.code, message: 'device authentication failed' };
  if (e instanceof StkError) return { status: e.code === 'RATE_LIMITED' ? 429 : e.code === 'TABLE_UNAVAILABLE' ? 409 : e.code === 'UNKNOWN_TABLE' ? 404 : e.code === 'NOT_CONFIGURED' ? 503 : 400, code: e.code, message: e.message, details: e.detail };
  if (e instanceof VoucherError) return { status: e.code === 'RATE_LIMITED' ? 429 : 400, code: 'VOUCHER_' + e.code, message: e.message };
  if (e instanceof CashError) return { status: e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID' ? 400 : 409, code: e.code, message: e.message };
  if (e instanceof AssignError) return { status: e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 409, code: e.code, message: e.message };
  if (e instanceof VendError) return { status: e.code === 'UNKNOWN_TABLE' || e.code === 'UNKNOWN_VEND' ? 404 : 400, code: e.code, message: e.message };
  if (e instanceof IllegalTransitionError) return { status: 409, code: 'ILLEGAL_TRANSITION', message: e.message };
  if (e instanceof IdempotencyConflictError) return { status: 422, code: 'IDEMPOTENCY_CONFLICT', message: e.message };
  if (e instanceof PhoneError) return { status: 400, code: 'INVALID_PHONE', message: e.message };
  if (e instanceof PricingError || e instanceof VendParamsError || e instanceof MoneyError || e instanceof ReversalError) return { status: 400, code: 'INVALID', message: (e as Error).message };
  if (e instanceof CreditError) return { status: 409, code: e.code, message: e.message };
  return null;
}

export class HttpApp {
  private routes: (Route & { re: RegExp; names: string[] })[] = [];
  readonly ctx: Ctx; readonly opts: HttpOptions; server: Server | null = null;
  constructor(ctx: Ctx, opts: HttpOptions) { this.ctx = ctx; this.opts = opts; }
  /** Registered routes (used to generate the OpenAPI document, so docs cannot drift from the code). */
  listRoutes(): Route[] { return this.routes.map(({ re, names, ...r }) => r as Route); }
  add(r: Route): void { const { re, names } = compile(r.path); this.routes.push({ ...r, re, names }); }

  private clientIp(req: IncomingMessage): string {
    if (this.opts.trustProxy) { const xf = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean); if (xf.length) return xf[xf.length - 1]; }
    return (req.socket.remoteAddress ?? '0.0.0.0').replace(/^::ffff:/, '');
  }

  private send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}, ctype = 'application/json; charset=utf-8', raw = false): void {
    const payload = raw ? (body as Buffer | string) : JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, ...(this.opts.hsts ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}), 'Content-Type': ctype, 'Cache-Control': 'no-store', ...extra });
    res.end(payload);
  }

  private corsHeaders(req: IncomingMessage): Record<string, string> | 'DENY' {
    const origin = req.headers.origin;
    if (!origin) return {};
    let host = ''; try { host = new URL(origin).host; } catch { return 'DENY'; }
    if (host === req.headers.host || this.opts.corsOrigins.includes(origin)) {
      return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE', 'Access-Control-Max-Age': '600' };
    }
    return 'DENY';
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqId = randomUUID().slice(0, 8); const started = Date.now();
    const ip = this.clientIp(req);
    const url = new URL(req.url ?? '/', 'http://x');
    const done = (status: number) => this.opts.log?.(`${reqId} ${ip} ${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    try {
      const isApi = url.pathname.startsWith('/api/');
      if (!isApi) { await this.serveStatic(url.pathname, res); return done(res.statusCode); }
      const cors = this.corsHeaders(req);
      if (cors === 'DENY') { this.send(res, 403, { error: { code: 'CORS', message: 'origin not allowed' } }); return done(403); }
      if (req.method === 'OPTIONS') { this.send(res, 204, '', cors, 'text/plain', true); return done(204); }

      let matched: (Route & { re: RegExp; names: string[] }) | null = null; let params: Record<string, string> = {}; let pathMatch = false;
      for (const r of this.routes) { const m = r.re.exec(url.pathname); if (!m) continue; pathMatch = true; if (r.method !== req.method) continue; matched = r; params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])); break; }
      if (!matched) { this.send(res, pathMatch ? 405 : 404, { error: { code: pathMatch ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', message: 'not found' } }, cors); return done(pathMatch ? 405 : 404); }
      const route = matched;
      // Devices are authenticated per request (signature + nonce) and limited per device below; everyone else is limited per IP.
      if (route.auth !== 'device' && !rateLimit(this.ctx, `http:ip:${ip}`, 600, 60_000)) { this.send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, cors); return done(429); }

      let rawBody = ''; let body: any = undefined;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const max = route.maxBody ?? 65_536;
        const chunks: Buffer[] = []; let size = 0;
        for await (const c of req) { size += (c as Buffer).length; if (size > max) { this.send(res, 413, { error: { code: 'TOO_LARGE', message: 'body too large' } }, cors); req.destroy(); return done(413); } chunks.push(c as Buffer); }
        rawBody = Buffer.concat(chunks).toString('utf8');
        if (rawBody.length) {
          if (route.auth !== 'device' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) { this.send(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'use application/json' } }, cors); return done(415); }
          try { body = JSON.parse(rawBody); } catch { this.send(res, 400, { error: { code: 'BAD_JSON', message: 'malformed JSON' } }, cors); return done(400); }
        }
      }
      const r: Req = { method: req.method!, path: url.pathname, params, query: url.searchParams, body, rawBody, headers: req.headers, ip };

      if (route.auth === 'user') {
        r.user = authenticate(this.ctx, req.headers.authorization);
        if (route.roles && !route.roles.includes(r.user.role)) { this.send(res, 403, { error: { code: 'FORBIDDEN', message: 'not allowed' } }, cors); return done(403); }
      } else if (route.auth === 'device') {
        const h = req.headers; const nonce = String(h['x-nonce'] ?? '');
        const v = verifyDeviceRequest(this.ctx, { deviceId: String(h['x-device-id'] ?? ''), ts: String(h['x-ts'] ?? ''), nonce, sig: String(h['x-sig'] ?? ''), method: req.method!, path: url.pathname, body: rawBody });
        r.device = { tableId: v.tableId, deviceId: String(h['x-device-id']), secret: v.secret, nonce };
        if (!rateLimit(this.ctx, `dev:${r.device.deviceId}`, 240, 60_000)) { this.send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, cors); return done(429); }
      }
      if (route.limit && !rateLimit(this.ctx, `route:${route.method}:${route.path}:${ip}`, route.limit.per, route.limit.windowMs)) { this.send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, cors); return done(429); }
      if (route.body) r.body = validate(route.body, r.body);

      let out: Res;
      if (route.idem && r.user) {
        const key = String(req.headers['idempotency-key'] ?? '');
        if (!key) {
          if (route.idem === 'required') { this.send(res, 400, { error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required' } }, cors); return done(400); }
          out = await route.handler(r);
        } else {
          const wrapped = idempotent(this.ctx.db, this.ctx.now(), `${route.method} ${route.path}:${r.user.id}`, key, hashRequest({ b: r.body, p: params, q: url.search }), () => {
            const h = route.handler(r); if (h instanceof Promise) throw new Error('idempotent routes must be synchronous'); return { status: h.status ?? 200, body: h.body ?? null, headers: h.headers ?? null } as Res;
          });
          out = wrapped.result; if (wrapped.replayed) out = { ...out, headers: { ...(out.headers ?? {}), 'Idempotent-Replay': 'true' } };
        }
      } else out = await route.handler(r);

      const headers = { ...cors, 'X-Request-Id': reqId, ...(out.headers ?? {}) };
      if (r.device && Buffer.isBuffer(out.raw)) { const { signDeviceResponse } = await import('../core/devices.ts'); headers['X-Resp-Sig'] = signDeviceResponse(r.device.secret, r.device.nonce, out.raw); headers['X-Server-Time'] = String(this.ctx.now().getTime()); this.send(res, out.status ?? 200, out.raw, headers, out.contentType ?? 'application/octet-stream', true); return done(out.status ?? 200); }
      if (r.device) { const { signDeviceResponse } = await import('../core/devices.ts'); const text = JSON.stringify(out.body ?? {}); headers['X-Resp-Sig'] = signDeviceResponse(r.device.secret, r.device.nonce, text); headers['X-Server-Time'] = String(this.ctx.now().getTime()); this.send(res, out.status ?? 200, text, headers, 'application/json; charset=utf-8', true); return done(out.status ?? 200); }
      if (out.stream) { res.writeHead(out.status ?? 200, { ...SECURITY_HEADERS, ...headers }); try { out.stream(res); } catch (e) { this.opts.log?.(`${reqId} stream error ${e}`); res.end(); } return done(out.status ?? 200); }
      if (out.raw !== undefined) this.send(res, out.status ?? 200, out.raw, headers, out.contentType ?? 'text/plain; charset=utf-8', true);
      else this.send(res, out.status ?? 200, out.body ?? {}, headers);
      done(out.status ?? 200);
    } catch (e) {
      const m = mapError(e);
      const cors = this.corsHeaders(req);
      if (m) { this.send(res, m.status, { error: { code: m.code, message: m.message, ...(m.details !== undefined ? { details: m.details } : {}) } }, cors === 'DENY' ? {} : cors); return done(m.status); }
      this.opts.log?.(`${reqId} ERROR ${(e as Error).stack ?? e}`);
      try { this.ctx.db.run('INSERT INTO error_log(at,request_id,message) VALUES (?,?,?)', this.ctx.now().toISOString(), reqId, String((e as Error).stack ?? e).slice(0, 2000)); } catch { /* never let logging break the response */ }
      if (!res.headersSent) this.send(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong', requestId: reqId } }); else res.end();
      done(500);
    }
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    if (!this.opts.webRoot) return this.send(res, 404, 'Not found', {}, 'text/plain', true);
    let rel = decodeURIComponent(pathname); if (rel === '/') rel = '/index.html';
    const full = normalize(join(this.opts.webRoot, rel));
    if (!full.startsWith(this.opts.webRoot + sep) && full !== this.opts.webRoot) return this.send(res, 403, 'Forbidden', {}, 'text/plain', true); // path traversal guard
    try {
      const data = await readFile(full);
      this.send(res, 200, data, { 'Cache-Control': extname(full) === '.html' ? 'no-cache' : 'public, max-age=300' }, MIME[extname(full)] ?? 'application/octet-stream', true);
    } catch { this.send(res, 404, 'Not found', {}, 'text/plain', true); }
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    this.server = createServer((req, res) => { this.handle(req, res).catch((e) => { this.opts.log?.(`fatal ${e}`); if (!res.headersSent) res.writeHead(500).end(); }); });
    this.server.headersTimeout = 15_000; this.server.requestTimeout = 60_000; this.server.keepAliveTimeout = 5_000; this.server.maxHeadersCount = 50;
    return new Promise((r) => this.server!.listen(port, host, () => r((this.server!.address() as { port: number }).port)));
  }
  close(): Promise<void> { return new Promise((r) => { this.server?.closeAllConnections?.(); this.server ? this.server.close(() => r()) : r(); }); }
}
