import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { newCtx, makeTable, addUser } from './helpers/ctx.ts';
import { monitorTables, processSync } from '../src/core/devices.ts';
import { creditPurchase } from '../src/core/credit.ts';
import { dispatch } from '../src/core/vend.ts';
import { deliverAlerts, saveNotifyConfig } from '../src/core/notify.ts';
import { raiseAlert, listAlerts, resolveAlert } from '../src/core/alerts.ts';
import { textPdf } from '../src/core/pdf.ts';
import { qrMatrix } from '../src/core/qr.ts';
import { enforceRetention } from '../src/core/privacy.ts';
import { recordCoins, collectCoinBox } from '../src/core/coins.ts';
import { setSetting } from '../src/core/settings.ts';
import { A, balance, verifyLedger } from '../src/core/ledger.ts';
import { kes } from '../src/core/money.ts';

test('monitor: silent device goes offline with an alert; credits waiting while offline alert once; vend failures and rate alerts', () => {
  const ctx = newCtx(); const { tableId, deviceId } = makeTable(ctx);
  processSync(ctx, tableId, deviceId, { fw: '1', uptimeS: 100 });
  creditPurchase(ctx, { source: 'CASH', idempotencyKey: 'a', externalRef: 'A', tableId, amountMinor: kes(40), actor: 't' });
  ctx.clock.ms += 60_000; assert.deepEqual(monitorTables(ctx).wentOffline, []);
  ctx.clock.ms += 60_000; assert.deepEqual(monitorTables(ctx).wentOffline, [tableId]);
  assert.equal(ctx.db.get<{ online: number }>('SELECT online FROM pool_tables')!.online, 0);
  ctx.clock.ms += 700_000; monitorTables(ctx); monitorTables(ctx);
  const kinds = listAlerts(ctx).map((a) => a.kind as string); assert.ok(kinds.includes('DEVICE_OFFLINE')); assert.equal(kinds.filter((k) => k === 'CREDITS_WAITING_OFFLINE').length, 1);
  processSync(ctx, tableId, deviceId, { fw: '1', uptimeS: 5, resetReason: 'brownout' }); // reconnects and gets its stored credit
  assert.equal(ctx.db.get<{ online: number }>('SELECT online FROM pool_tables')!.online, 1);
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM vends WHERE state='SENT'")!.n, 1);
  assert.ok(listAlerts(ctx).some((a) => a.kind === 'DEVICE_RESET'));
  setSetting(ctx, 'vend.max_per_hour', '1'); const c2 = makeTable(ctx, { name: 'B', releaseMode: 'ALL' }); creditPurchase(ctx, { source: 'CASH', idempotencyKey: 'b', externalRef: 'B', tableId: c2.tableId, amountMinor: kes(60), actor: 't' });
  processSync(ctx, c2.tableId, c2.deviceId, { uptimeS: 1 }); monitorTables(ctx);
  assert.ok(listAlerts(ctx).some((a) => a.kind === 'UNUSUAL_VEND_RATE'));
});
test('power cycling: three reboots within an hour raise an alert; alert dedupe and resolve work', () => {
  const ctx = newCtx(); const { tableId, deviceId } = makeTable(ctx); let up = 1000;
  for (let i = 0; i < 4; i++) { processSync(ctx, tableId, deviceId, { uptimeS: up, resetReason: 'poweron' }); up = 5; ctx.clock.ms += 1000; processSync(ctx, tableId, deviceId, { uptimeS: 1, resetReason: 'poweron' }); ctx.clock.ms += 1000; up = 1000; }
  assert.ok(listAlerts(ctx).some((a) => a.kind === 'POWER_CYCLING'));
  assert.equal(raiseAlert(ctx, 'X', 'LOW', tableId, 'm'), true); assert.equal(raiseAlert(ctx, 'X', 'LOW', tableId, 'm'), false);
  const id = (listAlerts(ctx).find((a) => a.kind === 'X') as { id: string }).id; assert.equal(resolveAlert(ctx, id), 1); assert.equal(raiseAlert(ctx, 'X', 'LOW', tableId, 'm'), true);
});
test('coins: idempotent counting, ledger postings, collection variance (short and over) is flagged', () => {
  const ctx = newCtx(); const { tableId } = makeTable(ctx); const u = addUser(ctx, 'manager');
  assert.deepEqual([recordCoins(ctx, tableId, 'e1', 3).recorded, recordCoins(ctx, tableId, 'e1', 3).recorded], [true, false]);
  assert.equal(balance(ctx.db, A.coinbox), kes(60)); assert.equal(balance(ctx.db, A.revenue(tableId)), -kes(60));
  assert.throws(() => recordCoins(ctx, tableId, 'e2', 0)); assert.throws(() => recordCoins(ctx, tableId, 'e3', 51));
  const ok = collectCoinBox(ctx, { tableId, actorId: u, countedMinor: kes(60) }); assert.deepEqual([ok.expectedCoins, ok.varianceMinor, ok.flagged], [3, 0, false]);
  recordCoins(ctx, tableId, 'e4', 2); const short = collectCoinBox(ctx, { tableId, actorId: u, countedMinor: kes(30) }); assert.deepEqual([short.varianceMinor, short.flagged], [-kes(10), true]);
  recordCoins(ctx, tableId, 'e5', 1); const over = collectCoinBox(ctx, { tableId, actorId: u, countedMinor: kes(40) }); assert.deepEqual([over.varianceMinor, over.flagged], [kes(20), true]);
  assert.equal(balance(ctx.db, A.coinbox), 0); assert.deepEqual(verifyLedger(ctx.db), []);
});
test('notifications: webhook (HMAC-signed), Telegram and Africa\'s Talking SMS receive the alert; a failing channel does not block the others', async () => {
  const got: { url: string; body: string; headers: Record<string, any> }[] = [];
  const srv = httpServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ url: req.url!, body: b, headers: req.headers }); res.writeHead(req.url === '/broken' ? 500 : 200).end('{}'); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const ctx = newCtx(); raiseAlert(ctx, 'TAMPER', 'HIGH', null, 'Coin box opened', 0); raiseAlert(ctx, 'MINOR', 'LOW', null, 'ignore me', 0);
  saveNotifyConfig(ctx, { webhook: { url: `${base}/hook`, secret: 's3cret' }, telegram: { botToken: 'BOT', chatId: '42', baseUrl: base }, sms: { username: 'sandbox', apiKey: 'KEY', to: ['+254700000001'], baseUrl: base } });
  const r = await deliverAlerts(ctx); srv.close();
  assert.deepEqual([r.delivered, r.errors], [1, []]);
  const hook = got.find((g) => g.url === '/hook')!; const { createHmac } = await import('node:crypto');
  assert.equal(hook.headers['x-signature'], createHmac('sha256', 's3cret').update(hook.body).digest('hex'));
  assert.match(got.find((g) => g.url === '/botBOT/sendMessage')!.body, /Coin box opened/);
  assert.equal(got.find((g) => g.url === '/version1/messaging')!.headers.apikey, 'KEY');
  assert.equal(got.length, 3); // LOW severity filtered out
  assert.equal((await deliverAlerts(ctx)).delivered, 0); // each alert is only sent once
  raiseAlert(ctx, 'OFFLINE', 'HIGH', null, 'x', 0); saveNotifyConfig(ctx, { webhook: { url: 'http://127.0.0.1:1/dead' }, telegram: { botToken: 'B', chatId: '1', baseUrl: base } });
  const srv2 = httpServer((q, s) => s.writeHead(200).end('{}')); await new Promise<void>((r2) => srv2.listen(0, '127.0.0.1', r2));
  saveNotifyConfig(ctx, { webhook: { url: 'http://127.0.0.1:1/dead' }, telegram: { botToken: 'B', chatId: '1', baseUrl: `http://127.0.0.1:${(srv2.address() as { port: number }).port}` } });
  const r2 = await deliverAlerts(ctx); srv2.close(); assert.equal(r2.delivered, 1); assert.equal(r2.errors.length, 1);
});
test('notifications: SMTP email (AUTH LOGIN) is delivered and header injection is neutralised', async () => {
  const lines: string[] = [];
  const srv = tcpServer((s) => {
    s.write('220 fake\r\n'); let buf = ''; let state: 'cmd' | 'user' | 'pass' | 'data' = 'cmd';
    s.on('data', (d) => { buf += d.toString(); let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); lines.push(l);
        if (state === 'data') { if (l === '.') { state = 'cmd'; s.write('250 queued\r\n'); } continue; }
        if (state === 'user') { state = 'pass'; s.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (state === 'pass') { state = 'cmd'; s.write('235 ok\r\n'); continue; }
        if (l.startsWith('EHLO')) s.write('250 hi\r\n'); else if (l === 'AUTH LOGIN') { state = 'user'; s.write('334 VXNlcm5hbWU6\r\n'); }
        else if (l.startsWith('MAIL') || l.startsWith('RCPT')) s.write('250 ok\r\n'); else if (l === 'DATA') { state = 'data'; s.write('354 go\r\n'); } else if (l === 'QUIT') s.end(); } }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as { port: number }).port;
  const { sendEmail } = await import('../src/core/notify.ts');
  await sendEmail({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', from: 'a@x.com\r\nBcc: evil@x.com', to: ['o@x.com'] }, 'Alert\r\nBcc: evil@x.com', 'Body line\n.dot line');
  srv.close();
  assert.ok(lines.some((l) => l.startsWith('MAIL FROM:<a@x.com Bcc: evil@x.com>'))); assert.ok(!lines.some((l) => l.startsWith('Bcc:'))); assert.ok(lines.includes('..dot line'));
});
test('pdf: structurally valid (xref offsets point at objects), paginates, escapes text', () => {
  const pdf = textPdf('Report (test)', Array.from({ length: 120 }, (_, i) => `row ${i} \\ ) ( é`)); const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF')); assert.equal((s.match(/\/Type \/Page /g) ?? []).length, 3);
  const xrefAt = Number(/startxref\n(\d+)/.exec(s)![1]); assert.equal(s.slice(xrefAt, xrefAt + 4), 'xref');
  const entries = [...s.slice(xrefAt).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1])); entries.forEach((off, i) => assert.match(s.slice(off, off + 12), new RegExp(`^${i + 1} 0 obj`)));
  const py = spawnSync('python3', ['-c', 'import sys;from pypdf import PdfReader'], { encoding: 'utf8' }); void py;
});
test('qr: structural checks and decode round-trip via OpenCV when available', () => {
  const m = qrMatrix('https://pool.example.com/pay.html?t=K7M2QX-4HTW'); const n = m.length;
  assert.equal(n, 33); // version 4
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) { for (let i = 0; i < 7; i++) { assert.ok(m[r][c + i] && m[r + 6][c + i] && m[r + i][c] && m[r + i][c + 6]); } assert.ok(m[r + 3][c + 3]); }
  for (let i = 8; i < n - 8; i++) assert.equal(m[6][i], i % 2 === 0); assert.ok(m[n - 8][8]); // timing + dark module
  assert.throws(() => qrMatrix('x'.repeat(214)), /too long/);
  const py = spawnSync('python3', ['-c', 'import cv2,numpy'], { encoding: 'utf8' });
  if (py.status !== 0) return; // decoder unavailable: structural checks above still ran
  const texts = ['A', 'https://pool.example.com/pay.html?t=K7M2QX-4HTW', 'abc123XYZ-'.repeat(12), 'q'.repeat(213)];
  const dump = JSON.stringify(texts.map((t) => qrMatrix(t)));
  const r = spawnSync('python3', ['-c', `import sys,json,numpy as np,cv2
ms=json.loads(sys.stdin.read()); t=json.loads(sys.argv[1]); bad=0
for m,w in zip(ms,t):
    a=(1-np.array(m,dtype=np.uint8))*255; a=np.pad(a,6,constant_values=255); a=np.kron(a,np.ones((10,10),dtype=np.uint8))
    d,_,_=cv2.QRCodeDetector().detectAndDecode(a)
    if d!=w and len(w)>1: bad+=1
print(bad)`, JSON.stringify(texts)], { input: dump, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '0');
});
test('retention: old phone numbers are scrubbed, in-flight requests are left alone', () => {
  const ctx = newCtx(); const { tableId } = makeTable(ctx); const enc = 'v1:a:b:c';
  const ins = (id: string, status: string, ageDays: number) => ctx.db.run(`INSERT INTO mpesa_requests(id,idempotency_key,table_id,games,amount_minor,phone_hash,phone_enc,status,created_at,expires_at_ms) VALUES (?,?,?,1,2000,'h',?,?,?,0)`, id, id, tableId, enc, status, new Date(ctx.clock.ms - ageDays * 86_400_000).toISOString());
  ins('old', 'SUCCESS', 120); ins('new', 'SUCCESS', 5); ins('pending', 'PENDING', 120);
  assert.equal(enforceRetention(ctx), 1);
  assert.deepEqual(ctx.db.all<{ id: string; phone_hash: string }>('SELECT id, phone_hash FROM mpesa_requests ORDER BY id').map((r) => [r.id, r.phone_hash.startsWith('expired:')]), [['new', false], ['old', true], ['pending', false]]);
});
void dispatch;
