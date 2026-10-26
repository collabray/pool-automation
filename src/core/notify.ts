import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import type { Ctx } from './ctx.ts';
import { getSecretSetting, getSetting, setSecretSetting } from './settings.ts';

export interface NotifyConfig {
  sms?: { username: string; apiKey: string; to: string[]; sender?: string; baseUrl?: string };
  telegram?: { botToken: string; chatId: string; baseUrl?: string };
  webhook?: { url: string; secret?: string };
  email?: { host: string; port: number; secure: boolean; user: string; pass: string; from: string; to: string[] };
}
export const saveNotifyConfig = (ctx: Ctx, c: NotifyConfig): void => setSecretSetting(ctx, 'notify.config', JSON.stringify(c));
export const loadNotifyConfig = (ctx: Ctx): NotifyConfig => { const raw = getSecretSetting(ctx, 'notify.config'); return raw ? JSON.parse(raw) : {}; };

type Sev = 'LOW' | 'MEDIUM' | 'HIGH';
const RANK: Record<Sev, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export async function sendSms(c: NonNullable<NotifyConfig['sms']>, text: string): Promise<void> {
  const res = await fetch(`${c.baseUrl ?? 'https://api.africastalking.com'}/version1/messaging`, { method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { apiKey: c.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: c.username, to: c.to.join(','), message: text.slice(0, 300), ...(c.sender ? { from: c.sender } : {}) }) });
  if (!res.ok) throw new Error(`SMS HTTP ${res.status}`);
}
async function sendTelegram(c: NonNullable<NotifyConfig['telegram']>, text: string): Promise<void> {
  const res = await fetch(`${c.baseUrl ?? 'https://api.telegram.org'}/bot${c.botToken}/sendMessage`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.chatId, text }) });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}
async function sendWebhook(c: NonNullable<NotifyConfig['webhook']>, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const { createHmac } = await import('node:crypto');
  const res = await fetch(c.url, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', ...(c.secret ? { 'X-Signature': createHmac('sha256', c.secret).update(body).digest('hex') } : {}) }, body });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
}

/** Minimal SMTP client (AUTH LOGIN, implicit TLS or plain for tests). Header-injection safe: CR/LF are stripped from all fields. */
export async function sendEmail(c: NonNullable<NotifyConfig['email']>, subject: string, text: string): Promise<void> {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const sock: Socket = c.secure ? tlsConnect({ host: c.host, port: c.port, servername: c.host }) : netConnect({ host: c.host, port: c.port });
  sock.setTimeout(20_000);
  let buf = '';
  const waiters: ((l: string) => void)[] = [];
  sock.on('data', (d) => { buf += d.toString(); for (;;) { const m = /^(\d{3})([ -])(.*)\r\n/m.exec(buf); if (!m) break; const lineEnd = buf.indexOf('\r\n') + 2; const line = buf.slice(0, lineEnd); buf = buf.slice(lineEnd); if (m[2] === ' ') waiters.shift()?.(line); } });
  const read = () => new Promise<string>((res, rej) => { waiters.push(res); sock.once('error', rej); sock.once('timeout', () => rej(new Error('SMTP timeout'))); });
  const cmd = async (line: string, expect: string) => { sock.write(line + '\r\n'); const r = await read(); if (!r.startsWith(expect)) throw new Error(`SMTP unexpected reply: ${r.trim()}`); };
  try {
    const greet = await read(); if (!greet.startsWith('220')) throw new Error('SMTP greeting failed');
    await cmd('EHLO pooltable.local', '250');
    await cmd('AUTH LOGIN', '334'); await cmd(Buffer.from(c.user).toString('base64'), '334'); await cmd(Buffer.from(c.pass).toString('base64'), '235');
    await cmd(`MAIL FROM:<${clean(c.from)}>`, '250');
    for (const to of c.to) await cmd(`RCPT TO:<${clean(to)}>`, '250');
    await cmd('DATA', '354');
    sock.write(`From: ${clean(c.from)}\r\nTo: ${c.to.map(clean).join(', ')}\r\nSubject: ${clean(subject)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text.replace(/^\./gm, '..').replace(/\r?\n/g, '\r\n')}\r\n.\r\n`);
    const r = await read(); if (!r.startsWith('250')) throw new Error('SMTP DATA rejected');
    sock.write('QUIT\r\n');
  } finally { sock.destroy(); }
}

/** Sends every not-yet-notified alert at or above notify.min_severity on all configured channels. A channel failing never blocks the others. */
export async function deliverAlerts(ctx: Ctx): Promise<{ delivered: number; errors: string[] }> {
  const cfg = loadNotifyConfig(ctx);
  const min = (getSetting(ctx, 'notify.min_severity') || 'HIGH') as Sev;
  const rows = ctx.db.all<{ id: string; kind: string; severity: Sev; message: string; table_id: string | null }>('SELECT id, kind, severity, message, table_id FROM alerts WHERE notified_at IS NULL AND resolved_at IS NULL ORDER BY created_at LIMIT 20');
  const errors: string[] = []; let delivered = 0;
  for (const a of rows) {
    if (RANK[a.severity] < RANK[min]) { ctx.db.run('UPDATE alerts SET notified_at=? WHERE id=?', ctx.now().toISOString(), a.id); continue; }
    const text = `[${a.severity}] ${a.kind}: ${a.message}`;
    const jobs: Promise<void>[] = [];
    if (cfg.sms) jobs.push(sendSms(cfg.sms, text)); if (cfg.telegram) jobs.push(sendTelegram(cfg.telegram, text));
    if (cfg.webhook) jobs.push(sendWebhook(cfg.webhook, { id: a.id, kind: a.kind, severity: a.severity, tableId: a.table_id, message: a.message }));
    if (cfg.email) jobs.push(sendEmail(cfg.email, `Pool table alert: ${a.kind}`, text));
    const res = await Promise.allSettled(jobs);
    res.forEach((r) => { if (r.status === 'rejected') errors.push(String(r.reason?.message ?? r.reason)); });
    if (!jobs.length || res.some((r) => r.status === 'fulfilled')) { ctx.db.run('UPDATE alerts SET notified_at=? WHERE id=?', ctx.now().toISOString(), a.id); delivered++; }
  }
  return { delivered, errors };
}
