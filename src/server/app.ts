import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
const require_crypto = () => ({ createHash });
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../core/ctx.ts';
import { HttpApp, type HttpOptions, type Req, type Res } from './http.ts';
import { f } from './schema.ts';
import * as auth from '../core/auth.ts';
import { AuthError, grantApproval, consumeApproval, type Role } from '../core/auth.ts';
import { DarajaClient, loadDarajaConfig, saveDarajaConfig, testDarajaConnection, type DarajaConfig } from '../core/daraja.ts';
import { getRequestStatus, handleStkCallback, initiateStk, newCallbackToken, reconcilePending, verifyCallbackOrigin } from '../core/stk.ts';
import { handleC2bConfirmation } from '../core/c2b.ts';
import { assignUnallocated, listUnallocated } from '../core/unallocated.ts';
import { redeemVoucher, createVoucherBatch, voidVoucherBatch } from '../core/vouchers.ts';
import { cashSale, closeShift, adjustClosedShift, openShift, openShiftOf, voidCashSale, getShift, CashError } from '../core/cash.ts';
import { commandsForDevice, dispatch, grantGame, resolveFailed } from '../core/vend.ts';
import { processSync, monitorTables } from '../core/devices.ts';
import { collectCoinBox } from '../core/coins.ts';
import { createTable, rotateDeviceSecret, updateTable } from '../core/tables.ts';
import { resolveTableCode, signedTableCode } from '../core/tablecode.ts';
import { quote, parsePricing, unitPriceAt, gamesForAmount } from '../core/pricing.ts';
import { attendantStats, ownerSummary, periodRange, salesRows, toCsv, type Period } from '../core/reports.ts';
import { listAlerts, resolveAlert } from '../core/alerts.ts';
import { verifyAuditChain } from '../core/audit.ts';
import { getInt, getSetting, setSetting, DEFAULTS } from '../core/settings.ts';
import { loadNotifyConfig, saveNotifyConfig, deliverAlerts, sendSms, type NotifyConfig } from '../core/notify.ts';
import { qrSvg } from '../core/qr.ts';
import { textPdf } from '../core/pdf.ts';
import { erasePersonalData, exportPersonalData } from '../core/privacy.ts';
import { reversePayment } from '../core/reversal.ts';
import { formatKes } from '../core/money.ts';
import { A, balance } from '../core/ledger.ts';

export interface AppDeps {
  ctx: Ctx; pepper: string; http: HttpOptions;
  /** Builds the Daraja client for the stored config. Tests override to point at the fake server. */
  makeClient?: (cfg: DarajaConfig, ctx: Ctx) => DarajaClient;
}
const S: Role[] = ['attendant', 'manager', 'owner'], M: Role[] = ['manager', 'owner'], O: Role[] = ['owner'];
const ok = (body: unknown, status = 200): Res => ({ status, body });
const need = <T,>(v: T | undefined | null, msg = 'not found'): T => { if (v === undefined || v === null) throw new CashError('NOT_FOUND', msg); return v; };
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

export class Hub extends EventEmitter {
  constructor() { super(); this.setMaxListeners(0); }
  waitTable(tableId: string, ms: number): Promise<void> {
    return new Promise((res) => { const t = setTimeout(done, ms); const ev = `table:${tableId}`; function done() { clearTimeout(t); hub.off(ev, done); res(); } const hub = this; this.once(ev, done); });
  }
}

export function buildApp(d: AppDeps): { app: HttpApp; hub: Hub; background: () => Promise<void> } {
  const { ctx, pepper } = d;
  const app = new HttpApp(ctx, d.http);
  const hub = new Hub();
  let cachedClient: { key: string; client: DarajaClient } | null = null;
  const client = (): DarajaClient | null => {
    const cfg = loadDarajaConfig(ctx); if (!cfg) return null;
    const key = JSON.stringify(cfg);
    if (cachedClient?.key !== key) cachedClient = { key, client: d.makeClient ? d.makeClient(cfg, ctx) : new DarajaClient(cfg, ctx.now) };
    return cachedClient.client;
  };
  const notifyTable = (tableId: string) => setImmediate(() => { hub.emit(`table:${tableId}`); hub.emit('pay'); });
  const afterCredit = (tableId: string) => { dispatch(ctx, tableId); notifyTable(tableId); };
  const route = app.add.bind(app);
  const money = (u: { role: Role; canSeeMoney: boolean }) => u.role !== 'attendant' || u.canSeeMoney;

  // ---------------- health & setup ----------------
  route({ method: 'GET', path: '/api/health', auth: 'public', handler: () => { ctx.db.get('SELECT 1'); return ok({ ok: true, time: ctx.now().toISOString() }); } });
  route({ method: 'GET', path: '/api/setup/status', auth: 'public', handler: () => ok({
    needsSetup: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n === 0, darajaConfigured: !!loadDarajaConfig(ctx),
    tables: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM pool_tables')!.n }) });
  route({ method: 'POST', path: '/api/setup/owner', auth: 'public', limit: { per: 5, windowMs: 600_000 },
    body: { username: f.str({ min: 3, max: 40 }), displayName: f.str({ min: 1, max: 80 }), password: f.str({ min: 10, max: 200 }), businessName: f.str({ min: 1, max: 80 }) },
    handler: (r) => ctx.db.tx(() => {
      if (ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n > 0) throw new AuthError('FORBIDDEN', 'setup already completed');
      const id = auth.createUser(ctx, { username: r.body.username, displayName: r.body.displayName, role: 'owner', password: r.body.password }, 'setup');
      setSetting(ctx, 'business.name', r.body.businessName);
      return ok({ id }, 201);
    }) });

  // ---------------- auth ----------------
  const tokensRes = (t: auth.Tokens) => ok({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresInSec: t.expiresInSec, user: t.user });
  route({ method: 'POST', path: '/api/auth/login', auth: 'public', body: { username: f.str({ min: 1, max: 60 }), password: f.str({ min: 1, max: 200 }), totp: f.str({ opt: true, max: 10 }) },
    handler: (r) => tokensRes(auth.login(ctx, { username: r.body.username, secret: r.body.password, kind: 'password', totp: r.body.totp, ip: r.ip })) });
  route({ method: 'POST', path: '/api/auth/pin-login', auth: 'public', body: { username: f.str({ min: 1, max: 60 }), pin: f.str({ min: 4, max: 8, re: /^\d+$/ }) },
    handler: (r) => tokensRes(auth.login(ctx, { username: r.body.username, secret: r.body.pin, kind: 'pin', ip: r.ip })) });
  route({ method: 'POST', path: '/api/auth/refresh', auth: 'public', limit: { per: 60, windowMs: 600_000 }, body: { refreshToken: f.str({ min: 10, max: 200 }) }, handler: (r) => tokensRes(auth.refresh(ctx, r.body.refreshToken)) });
  route({ method: 'POST', path: '/api/auth/logout', auth: 'public', body: { refreshToken: f.str({ min: 10, max: 200 }) }, handler: (r) => { auth.logout(ctx, r.body.refreshToken); return ok({ ok: true }); } });
  route({ method: 'GET', path: '/api/me', auth: 'user', roles: S, handler: (r) => ok({ user: r.user, shiftId: openShiftOf(ctx, r.user!.id) }) });
  route({ method: 'POST', path: '/api/me/totp/begin', auth: 'user', roles: M, handler: (r) => ok(auth.beginTotp(ctx, r.user!.id)) });
  route({ method: 'POST', path: '/api/me/totp/confirm', auth: 'user', roles: M, body: { code: f.str({ min: 6, max: 6, re: /^\d{6}$/ }) }, handler: (r) => { auth.confirmTotp(ctx, r.user!.id, r.body.code); return ok({ ok: true }); } });
  route({ method: 'POST', path: '/api/me/password', auth: 'user', roles: S, body: { current: f.str({ max: 200 }), password: f.str({ min: 10, max: 200 }) },
    handler: (r) => { const row = ctx.db.get<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id=?', r.user!.id)!; if (!auth.verifySecret(r.body.current, row.password_hash)) throw new AuthError('INVALID_CREDENTIALS', 'current password is incorrect'); auth.setCredentials(ctx, r.user!.id, { password: r.body.password }, r.user!.id); return ok({ ok: true }); } });

  // ---------------- customer ("Pay for games") ----------------
  const tableByCode = (code: string) => { const id = resolveTableCode(ctx, code); if (!id) throw new CashError('NOT_FOUND', 'Unknown table code'); return id; };
  const tableState = (t: { status: string; online: number }) => (t.status !== 'ACTIVE' ? t.status : t.online ? 'AVAILABLE' : 'OFFLINE');
  route({ method: 'GET', path: '/api/public/table/:code', auth: 'public', limit: { per: 120, windowMs: 60_000 }, handler: (r) => {
    const id = tableByCode(r.params.code);
    const t = ctx.db.get<{ name: string; kind: string; status: string; online: number; pricing_json: string }>('SELECT name, kind, status, online, pricing_json FROM pool_tables WHERE id=?', id)!;
    const cfg = parsePricing(JSON.parse(t.pricing_json)); const now = ctx.now();
    const prices: number[] = []; for (let g = cfg.minGames; g <= cfg.maxGames; g++) prices.push(quote(cfg, g, now).totalMinor);
    const dc = loadDarajaConfig(ctx);
    const c2b = !!dc && dc.txType === 'CustomerPayBillOnline' && getSetting(ctx, 'c2b.auto_credit') === '1';
    const pub = ctx.db.get<{ public_code: string }>('SELECT public_code FROM pool_tables WHERE id=?', id)!.public_code;
    return ok({ name: t.name, kind: t.kind, state: tableState(t), unitPriceMinor: unitPriceAt(cfg, now), minGames: cfg.minGames, maxGames: cfg.maxGames, firstGames: cfg.minGames, prices,
      bundles: cfg.bundles, business: getSetting(ctx, 'business.name'), brandColor: getSetting(ctx, 'brand.color'),
      paybill: c2b ? { number: dc!.partyB, account: signedTableCode(ctx, pub) } : null, mpesaEnabled: !!dc, voucherEnabled: true });
  } });
  route({ method: 'POST', path: '/api/public/pay', auth: 'public', limit: { per: 30, windowMs: 600_000 },
    body: { code: f.str({ min: 5, max: 20 }), games: f.int({ min: 1, max: 1000 }), phone: f.str({ min: 7, max: 20 }), idempotencyKey: f.str({ min: 8, max: 100 }) },
    handler: async (r) => {
      const tableId = tableByCode(r.body.code);
      const res = await initiateStk(ctx, client(), { tableId, games: r.body.games, phone: r.body.phone, idempotencyKey: r.body.idempotencyKey, ip: r.ip, pepper });
      hub.emit('pay'); return ok(res, res.duplicate ? 200 : 201);
    } });
  const payStatus = (id: string) => { const s = getRequestStatus(ctx, id); if (!s) return null; const remaining = balance(ctx.db, A.gamesAvail(s.tableId)) + balance(ctx.db, A.gamesInflight(s.tableId)); return { ...s, tableId: undefined, gamesRemaining: s.status === 'SUCCESS' ? remaining : null }; };
  route({ method: 'GET', path: '/api/public/pay/:id', auth: 'public', limit: { per: 240, windowMs: 60_000 }, handler: (r) => ok(need(payStatus(r.params.id))) });
  route({ method: 'GET', path: '/api/public/pay/:id/events', auth: 'public', limit: { per: 30, windowMs: 60_000 }, handler: (r) => {
    need(payStatus(r.params.id));
    return { stream: (res) => {
      const TERMINAL = new Set(['SUCCESS', 'CANCELLED', 'WRONG_PIN', 'INSUFFICIENT_FUNDS', 'FAILED', 'EXPIRED']);
      const push = () => { const s = payStatus(r.params.id); res.write(`data: ${JSON.stringify(s)}\n\n`); if (s && TERMINAL.has(s.status)) end(); };
      const end = () => { clearInterval(tick); clearTimeout(stop); hub.off('pay', push); res.end(); };
      const tick = setInterval(push, 3000); const stop = setTimeout(end, 150_000);
      hub.on('pay', push); res.on('close', () => { clearInterval(tick); clearTimeout(stop); hub.off('pay', push); }); push();
    }, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } };
  } });
  route({ method: 'POST', path: '/api/public/voucher', auth: 'public', limit: { per: 20, windowMs: 600_000 }, body: { code: f.str({ min: 5, max: 20 }), voucher: f.str({ min: 5, max: 30 }) },
    handler: (r) => { const tableId = tableByCode(r.body.code); const v = redeemVoucher(ctx, { code: r.body.voucher, tableId, ip: r.ip }); afterCredit(tableId); return ok({ games: v.games }); } });

  // ---------------- Daraja callbacks (secret path token + optional IP allowlist) ----------------
  const accepted = { ResultCode: 0, ResultDesc: 'Accepted' };
  const originOk = (r: Req) => verifyCallbackOrigin(ctx, r.params.token, r.ip).ok;
  route({ method: 'POST', path: '/api/mpesa/stk-callback/:token', auth: 'public', handler: async (r) => {
    if (!originOk(r)) return { status: 403, body: { error: { code: 'FORBIDDEN', message: 'forbidden' } } };
    const out = await handleStkCallback(ctx, client(), r.body, r.ip);
    if (out.tableId) afterCredit(out.tableId); hub.emit('pay'); return ok(accepted);
  } });
  route({ method: 'POST', path: '/api/mpesa/c2b/validation/:token', auth: 'public', handler: (r) => (originOk(r) ? ok(accepted) : { status: 403, body: {} }) });
  route({ method: 'POST', path: '/api/mpesa/c2b/confirmation/:token', auth: 'public', handler: (r) => {
    if (!originOk(r)) return { status: 403, body: {} };
    const out = handleC2bConfirmation(ctx, r.body ?? {}, pepper); if (out.tableId) afterCredit(out.tableId); return ok(accepted);
  } });

  // ---------------- staff: board, shifts, cash ----------------
  route({ method: 'GET', path: '/api/tables', auth: 'user', roles: S, handler: (r) => {
    const today = periodRange('today', ctx.now());
    const rows = ctx.db.all<Record<string, any>>('SELECT id, name, kind, status, fault_reason, online, ready, tamper, last_seen_at, fw_version, rssi, vend_mode, release_mode, pricing_json, manual_vend_enabled, public_code FROM pool_tables ORDER BY name');
    return ok({ tables: rows.map((t) => ({
      id: t.id, name: t.name, kind: t.kind, state: t.status !== 'ACTIVE' ? t.status : t.online ? 'ONLINE' : 'OFFLINE', faultReason: t.fault_reason, tamper: !!t.tamper, lastSeenAt: t.last_seen_at, fw: t.fw_version, rssi: t.rssi,
      vendMode: t.vend_mode, releaseMode: t.release_mode, unitPriceMinor: unitPriceAt(parsePricing(JSON.parse(t.pricing_json)), ctx.now()), manualVendEnabled: !!t.manual_vend_enabled,
      creditsPending: balance(ctx.db, A.gamesAvail(t.id)), inFlight: balance(ctx.db, A.gamesInflight(t.id)),
      lastVendAt: ctx.db.get<{ m: string | null }>(`SELECT MAX(confirmed_at) m FROM vends WHERE table_id=?`, t.id)!.m,
      gamesToday: ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM vends WHERE table_id=? AND state='CONFIRMED' AND confirmed_at>=? AND confirmed_at<?`, t.id, today.from, today.to)!.n })) });
  } });
  route({ method: 'GET', path: '/api/shifts/current', auth: 'user', roles: S, handler: (r) => { const id = openShiftOf(ctx, r.user!.id); return ok({ shift: id ? getShift(ctx, id) : null }); } });
  route({ method: 'POST', path: '/api/shifts/open', auth: 'user', roles: S, idem: 'optional', body: { floatMinor: f.int({ min: 0, max: 100_000_000 }) }, handler: (r) => ok(openShift(ctx, r.user!.id, r.body.floatMinor), 201) });
  route({ method: 'POST', path: '/api/shifts/close', auth: 'user', roles: S, idem: 'optional', body: { countedMinor: f.int({ min: 0, max: 1_000_000_000 }) },
    handler: (r) => { const id = need(openShiftOf(ctx, r.user!.id), 'no open shift'); return ok(closeShift(ctx, { shiftId: id, actorId: r.user!.id, countedMinor: r.body.countedMinor })); } });
  route({ method: 'POST', path: '/api/shifts/:id/adjust', auth: 'user', roles: O, idem: 'required', body: { amountMinor: f.int({ min: -100_000_000, max: 100_000_000 }), reason: f.str({ min: 3, max: 300 }) },
    handler: (r) => ok({ id: adjustClosedShift(ctx, { shiftId: r.params.id, ownerId: r.user!.id, amountMinor: r.body.amountMinor, reason: r.body.reason }) }, 201) });
  route({ method: 'POST', path: '/api/cash/sale', auth: 'user', roles: S, idem: 'required',
    body: { tableId: f.str({ min: 5, max: 60 }), cashReceivedMinor: f.int({ min: 1, max: 100_000_000 }), discountMinor: f.int({ opt: true, min: 0, max: 100_000_000 }), discountReason: f.str({ opt: true, max: 200 }), approvalToken: f.str({ opt: true, max: 80 }), offline: f.bool({ opt: true }) },
    handler: (r) => {
      const key = String(r.headers['idempotency-key']);
      const s = cashSale(ctx, { attendantId: r.user!.id, tableId: r.body.tableId, cashReceivedMinor: r.body.cashReceivedMinor, idempotencyKey: key, discountMinor: r.body.discountMinor, discountReason: r.body.discountReason, approvedBy: r.body.approvalToken ? consumeApproval(ctx, r.body.approvalToken, r.user!.id) : undefined, offline: r.body.offline });
      afterCredit(r.body.tableId); return ok(s, s.duplicate ? 200 : 201);
    } });
  route({ method: 'POST', path: '/api/cash/void', auth: 'user', roles: S, idem: 'required', body: { saleId: f.str({ min: 5, max: 60 }), reason: f.str({ min: 3, max: 200 }), approvalToken: f.str({ opt: true, max: 80 }) },
    handler: (r) => ok(voidCashSale(ctx, { saleId: r.body.saleId, actorId: r.user!.id, reason: r.body.reason, approvedBy: r.body.approvalToken ? consumeApproval(ctx, r.body.approvalToken, r.user!.id) : undefined })) });
  route({ method: 'POST', path: '/api/approvals', auth: 'user', roles: S, body: { username: f.str({ min: 1, max: 60 }), secret: f.str({ min: 4, max: 200 }), kind: f.enum(['password', 'pin']) },
    handler: (r) => ok(grantApproval(ctx, { requestedBy: r.user!.id, username: r.body.username, secret: r.body.secret, kind: r.body.kind, ip: r.ip })) });
  route({ method: 'GET', path: '/api/cash/quote', auth: 'user', roles: S, handler: (r) => {
    const t = need(ctx.db.get<{ pricing_json: string }>('SELECT pricing_json FROM pool_tables WHERE id=?', r.query.get('tableId') ?? ''), 'table not found');
    const cash = Number(r.query.get('cash')); const disc = Number(r.query.get('discount') ?? 0); if (!Number.isSafeInteger(cash) || cash < 1 || !Number.isSafeInteger(disc) || disc < 0) throw new CashError('INVALID', 'cash must be a positive integer');
    const cfg = parsePricing(JSON.parse(t.pricing_json)); const g = gamesForAmount(cfg, cash + disc, ctx.now());
    return ok({ games: g.games, chargedMinor: g.costMinor, remainderMinor: g.remainderMinor, policy: cfg.remainderPolicy, rejected: cfg.remainderPolicy === 'REJECT' && g.remainderMinor > 0, changeMinor: cfg.remainderPolicy === 'REFUND' ? g.remainderMinor : 0, heldMinor: cfg.remainderPolicy === 'HOLD_CREDIT' ? g.remainderMinor : 0 });
  } });
  route({ method: 'POST', path: '/api/cash/receipt-sms', auth: 'user', roles: S, limit: { per: 30, windowMs: 600_000 }, body: { saleId: f.str({ min: 5, max: 60 }), phone: f.str({ min: 7, max: 20 }) }, handler: async (r) => {
    const sale = need(ctx.db.get<{ receipt_no: string; games: number; cash_received_minor: number; table_name: string; attendant_id: string }>('SELECT s.receipt_no, s.games, s.cash_received_minor, t.name AS table_name, s.attendant_id FROM cash_sales s JOIN pool_tables t ON t.id=s.table_id WHERE s.id=?', r.body.saleId), 'sale not found');
    if (r.user!.role === 'attendant' && sale.attendant_id !== r.user!.id) throw new CashError('FORBIDDEN', 'not your sale');
    const cfg = loadNotifyConfig(ctx); if (!cfg.sms) throw new CashError('INVALID', 'SMS is not configured');
    const { normalizePhone } = await import('../core/phone.ts'); const to = '+' + normalizePhone(r.body.phone);
    await sendSms({ ...cfg.sms, to: [to] }, `${getSetting(ctx, 'business.name')}: receipt ${sale.receipt_no}, ${sale.games} game(s) on ${sale.table_name}, ${formatKes(sale.cash_received_minor)} cash. Thank you!`);
    return ok({ ok: true });
  } });
  route({ method: 'GET', path: '/api/cash/sales', auth: 'user', roles: S, handler: (r) => {
    const own = r.user!.role === 'attendant';
    const rows = ctx.db.all('SELECT s.id, s.receipt_no, s.table_id, t.name AS table_name, s.cash_received_minor, s.change_minor, s.games, s.status, s.created_at FROM cash_sales s JOIN pool_tables t ON t.id=s.table_id WHERE (?=0 OR s.attendant_id=?) ORDER BY s.receipt_seq DESC LIMIT 100', own ? 1 : 0, r.user!.id);
    return ok({ sales: rows });
  } });
  route({ method: 'POST', path: '/api/mpesa/pos-stk', auth: 'user', roles: S, limit: { per: 60, windowMs: 600_000 },
    body: { tableId: f.str({ min: 5, max: 60 }), games: f.int({ min: 1, max: 1000 }), phone: f.str({ min: 7, max: 20 }), idempotencyKey: f.str({ min: 8, max: 100 }) },
    handler: async (r) => ok(await initiateStk(ctx, client(), { tableId: r.body.tableId, games: r.body.games, phone: r.body.phone, idempotencyKey: r.body.idempotencyKey, ip: r.ip, pepper, attendantId: r.user!.id }), 201) });
  route({ method: 'POST', path: '/api/vends/manual', auth: 'user', roles: S, idem: 'required', body: { tableId: f.str({ min: 5, max: 60 }), reason: f.str({ min: 3, max: 200 }) }, handler: (r) => {
    const t = need(ctx.db.get<{ manual_vend_enabled: number }>('SELECT manual_vend_enabled FROM pool_tables WHERE id=?', r.body.tableId), 'table not found');
    if (r.user!.role === 'attendant') {
      if (!t.manual_vend_enabled) throw new CashError('FORBIDDEN', 'manual vend is disabled for this table');
      const shift = openShiftOf(ctx, r.user!.id); if (!shift) throw new CashError('NO_OPEN_SHIFT', 'open a shift first');
      const used = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM manual_vends WHERE shift_id=?', shift)!.n;
      if (used >= getInt(ctx, 'manual.max_per_shift')) throw new CashError('LIMIT', 'manual vend limit reached for this shift; ask a manager');
      grantGame(ctx, { tableId: r.body.tableId, actorId: r.user!.id, reason: r.body.reason, shiftId: shift });
    } else grantGame(ctx, { tableId: r.body.tableId, actorId: r.user!.id, reason: r.body.reason });
    notifyTable(r.body.tableId); return ok({ ok: true }, 201);
  } });
  route({ method: 'POST', path: '/api/vends/:id/resolve', auth: 'user', roles: S, idem: 'required', body: { action: f.enum(['RETRY', 'REFUND', 'KEEP_CREDIT']), reason: f.str({ min: 3, max: 200 }), approvalToken: f.str({ opt: true, max: 80 }) }, handler: (r) => {
    const v = need(ctx.db.get<{ table_id: string; value_minor: number }>('SELECT table_id, value_minor FROM vends WHERE id=?', r.params.id), 'vend not found');
    if (r.user!.role === 'attendant' && r.body.action === 'REFUND') {   // refunds respect the attendant's limit; above it a manager must approve with their own credentials
      const limit = ctx.db.get<{ l: number }>('SELECT void_limit_minor l FROM users WHERE id=?', r.user!.id)!.l;
      if (v.value_minor > limit) { if (!r.body.approvalToken) throw new CashError('APPROVAL_REQUIRED', 'refund exceeds your limit: manager approval required'); consumeApproval(ctx, r.body.approvalToken, r.user!.id); }
    }
    const out = resolveFailed(ctx, r.params.id, r.body.action, r.user!.id, r.body.reason); notifyTable(v.table_id); return ok({ dispatched: !!out });
  } });
  route({ method: 'GET', path: '/api/vends/failed', auth: 'user', roles: S, handler: () => ok({ vends: ctx.db.all(`SELECT v.id, v.table_id, t.name AS table_name, v.failure_reason, v.updated_at FROM vends v JOIN pool_tables t ON t.id=v.table_id WHERE v.state='FAILED' ORDER BY v.updated_at DESC`) }) });

  // ---------------- analytics ----------------
  const range = (r: Req): { from: string; to: string } => {
    const p = r.query.get('period') as Period | 'custom' | null;
    if (p === 'custom') { const from = r.query.get('from') ?? '', to = r.query.get('to') ?? ''; if (!ISO.test(from) || !ISO.test(to) || from >= to) throw new CashError('INVALID', 'from/to must be ISO UTC timestamps'); return { from, to }; }
    return periodRange(p && ['today', 'yesterday', 'week', 'month'].includes(p) ? (p as Period) : 'today', ctx.now());
  };
  route({ method: 'GET', path: '/api/my/stats', auth: 'user', roles: S, handler: (r) => { const { from, to } = range(r); return ok(attendantStats(ctx, r.user!.id, from, to, money(r.user!))); } });
  route({ method: 'GET', path: '/api/my/shift-stats', auth: 'user', roles: S, handler: (r) => { const id = openShiftOf(ctx, r.user!.id); if (!id) return ok({ stats: null }); const sh = getShift(ctx, id)!; return ok({ stats: attendantStats(ctx, r.user!.id, String(sh.opened_at), '9999-12-31T00:00:00Z', money(r.user!)) }); } });
  route({ method: 'GET', path: '/api/staff/:id/stats', auth: 'user', roles: M, handler: (r) => { const { from, to } = range(r); return ok(attendantStats(ctx, r.params.id, from, to, true)); } });
  route({ method: 'GET', path: '/api/staff/compare', auth: 'user', roles: M, handler: (r) => { const { from, to } = range(r);
    return ok({ from, to, staff: ctx.db.all<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE role='attendant' AND active=1`).map((u) => { const s = attendantStats(ctx, u.id, from, to, true); return { id: u.id, name: u.display_name, salesCount: s.salesCount, gamesSold: s.gamesSold, totalMinor: s.totalMinor, averageSaleMinor: s.averageSaleMinor, voids: s.voids.count, refunds: s.refunds.count, variances: s.variances }; }) }); } });
  route({ method: 'GET', path: '/api/reports/summary', auth: 'user', roles: M, handler: (r) => { const { from, to } = range(r); return ok(ownerSummary(ctx, from, to)); } });
  const exporter = (r: Req, attendantId: string | null): Res => {
    const { from, to } = range(r); const rows = salesRows(ctx, from, to, attendantId); const fmt = r.query.get('format') ?? 'csv';
    if (fmt === 'pdf') {
      const total = rows.filter((x) => x.status === 'OK').reduce((s, x) => s + Number(x.amount_kes), 0);
      const lines = [`Period: ${from} to ${to}`, `Sales: ${rows.length}   Total: KES ${total.toFixed(2)}`, '', 'Time | Table | Method | Ref | Games | KES | Status',
        ...rows.map((x) => `${String(x.time).slice(0, 16)} | ${x.table} | ${x.method} | ${x.reference} | ${x.games} | ${x.amount_kes} | ${x.status}`)];
      return { raw: textPdf(`${getSetting(ctx, 'business.name')} - Sales report`, lines), contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="sales.pdf"' } };
    }
    return { raw: toCsv(rows) || 'time,table,method,reference,games,amount_kes,attendant,status\n', contentType: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="sales.csv"' } };
  };
  route({ method: 'GET', path: '/api/my/export', auth: 'user', roles: S, handler: (r) => { if (!money(r.user!)) throw new AuthError('FORBIDDEN', 'money figures are hidden for your account'); return exporter(r, r.user!.id); } });
  route({ method: 'GET', path: '/api/reports/export', auth: 'user', roles: M, handler: (r) => exporter(r, r.query.get('attendantId')) });

  // ---------------- owner/manager admin ----------------
  route({ method: 'GET', path: '/api/unallocated', auth: 'user', roles: M, handler: (r) => ok({ payments: listUnallocated(ctx, (r.query.get('status') as 'UNALLOCATED' | 'ASSIGNED' | 'ALL') ?? 'UNALLOCATED') }) });
  route({ method: 'POST', path: '/api/unallocated/:id/assign', auth: 'user', roles: M, idem: 'required', body: { tableId: f.str({ min: 5, max: 60 }), reason: f.str({ min: 3, max: 300 }) },
    handler: (r) => { const out = assignUnallocated(ctx, { id: r.params.id, tableId: r.body.tableId, actorId: r.user!.id, reason: r.body.reason }); afterCredit(r.body.tableId); return ok(out); } });
  route({ method: 'POST', path: '/api/vouchers/batch', auth: 'user', roles: M, idem: 'required', body: { count: f.int({ min: 1, max: 1000 }), games: f.int({ min: 1, max: 100 }), tableId: f.str({ opt: true, max: 60 }) },
    handler: (r) => ok(createVoucherBatch(ctx, { count: r.body.count, games: r.body.games, tableId: r.body.tableId, actor: r.user!.id }), 201) });
  route({ method: 'POST', path: '/api/vouchers/batch/:id/void', auth: 'user', roles: M, handler: (r) => ok({ voided: voidVoucherBatch(ctx, r.params.id, r.user!.id) }) });
  route({ method: 'GET', path: '/api/payments', auth: 'user', roles: M, handler: (r) => ok({ payments: ctx.db.all(`SELECT p.id, p.created_at, p.source, p.external_ref, t.name AS table_name, p.amount_minor, p.games_credited, p.remainder_minor, p.remainder_action,
      EXISTS(SELECT 1 FROM ledger_entries l WHERE l.ref_type='payment_reversal' AND l.ref_id=p.id) AS reversed FROM payments p JOIN pool_tables t ON t.id=p.table_id WHERE (?='' OR p.source=?) ORDER BY p.created_at DESC LIMIT ?`, r.query.get('source') ?? '', r.query.get('source') ?? '', Math.min(Number(r.query.get('limit') ?? 50) || 50, 200)) }) });
  route({ method: 'POST', path: '/api/payments/:id/reverse', auth: 'user', roles: O, idem: 'required', body: { reason: f.str({ min: 3, max: 300 }) },
    handler: (r) => { const out = reversePayment(ctx, { paymentId: r.params.id, reason: r.body.reason, actor: r.user!.id }); return ok(out); } });
  route({ method: 'GET', path: '/api/alerts', auth: 'user', roles: M, handler: (r) => ok({ alerts: listAlerts(ctx, r.query.get('all') !== '1') }) });
  route({ method: 'POST', path: '/api/alerts/:id/resolve', auth: 'user', roles: M, handler: (r) => ok({ resolved: resolveAlert(ctx, r.params.id) }) });
  route({ method: 'POST', path: '/api/coins/collections', auth: 'user', roles: M, idem: 'required', body: { tableId: f.str({ min: 5, max: 60 }), countedMinor: f.int({ min: 0, max: 1_000_000_000 }), note: f.str({ opt: true, max: 300 }) },
    handler: (r) => ok(collectCoinBox(ctx, { tableId: r.body.tableId, actorId: r.user!.id, countedMinor: r.body.countedMinor, note: r.body.note }), 201) });
  route({ method: 'GET', path: '/api/coins/collections', auth: 'user', roles: M, handler: () => ok({ collections: ctx.db.all('SELECT c.*, t.name AS table_name FROM coin_collections c JOIN pool_tables t ON t.id=c.table_id ORDER BY collected_at DESC LIMIT 100') }) });
  route({ method: 'GET', path: '/api/shifts', auth: 'user', roles: M, handler: () => ok({ shifts: ctx.db.all(`SELECT s.id, s.attendant_id, u.display_name AS attendant, s.status, s.float_minor, s.opened_at, s.closed_at, s.counted_minor, s.expected_minor, s.variance_minor, s.variance_flagged FROM shifts s JOIN users u ON u.id=s.attendant_id ORDER BY s.opened_at DESC LIMIT 100`) }) });
  route({ method: 'GET', path: '/api/audit', auth: 'user', roles: M, handler: (r) => ok({ entries: ctx.db.all('SELECT seq, ts, actor, action, entity_type, entity_id, data_json FROM audit_log WHERE seq < ? ORDER BY seq DESC LIMIT 100', Number(r.query.get('before') ?? 1e15)) }) });
  route({ method: 'GET', path: '/api/audit/verify', auth: 'user', roles: M, handler: () => ok(verifyAuditChain(ctx)) });
  route({ method: 'GET', path: '/api/errors', auth: 'user', roles: O, handler: () => ok({ errors: ctx.db.all('SELECT id, at, request_id, message FROM error_log ORDER BY id DESC LIMIT 100') }) });
  route({ method: 'GET', path: '/api/system/health', auth: 'user', roles: M, handler: () => ok({
    node: process.version, uptimeSec: Math.round(process.uptime()), time: ctx.now().toISOString(),
    migrations: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM schema_migrations')!.n, openAlerts: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM alerts WHERE resolved_at IS NULL')!.n,
    offlineTables: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM pool_tables WHERE online=0 AND device_id IS NOT NULL')!.n, pendingStk: ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM mpesa_requests WHERE status IN ('PENDING','TIMEOUT')`)!.n,
    unallocatedPending: ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM unallocated_payments WHERE status='UNALLOCATED'`)!.n, darajaConfigured: !!loadDarajaConfig(ctx),
    ledgerBalanced: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM (SELECT txn_id FROM ledger_entries GROUP BY txn_id, unit HAVING SUM(amount)<>0)')!.n === 0 }) });

  // tables
  const tablePricingShape = f.free();
  route({ method: 'GET', path: '/api/tables/:id', auth: 'user', roles: M, handler: (r) => {
    const t = need(ctx.db.get<Record<string, any>>('SELECT * FROM pool_tables WHERE id=?', r.params.id), 'table not found');
    return ok({ id: t.id, name: t.name, kind: t.kind, status: t.status, vendMode: t.vend_mode, vendParams: JSON.parse(t.vend_params_json), pricing: JSON.parse(t.pricing_json), releaseMode: t.release_mode,
      requiresReadySensor: !!t.requires_ready_sensor, confirmBySensor: !!t.confirm_by_sensor, vendTimeoutMs: t.vend_timeout_ms, maxVendAttempts: t.max_vend_attempts, commandTtlMs: t.command_ttl_ms, coinValueMinor: t.coin_value_minor, manualVendEnabled: !!t.manual_vend_enabled, deviceId: t.device_id });
  } });
  route({ method: 'POST', path: '/api/tables', auth: 'user', roles: O, idem: 'required',
    body: { name: f.str({ min: 1, max: 60 }), kind: f.str({ opt: true, max: 30 }), vendMode: f.enum(['COIN_PULSE', 'SOLENOID_SLIDE', 'GATE_SOLENOID']), vendParams: f.free({ opt: true }), pricing: tablePricingShape, releaseMode: f.enum(['ONE', 'ALL'], { opt: true }), requiresReadySensor: f.bool({ opt: true }), confirmBySensor: f.bool({ opt: true }),
      vendTimeoutMs: f.int({ opt: true, min: 1000, max: 300000 }), maxVendAttempts: f.int({ opt: true, min: 1, max: 10 }), coinValueMinor: f.int({ opt: true, min: 100, max: 1_000_000 }), manualVendEnabled: f.bool({ opt: true }) },
    handler: (r) => ctx.db.tx(() => { const b = r.body; const c = createTable(ctx, { name: b.name, kind: b.kind, vendMode: b.vendMode, vendParams: b.vendParams, pricing: b.pricing, releaseMode: b.releaseMode, requiresReadySensor: b.requiresReadySensor, confirmBySensor: b.confirmBySensor, vendTimeoutMs: b.vendTimeoutMs, maxVendAttempts: b.maxVendAttempts, actor: r.user!.id });
      if (b.coinValueMinor !== undefined || b.manualVendEnabled !== undefined) updateTable(ctx, c.tableId, { coinValueMinor: b.coinValueMinor, manualVendEnabled: b.manualVendEnabled }, r.user!.id); return ok(c, 201); }) });
  route({ method: 'PATCH', path: '/api/tables/:id', auth: 'user', roles: O, idem: 'optional',
    body: { name: f.str({ opt: true, min: 1, max: 60 }), status: f.enum(['ACTIVE', 'DISABLED'], { opt: true }), pricing: f.free({ opt: true }), vendMode: f.enum(['COIN_PULSE', 'SOLENOID_SLIDE', 'GATE_SOLENOID'], { opt: true }), vendParams: f.free({ opt: true }),
      releaseMode: f.enum(['ONE', 'ALL'], { opt: true }), requiresReadySensor: f.bool({ opt: true }), confirmBySensor: f.bool({ opt: true }), vendTimeoutMs: f.int({ opt: true, min: 1000, max: 300000 }), maxVendAttempts: f.int({ opt: true, min: 1, max: 10 }),
      commandTtlMs: f.int({ opt: true, min: 1000, max: 600000 }), coinValueMinor: f.int({ opt: true, min: 100, max: 1_000_000 }), manualVendEnabled: f.bool({ opt: true }) },
    handler: (r) => { updateTable(ctx, r.params.id, r.body, r.user!.id); notifyTable(r.params.id); return ok({ ok: true }); } });
  route({ method: 'POST', path: '/api/tables/:id/rotate-device-secret', auth: 'user', roles: O, idem: 'required', handler: (r) => ok(rotateDeviceSecret(ctx, r.params.id, r.user!.id)) });
  route({ method: 'POST', path: '/api/tables/:id/test-vend', auth: 'user', roles: O, idem: 'required', handler: (r) => {
    const t = need(ctx.db.get<{ online: number }>('SELECT online FROM pool_tables WHERE id=?', r.params.id)); if (!t.online) throw new CashError('DEVICE_OFFLINE', 'the device is offline');
    grantGame(ctx, { tableId: r.params.id, actorId: r.user!.id, reason: 'Setup test vend' }); notifyTable(r.params.id); return ok({ ok: true }, 201);
  } });
  route({ method: 'POST', path: '/api/owner/tables/:id/open', auth: 'user', roles: M, idem: 'required', body: { reason: f.str({ opt: true, max: 200 }) }, handler: (r) => {
    const t = need(ctx.db.get<{ online: number; status: string }>('SELECT online, status FROM pool_tables WHERE id=?', r.params.id), 'table not found');
    if (!t.online) throw new CashError('DEVICE_OFFLINE', 'the table is offline; the game will be released as soon as it reconnects');
    grantGame(ctx, { tableId: r.params.id, actorId: r.user!.id, reason: r.body.reason?.trim() || 'Owner remote open' }); notifyTable(r.params.id); return ok({ ok: true, status: t.status }, 201);
  } });
  route({ method: 'GET', path: '/api/tables/:id/qr', auth: 'user', roles: M, handler: (r) => {
    const t = need(ctx.db.get<{ public_code: string; name: string }>('SELECT public_code, name FROM pool_tables WHERE id=?', r.params.id)); const code = signedTableCode(ctx, t.public_code);
    const base = getSetting(ctx, 'public.base_url') || d.http.corsOrigins[0] || ''; return ok({ name: t.name, code, url: `${base}/pay.html?t=${code}` });
  } });
  route({ method: 'GET', path: '/api/tables/:id/qr.svg', auth: 'user', roles: M, handler: (r) => {
    const t = need(ctx.db.get<{ public_code: string }>('SELECT public_code FROM pool_tables WHERE id=?', r.params.id)); const code = signedTableCode(ctx, t.public_code);
    const base = getSetting(ctx, 'public.base_url'); if (!base) throw new CashError('INVALID', 'set the public website address in Settings first');
    return { raw: qrSvg(`${base}/pay.html?t=${code}`, 512), contentType: 'image/svg+xml' };
  } });

  // staff management
  route({ method: 'GET', path: '/api/staff', auth: 'user', roles: M, handler: () => ok({ staff: ctx.db.all('SELECT id, username, display_name, role, active, can_see_money, void_limit_minor, discount_limit_minor FROM users ORDER BY role, username') }) });
  route({ method: 'POST', path: '/api/staff', auth: 'user', roles: M, idem: 'required',
    body: { username: f.str({ min: 3, max: 40 }), displayName: f.str({ min: 1, max: 80 }), role: f.enum(['manager', 'attendant']), password: f.str({ opt: true, max: 200 }), pin: f.str({ opt: true, max: 8 }), canSeeMoney: f.bool({ opt: true }), voidLimitMinor: f.int({ opt: true, min: 0, max: 100_000_000 }), discountLimitMinor: f.int({ opt: true, min: 0, max: 100_000_000 }) },
    handler: (r) => { if (r.body.role === 'manager' && r.user!.role !== 'owner') throw new AuthError('FORBIDDEN', 'only the owner can create managers'); return ok({ id: auth.createUser(ctx, r.body, r.user!.id) }, 201); } });
  route({ method: 'PATCH', path: '/api/staff/:id', auth: 'user', roles: M, idem: 'optional',
    body: { displayName: f.str({ opt: true, min: 1, max: 80 }), active: f.bool({ opt: true }), canSeeMoney: f.bool({ opt: true }), voidLimitMinor: f.int({ opt: true, min: 0, max: 100_000_000 }), discountLimitMinor: f.int({ opt: true, min: 0, max: 100_000_000 }), password: f.str({ opt: true, max: 200 }), pin: f.str({ opt: true, max: 8 }) },
    handler: (r) => {
      const u = need(ctx.db.get<{ role: Role }>('SELECT role FROM users WHERE id=?', r.params.id), 'user not found');
      if (r.user!.role === 'manager' && u.role !== 'attendant') throw new AuthError('FORBIDDEN', 'managers can only edit attendants');
      if (u.role === 'owner' && r.user!.id !== r.params.id) throw new AuthError('FORBIDDEN', 'the owner account can only be edited by the owner');
      const b = r.body;
      ctx.db.tx(() => {
        if (b.displayName !== undefined) ctx.db.run('UPDATE users SET display_name=? WHERE id=?', b.displayName.trim(), r.params.id);
        if (b.canSeeMoney !== undefined) ctx.db.run('UPDATE users SET can_see_money=? WHERE id=?', b.canSeeMoney ? 1 : 0, r.params.id);
        if (b.voidLimitMinor !== undefined) ctx.db.run('UPDATE users SET void_limit_minor=? WHERE id=?', b.voidLimitMinor, r.params.id);
        if (b.discountLimitMinor !== undefined) ctx.db.run('UPDATE users SET discount_limit_minor=? WHERE id=?', b.discountLimitMinor, r.params.id);
        if (b.active !== undefined) { if (r.params.id === r.user!.id && !b.active) throw new AuthError('FORBIDDEN', 'you cannot deactivate yourself'); ctx.db.run('UPDATE users SET active=? WHERE id=?', b.active ? 1 : 0, r.params.id); if (!b.active) auth.revokeAllSessions(ctx, r.params.id); }
        if (b.password || b.pin) auth.setCredentials(ctx, r.params.id, { password: b.password, pin: b.pin }, r.user!.id);
      });
      return ok({ ok: true });
    } });

  // settings, daraja, notifications, privacy
  const SETTING_RULES: Record<string, 'int' | 'bool' | 'text' | 'color' | 'sev'> = { 'c2b.auto_credit': 'bool', 'stk.expiry_ms': 'int', 'stk.late_window_ms': 'int', 'stk.verify_with_query': 'bool', 'stk.cooldown_ms': 'int', 'limits.stk_per_phone_hour': 'int', 'limits.stk_per_ip_hour': 'int', 'limits.stk_per_table_hour': 'int',
    'cash.variance_threshold_minor': 'int', 'cash.offline_enabled': 'bool', 'cash.offline_max_minor': 'int', 'callback.ip_allowlist': 'text', 'device.offline_after_ms': 'int', 'device.credits_waiting_alert_ms': 'int', 'vend.max_per_hour': 'int', 'coins.variance_threshold_minor': 'int',
    'manual.max_per_shift': 'int', 'notify.min_severity': 'sev', 'retention.phone_days': 'int', 'business.name': 'text', 'public.base_url': 'text', 'brand.color': 'color' };
  route({ method: 'GET', path: '/api/settings', auth: 'user', roles: M, handler: () => ok({ settings: Object.fromEntries(Object.keys(SETTING_RULES).map((k) => [k, getSetting(ctx, k)])) }) });
  route({ method: 'PUT', path: '/api/settings', auth: 'user', roles: O, body: { settings: f.free() }, handler: (r) => {
    const entries = Object.entries(r.body.settings as Record<string, unknown>); const bad: string[] = [];
    for (const [k, v] of entries) { const rule = SETTING_RULES[k]; const s = String(v);
      if (!rule) bad.push(`${k}: unknown setting`); else if (rule === 'int' && !/^\d{1,12}$/.test(s)) bad.push(`${k}: must be a whole number`); else if (rule === 'bool' && !['0', '1'].includes(s)) bad.push(`${k}: must be 0 or 1`);
      else if (rule === 'color' && !/^#[0-9a-fA-F]{6}$/.test(s)) bad.push(`${k}: must be #rrggbb`); else if (rule === 'sev' && !['LOW', 'MEDIUM', 'HIGH'].includes(s)) bad.push(`${k}: invalid`);
      else if (rule === 'text' && (s.length > 300 || (k === 'public.base_url' && s && !/^https?:\/\/[^\s/]+$/.test(s)))) bad.push(`${k}: invalid`); }
    if (bad.length) throw new CashError('INVALID', bad.join('; '));
    ctx.db.tx(() => { for (const [k, v] of entries) setSetting(ctx, k, String(v)); }); return ok({ ok: true });
  } });
  route({ method: 'GET', path: '/api/daraja', auth: 'user', roles: O, handler: () => { const c = loadDarajaConfig(ctx); return ok({ configured: !!c, env: c?.env, shortcode: c?.shortcode, partyB: c?.partyB, txType: c?.txType, callbackBaseUrl: c?.callbackBaseUrl,
    stkCallbackUrl: c ? `${c.callbackBaseUrl}/api/mpesa/stk-callback/${c.callbackToken}` : null, c2bConfirmationUrl: c ? `${c.callbackBaseUrl}/api/mpesa/c2b/confirmation/${c.callbackToken}` : null, c2bValidationUrl: c ? `${c.callbackBaseUrl}/api/mpesa/c2b/validation/${c.callbackToken}` : null }); } });
  route({ method: 'PUT', path: '/api/daraja', auth: 'user', roles: O, body: { env: f.enum(['sandbox', 'production']), shortcode: f.str({ min: 3, max: 12, re: /^\d+$/ }), partyB: f.str({ opt: true, min: 3, max: 12, re: /^\d+$/ }), passkey: f.str({ min: 10, max: 200 }), consumerKey: f.str({ min: 5, max: 200 }), consumerSecret: f.str({ min: 5, max: 200 }),
      txType: f.enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']), callbackBaseUrl: f.str({ re: /^https:\/\/[^\s/]+$/, max: 200 }), rotateCallbackToken: f.bool({ opt: true }) },
    handler: (r) => { const prev = loadDarajaConfig(ctx); const b = r.body;
      saveDarajaConfig(ctx, { env: b.env, shortcode: b.shortcode, partyB: b.partyB ?? b.shortcode, passkey: b.passkey, consumerKey: b.consumerKey, consumerSecret: b.consumerSecret, txType: b.txType, callbackBaseUrl: b.callbackBaseUrl, callbackToken: !prev || b.rotateCallbackToken ? newCallbackToken() : prev.callbackToken }, r.user!.id); return ok({ ok: true }); } });
  route({ method: 'POST', path: '/api/daraja/test', auth: 'user', roles: O, limit: { per: 10, windowMs: 600_000 }, handler: async () => { const c = client(); return ok(c ? await testDarajaConnection(c) : { ok: false, message: 'Save the Daraja settings first.' }); } });
  route({ method: 'GET', path: '/api/notifications', auth: 'user', roles: O, handler: () => { const c = loadNotifyConfig(ctx); return ok({ sms: !!c.sms, telegram: !!c.telegram, webhook: !!c.webhook, email: !!c.email }); } });
  route({ method: 'PUT', path: '/api/notifications', auth: 'user', roles: O, body: { sms: f.obj({ username: f.str({ max: 60 }), apiKey: f.str({ max: 200 }), to: f.arr(f.str({ max: 20 }), 10), sender: f.str({ opt: true, max: 20 }) }, { opt: true }),
      telegram: f.obj({ botToken: f.str({ max: 200 }), chatId: f.str({ max: 40 }) }, { opt: true }), webhook: f.obj({ url: f.str({ re: /^https:\/\//, max: 300 }), secret: f.str({ opt: true, max: 100 }) }, { opt: true }),
      email: f.obj({ host: f.str({ max: 200 }), port: f.int({ min: 1, max: 65535 }), secure: f.bool(), user: f.str({ max: 200 }), pass: f.str({ max: 200 }), from: f.str({ max: 200 }), to: f.arr(f.str({ max: 200 }), 10) }, { opt: true }) },
    handler: (r) => { saveNotifyConfig(ctx, r.body as NotifyConfig); return ok({ ok: true }); } });
  route({ method: 'POST', path: '/api/notifications/test', auth: 'user', roles: O, limit: { per: 5, windowMs: 600_000 }, handler: async () => {
    ctx.db.run('INSERT INTO alerts(id,kind,severity,table_id,message,created_at) VALUES (?,?,?,?,?,?)', randomUUID(), 'TEST', 'HIGH', null, 'Test notification from your pool table system', ctx.now().toISOString()); return ok(await deliverAlerts(ctx)); } });
  route({ method: 'POST', path: '/api/privacy/export', auth: 'user', roles: O, body: { phone: f.str({ min: 7, max: 20 }) }, handler: (r) => ok(exportPersonalData(ctx, r.body.phone, pepper)) });
  route({ method: 'POST', path: '/api/privacy/erase', auth: 'user', roles: O, idem: 'required', body: { phone: f.str({ min: 7, max: 20 }), reason: f.str({ min: 3, max: 300 }) }, handler: (r) => ok(erasePersonalData(ctx, r.body.phone, pepper, r.user!.id, r.body.reason)) });

  // owner dashboard (used by the owner mobile app)
  route({ method: 'GET', path: '/api/owner/dashboard', auth: 'user', roles: M, handler: () => {
    const today = periodRange('today', ctx.now()); const yday = periodRange('yesterday', ctx.now());
    const s = ownerSummary(ctx, today.from, today.to); const y = ownerSummary(ctx, yday.from, yday.to);
    return ok({ today: s, yesterday: { poolRevenueMinor: y.poolRevenueMinor, gamesSold: y.gamesSold, gamesPlayed: y.gamesPlayed },
      openAlerts: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM alerts WHERE resolved_at IS NULL')!.n, unallocatedPending: s.unallocated.pendingCount, business: getSetting(ctx, 'business.name') });
  } });

  // ---------------- firmware (OTA) ----------------
  route({ method: 'POST', path: '/api/firmware', auth: 'user', roles: O, maxBody: 3_000_000, idem: 'required',
    body: { version: f.str({ min: 1, max: 20, re: /^[0-9A-Za-z._-]+$/ }), signature: f.str({ min: 20, max: 200, re: /^[A-Za-z0-9+/=]+$/ }), dataBase64: f.str({ min: 100, max: 2_700_000, re: /^[A-Za-z0-9+/=]+$/ }) },
    handler: (r) => {
      const data = Buffer.from(r.body.dataBase64, 'base64'); if (data.length < 100_000 || data.length > 1_900_000) throw new CashError('INVALID', 'firmware image must be 100 KB to 1.9 MB');
      const { createHash } = require_crypto(); const sha = createHash('sha256').update(data).digest('hex');
      ctx.db.tx(() => { if (ctx.db.get('SELECT 1 FROM firmware_releases WHERE version=?', r.body.version)) throw new CashError('EXISTS', 'that version already exists (versions are immutable)');
        ctx.db.run('INSERT INTO firmware_releases(version,sha256,signature,size,data,created_by,created_at) VALUES (?,?,?,?,?,?,?)', r.body.version, sha, r.body.signature, data.length, data, r.user!.id, ctx.now().toISOString()); });
      return ok({ version: r.body.version, sha256: sha, size: data.length }, 201);
    } });
  route({ method: 'GET', path: '/api/firmware', auth: 'user', roles: O, handler: () => ok({ releases: ctx.db.all('SELECT version, sha256, size, active, created_at FROM firmware_releases ORDER BY created_at DESC') }) });
  route({ method: 'PATCH', path: '/api/firmware/:version', auth: 'user', roles: O, body: { active: f.bool() }, handler: (r) => ctx.db.tx(() => {
    if (!ctx.db.get('SELECT 1 FROM firmware_releases WHERE version=?', r.params.version)) throw new CashError('NOT_FOUND', 'unknown version');
    ctx.db.run('UPDATE firmware_releases SET active=0'); if (r.body.active) ctx.db.run('UPDATE firmware_releases SET active=1 WHERE version=?', r.params.version);
    return ok({ ok: true }); }) });
  route({ method: 'GET', path: '/api/device/ota/:version', auth: 'device', handler: (r) => {
    const rel = ctx.db.get<{ data: Uint8Array }>('SELECT data FROM firmware_releases WHERE version=? AND active=1', r.params.version);
    if (!rel) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such active release' } } };
    return { raw: Buffer.from(rel.data), contentType: 'application/octet-stream' };
  } });

  // ---------------- device protocol ----------------
  route({ method: 'POST', path: '/api/device/sync', auth: 'device', maxBody: 32_768,
    body: { fw: f.str({ opt: true, max: 40 }), uptimeS: f.int({ opt: true, min: 0 }), rssi: f.int({ opt: true, min: -150, max: 0 }), freeHeap: f.int({ opt: true, min: 0 }), resetReason: f.str({ opt: true, max: 30 }), sensors: f.free({ opt: true }), wait: f.int({ opt: true, min: 0, max: 25 }),
      acks: f.arr(f.obj({ vendId: f.str({ max: 60 }), nonce: f.str({ max: 40 }), status: f.enum(['ACK', 'REJECT', 'CONFIRMED']), ts: f.int(), signature: f.str({ max: 80 }) }), 20, { opt: true }),
      events: f.arr(f.obj({ id: f.str({ min: 1, max: 60 }), kind: f.enum(['coin', 'tamper', 'tamper_clear', 'unauthorized_vend', 'sensor_fault', 'vend_done', 'manual_request']), data: f.free({ opt: true }) }), 50, { opt: true }) },
    handler: async (r) => {
      const dv = r.device!; const { wait, ...payload } = r.body;
      let out = processSync(ctx, dv.tableId, dv.deviceId, payload);
      if (!out.commands.length && wait > 0 && !(payload.acks?.length)) { await hub.waitTable(dv.tableId, wait * 1000); out = { ...out, commands: commandsForDevice(ctx, dv.tableId) }; }
      return ok({ commands: out.commands.map((c) => ({ command: c.command, signature: c.signature })), ackResults: out.ackResults, config: out.config });
    } });
  void formatKes;

  /** Periodic jobs: watchdog, stuck vends, STK reconciliation, alert delivery. Safe to run at boot and on a timer. */
  const background = async (): Promise<void> => {
    monitorTables(ctx);
    const rec = await reconcilePending(ctx, client()).catch(() => ({ credited: [] as string[], checked: 0 }));
    for (const t of rec.credited) afterCredit(t);
    if (rec.checked) hub.emit('pay');
    await deliverAlerts(ctx).catch(() => undefined);
  };
  void DEFAULTS;
  return { app, hub, background };
}
