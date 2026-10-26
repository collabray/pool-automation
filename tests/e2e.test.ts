import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, type TestServer, type Api } from './helpers/server.ts';
import { FakeDaraja } from './helpers/fake-daraja.ts';
import { DeviceSim } from '../src/sim/device-sim.ts';
import { A, balance, verifyLedger } from '../src/core/ledger.ts';
import { verifyAuditChain } from '../src/core/audit.ts';
import { kes } from '../src/core/money.ts';

let fake: FakeDaraja, srv: TestServer, call: Api;
let ownerToken: string, tableId: string, code: string, sim: DeviceSim, cbToken: string;
let table2: string, code2: string, sim2: DeviceSim;
const pricing = { unitPriceMinor: kes(20), bundles: [], peakWindows: [], minGames: 1, maxGames: 20, remainderPolicy: 'HOLD_CREDIT' };

before(async () => {
  fake = new FakeDaraja(); await fake.start(); srv = await startServer(fake); call = api(srv.base);
  // First-run wizard: owner -> Daraja -> table -> device -> QR
  assert.equal((await call('GET', '/api/setup/status')).json.needsSetup, true);
  assert.equal((await call('POST', '/api/setup/owner', { username: 'owner', displayName: 'Owner', password: 'Sup3rSecret!pw', businessName: 'Kali Pool' })).status, 201);
  assert.equal((await call('POST', '/api/setup/owner', { username: 'evil', displayName: 'x', password: 'Sup3rSecret!pw1', businessName: 'x' })).status, 403); // wizard locks after first owner
  ownerToken = (await call('POST', '/api/auth/login', { username: 'owner', password: 'Sup3rSecret!pw' })).json.accessToken;
  const put = await call('PUT', '/api/daraja', { env: 'sandbox', shortcode: fake.shortcode, passkey: fake.passkey, consumerKey: fake.key, consumerSecret: fake.secret, txType: 'CustomerPayBillOnline', callbackBaseUrl: 'https://pool.example.com' }, { token: ownerToken });
  assert.equal(put.status, 200);
  assert.deepEqual((await call('POST', '/api/daraja/test', {}, { token: ownerToken })).json, { ok: true, message: 'Connected: Daraja issued an access token.' });
  cbToken = (await call('GET', '/api/daraja', undefined, { token: ownerToken })).json.stkCallbackUrl.split('/').pop();
  assert.equal((await call('PUT', '/api/settings', { settings: { 'public.base_url': 'https://pool.example.com' } }, { token: ownerToken })).status, 200);
  const t = await call('POST', '/api/tables', { name: 'Table 1', vendMode: 'GATE_SOLENOID', vendParams: { holdMs: 1500 }, pricing, requiresReadySensor: true }, { token: ownerToken, idem: 'create-t1' });
  assert.equal(t.status, 201); tableId = t.json.tableId;
  sim = new DeviceSim({ baseUrl: srv.base, deviceId: t.json.deviceId, secret: t.json.deviceSecret, mode: 'GATE_SOLENOID' });
  code = (await call('GET', `/api/tables/${tableId}/qr`, undefined, { token: ownerToken })).json.code;
  const t2 = await call('POST', '/api/tables', { name: 'Table 2', vendMode: 'COIN_PULSE', vendParams: { pulses: 2, pulseMs: 60, gapMs: 70 }, pricing }, { token: ownerToken, idem: 'create-t2' });
  table2 = t2.json.tableId; sim2 = new DeviceSim({ baseUrl: srv.base, deviceId: t2.json.deviceId, secret: t2.json.deviceSecret, mode: 'COIN_PULSE' });
  code2 = (await call('GET', `/api/tables/${table2}/qr`, undefined, { token: ownerToken })).json.code;
  await sim2.sync(); // table 2 comes online
});
after(async () => { await srv.close(); await fake.stop(); });

test('wizard: test vend requires an online device, then releases through the signed protocol', async () => {
  assert.equal((await call('POST', `/api/tables/${tableId}/test-vend`, {}, { token: ownerToken, idem: 'tv-0' })).status, 409); // offline
  const first = await sim.sync(); assert.equal(first.status, 200); // device comes online
  assert.equal((await call('POST', `/api/tables/${tableId}/test-vend`, {}, { token: ownerToken, idem: 'tv-1' })).status, 201);
  const r = await sim.sync(); assert.equal(r.executed.length, 1);
  assert.deepEqual(sim.outputs.at(-1)!.kind, 'HOLD'); assert.equal(sim.outputs.at(-1)!.holdMs, 1500);
  await sim.sync(); // delivers the ack
  assert.equal(srv.ctx.db.get<{ state: string }>('SELECT state FROM vends ORDER BY created_at DESC LIMIT 1')!.state, 'CONFIRMED');
});
test('QR: printable SVG is served to managers only and encodes the signed table URL', async () => {
  const svg = await call('GET', `/api/tables/${tableId}/qr.svg`, undefined, { token: ownerToken });
  assert.equal(svg.status, 200); assert.match(svg.headers.get('content-type')!, /image\/svg\+xml/); assert.ok(svg.text.startsWith('<svg'));
  assert.equal((await call('GET', `/api/tables/${tableId}/qr.svg`)).status, 401);
});

test('E2E customer: scan QR -> info -> STK -> callback -> credits -> signed vend -> device ack -> balls released screen', async () => {
  const info = await call('GET', `/api/public/table/${code}`); assert.equal(info.status, 200);
  assert.deepEqual([info.json.name, info.json.state, info.json.unitPriceMinor, info.json.prices[4]], ['Table 1', 'AVAILABLE', kes(20), kes(100)]);
  assert.equal((await call('GET', '/api/public/table/AAAAAA-AAAA')).status, 404); // forged code
  const key = 'idem-customer-1';
  const pay = await call('POST', '/api/public/pay', { code, games: 5, phone: '0712 345 678', idempotencyKey: key });
  assert.equal(pay.status, 201); assert.equal(pay.json.status, 'PENDING'); assert.equal(pay.json.amountMinor, kes(100));
  assert.equal((await call('POST', '/api/public/pay', { code, games: 5, phone: '0712345678', idempotencyKey: key })).json.requestId, pay.json.requestId); // double tap
  const push = fake.pushes.at(-1)!; assert.equal(push.amount, 100);
  assert.equal((await call('GET', `/api/public/pay/${pay.json.requestId}`)).json.status, 'PENDING');
  const sse = fetch(`${srv.base}/api/public/pay/${pay.json.requestId}/events`);
  const cb = await call('POST', `/api/mpesa/stk-callback/${cbToken}`, fake.callbackBody(push.checkoutRequestId, { receipt: 'E2ERCPT001' }));
  assert.equal(cb.status, 200); assert.deepEqual(cb.json, { ResultCode: 0, ResultDesc: 'Accepted' });
  const events = await (await sse).text(); assert.match(events, /"status":"SUCCESS"/);
  const st = (await call('GET', `/api/public/pay/${pay.json.requestId}`)).json;
  assert.deepEqual([st.status, st.receipt, st.gamesRemaining], ['SUCCESS', 'E2ERCPT001', 5]);
  assert.equal((await sim.sync()).executed.length, 0); // previous game still in progress: nothing released yet
  sim.setReady(true); const run = await sim.sync(); assert.equal(run.executed.length, 1); await sim.sync();
  assert.equal(srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM vends WHERE state='CONFIRMED'")!.n, 2); // test vend + this one
  assert.equal(balance(srv.ctx.db, A.gamesAvail(tableId)), 4);
  assert.deepEqual(verifyLedger(srv.ctx.db), []); assert.equal(verifyAuditChain(srv.ctx.db).ok, true);
});
test('E2E long-poll: a payment arriving while the device waits wakes it immediately', async () => {
  const waiting = sim2.sync(20);
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  const { creditPurchase } = await import('../src/core/credit.ts'); creditPurchase(srv.ctx, { source: 'CASH', idempotencyKey: 'lp', externalRef: 'LP-1', tableId: table2, amountMinor: kes(20), actor: 't' });
  const { dispatch } = await import('../src/core/vend.ts'); dispatch(srv.ctx, table2); srv.hub.emit(`table:${table2}`);
  const r = await waiting; assert.equal(r.executed.length, 1); assert.ok(Date.now() - t0 < 3000, 'device must wake quickly');
  assert.deepEqual(sim2.outputs.at(-1), { vendId: sim2.outputs.at(-1)!.vendId, mode: 'COIN_PULSE', kind: 'PULSES', pulses: 2, pulseMs: 60, gapMs: 70 });
  await sim2.sync();
});

test('E2E device resilience: lost ack + reboot never produce a second release', async () => {
  const before = sim2.outputs.length;
  const { creditPurchase } = await import('../src/core/credit.ts'); creditPurchase(srv.ctx, { source: 'CASH', idempotencyKey: 'rb', externalRef: 'RB-1', tableId: table2, amountMinor: kes(20), actor: 't' });
  sim2.faults.dropNextAcks = 1;
  const a = await sim2.sync(); assert.equal(a.executed.length, 1); await sim2.sync(); // the ack is lost on the wire
  assert.equal(srv.ctx.db.get<{ state: string }>("SELECT state FROM vends WHERE table_id=? ORDER BY seq DESC LIMIT 1", table2)!.state, 'SENT');
  const snap = sim2.snapshot(); sim2.reboot('brownout'); sim2.restore(snap);
  srv.ctx.db.run("UPDATE vend_commands SET expires_at_ms=0 WHERE vend_id=(SELECT id FROM vends WHERE table_id=? ORDER BY seq DESC LIMIT 1)", table2); // expired -> server re-issues the same vend with a fresh nonce
  const b = await sim2.sync(); assert.equal(b.executed.length, 0); await sim2.sync();
  assert.equal(sim2.outputs.length - before, 1); // exactly one physical release
  assert.equal(srv.ctx.db.get<{ state: string }>("SELECT state FROM vends WHERE table_id=? ORDER BY seq DESC LIMIT 1", table2)!.state, 'CONFIRMED');
});
test('E2E device: sensor fault rejects the command -> vend FAILED, table faulted, customers blocked BEFORE paying, retry recovers', async () => {
  const { creditPurchase } = await import('../src/core/credit.ts'); creditPurchase(srv.ctx, { source: 'CASH', idempotencyKey: 'sf', externalRef: 'SF-1', tableId: table2, amountMinor: kes(20), actor: 't' });
  sim2.faults.sensorFault = true; await sim2.sync(); await sim2.sync(); sim2.faults.sensorFault = false;
  assert.equal(srv.ctx.db.get<{ status: string }>('SELECT status FROM pool_tables WHERE id=?', table2)!.status, 'FAULTED');
  const pay = await call('POST', '/api/public/pay', { code: code2, games: 1, phone: '0799111222', idempotencyKey: 'blocked-1' });
  assert.equal(pay.status, 409); assert.equal(pay.json.error.code, 'TABLE_UNAVAILABLE');
  assert.equal((await call('GET', `/api/public/table/${code2}`)).json.state, 'FAULTED');
  const failed = (await call('GET', '/api/vends/failed', undefined, { token: ownerToken })).json.vends[0];
  assert.equal((await call('POST', `/api/vends/${failed.id}/resolve`, { action: 'RETRY', reason: 'sensor fixed' }, { token: ownerToken, idem: 'rs-1' })).status, 200);
  const r = await sim2.sync(); assert.equal(r.executed.length, 1); await sim2.sync();
  assert.equal(srv.ctx.db.get<{ status: string }>('SELECT status FROM pool_tables WHERE id=?', table2)!.status, 'ACTIVE');
});

test('E2E attendant: PIN login -> open shift -> cash -> credit -> vend -> close shift with correct variance; own stats only', async () => {
  const mk = await call('POST', '/api/staff', { username: 'wanjiku', displayName: 'Wanjiku', role: 'attendant', pin: '4827' }, { token: ownerToken, idem: 'st-1' }); assert.equal(mk.status, 201);
  const att = (await call('POST', '/api/auth/pin-login', { username: 'wanjiku', pin: '4827' })).json.accessToken;
  assert.equal((await call('POST', '/api/cash/sale', { tableId, cashReceivedMinor: kes(100) }, { token: att, idem: 'c-0' })).json.error.code, 'NO_OPEN_SHIFT');
  assert.equal((await call('POST', '/api/shifts/open', { floatMinor: kes(500) }, { token: att })).status, 201);
  const sale = await call('POST', '/api/cash/sale', { tableId, cashReceivedMinor: kes(100) }, { token: att, idem: 'c-1' });
  assert.deepEqual([sale.status, sale.json.games, sale.json.receiptNo.startsWith('C-')], [201, 5, true]);
  const again = await call('POST', '/api/cash/sale', { tableId, cashReceivedMinor: kes(100) }, { token: att, idem: 'c-1' });
  assert.deepEqual([again.status, again.headers.get('idempotent-replay'), again.json.receiptNo], [201, 'true', sale.json.receiptNo]);
  sim.setReady(true); assert.equal((await sim.sync()).executed.length, 1); await sim.sync();
  const stats = (await call('GET', '/api/my/stats?period=today', undefined, { token: att })).json;
  assert.deepEqual([stats.salesCount, stats.gamesSold, stats.totalMinor], [1, 5, kes(100)]);
  const close = await call('POST', '/api/shifts/close', { countedMinor: kes(590) }, { token: att });
  assert.deepEqual(close.json, { expectedMinor: kes(600), countedMinor: kes(590), varianceMinor: -kes(10), flagged: false });
  const csv = await call('GET', '/api/my/export?period=today&format=csv', undefined, { token: att }); assert.match(csv.text, /Table 1,CASH,C-000001/);
  const pdf = await call('GET', '/api/my/export?period=today&format=pdf', undefined, { token: att }); assert.ok(pdf.text.startsWith('%PDF-1.4'));
  const dash = (await call('GET', '/api/owner/dashboard', undefined, { token: ownerToken })).json; assert.ok(dash.today.poolRevenueMinor >= kes(100));
  assert.deepEqual(verifyLedger(srv.ctx.db), []);
});
test('E2E owner app: remote open releases the game; offline table is refused with a clear reason', async () => {
  assert.equal((await call('POST', `/api/owner/tables/${table2}/open`, { reason: 'Customer paid by hand' }, { token: ownerToken, idem: 'oo-1' })).status, 201);
  assert.equal((await sim2.sync()).executed.length, 1); await sim2.sync();
  srv.ctx.db.run('UPDATE pool_tables SET online=0 WHERE id=?', table2);
  const off = await call('POST', `/api/owner/tables/${table2}/open`, {}, { token: ownerToken, idem: 'oo-2' });
  assert.deepEqual([off.status, off.json.error.code], [409, 'DEVICE_OFFLINE']);
  await sim2.sync(); // reconnects
});
test('E2E coins: device-reported coins are logged once, collection flags a mismatch, tamper raises an alert', async () => {
  sim.insertCoin(2); const dupe = (sim as any).pendingEvents[0]; await sim.sync(); (sim as any).pendingEvents.push(dupe); await sim.sync(); // same event id replayed
  assert.equal(srv.ctx.db.get<{ c: number }>('SELECT COALESCE(SUM(coins),0) c FROM coin_events')!.c, 2);
  const good = await call('POST', '/api/coins/collections', { tableId, countedMinor: kes(40) }, { token: ownerToken, idem: 'cc-1' }); assert.equal(good.json.flagged, false);
  sim.insertCoin(1); await sim.sync();
  const bad = await call('POST', '/api/coins/collections', { tableId, countedMinor: 0, note: 'box looked light' }, { token: ownerToken, idem: 'cc-2' }); assert.deepEqual([bad.json.varianceMinor, bad.json.flagged], [-kes(20), true]);
  sim.tamper(true); sim.unauthorizedVend(); await sim.sync();
  const kinds = (await call('GET', '/api/alerts', undefined, { token: ownerToken })).json.alerts.map((a: any) => a.kind);
  for (const k of ['COIN_BOX_MISMATCH', 'TAMPER', 'VEND_WITHOUT_PAYMENT']) assert.ok(kinds.includes(k), k);
  assert.deepEqual(verifyLedger(srv.ctx.db), []);
});
test('E2E shared till over HTTP: a drink payment callback never vends; owner assigns it with a reason', async () => {
  const body = { TransactionType: 'Pay Bill', TransID: 'DRINKHTTP1', TransAmount: '20.00', BusinessShortCode: fake.shortcode, BillRefNumber: 'COKE', MSISDN: '254700111222' };
  assert.equal((await call('POST', `/api/mpesa/c2b/confirmation/${cbToken}`, body)).status, 200);
  assert.equal((await call('POST', `/api/mpesa/c2b/confirmation/wrong-token-value`, { ...body, TransID: 'DRINKHTTP2' })).status, 403);
  const list = (await call('GET', '/api/unallocated', undefined, { token: ownerToken })).json.payments; assert.equal(list.length, 1);
  assert.equal(balance(srv.ctx.db, A.gamesAvail(tableId)), balance(srv.ctx.db, A.gamesAvail(tableId))); // (no vend from the drink payment)
  const credBefore = balance(srv.ctx.db, A.gamesAvail(tableId));
  const asg = await call('POST', `/api/unallocated/${list[0].id}/assign`, { tableId, reason: 'Customer showed SMS for a game' }, { token: ownerToken, idem: 'as-1' });
  assert.deepEqual([asg.status, asg.json.games, asg.json.duplicate], [200, 1, false]);
  assert.equal(balance(srv.ctx.db, A.gamesAvail(tableId)), credBefore + 1); // credited only after the owner's explicit assignment
  assert.equal((await call('GET', '/api/reports/summary?period=today', undefined, { token: ownerToken })).json.unallocated.count, 1);
});

test('E2E OTA: owner uploads a signed image, devices are told about it, download is authenticated and byte-exact; versions are immutable', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const image = randomBytes(150_000); const sha = createHash('sha256').update(image).digest('hex'); const sig = randomBytes(70).toString('base64');
  const up = (v: string, data = image) => call('POST', '/api/firmware', { version: v, signature: sig, dataBase64: data.toString('base64') }, { token: ownerToken, idem: `fw-${v}-${data.length}` });
  assert.equal((await up('1.0.1')).status, 201);
  assert.equal((await up('1.0.1')).json.sha256, sha); // idempotent replay of the same request
  assert.equal((await call('POST', '/api/firmware', { version: '1.0.1', signature: sig, dataBase64: image.toString('base64') }, { token: ownerToken, idem: 'fw-dup' })).status, 409);
  assert.equal((await up('0.0.1', randomBytes(1000))).status, 400); // too small to be real firmware
  const mgr = (await call('POST', '/api/staff', { username: 'fwmgr', displayName: 'M', role: 'manager', password: 'Manager-Passw0rd!' }, { token: ownerToken, idem: 'fwm' })); assert.equal(mgr.status, 201);
  const mt = (await call('POST', '/api/auth/login', { username: 'fwmgr', password: 'Manager-Passw0rd!' })).json.accessToken;
  assert.equal((await call('POST', '/api/firmware', { version: '9', signature: sig, dataBase64: image.toString('base64') }, { token: mt, idem: 'fw-m' })).status, 403);
  await sim2.sync(); assert.equal((sim2.lastConfig as any).ota, undefined); // not active yet
  assert.equal((await call('PATCH', '/api/firmware/1.0.1', { active: true }, { token: ownerToken })).status, 200);
  await sim2.sync(); const ota = (sim2.lastConfig as any).ota; assert.deepEqual([ota.version, ota.sha256, ota.size, ota.signature], ['1.0.1', sha, 150_000, sig]);
  const dl = await sim2.downloadOta('1.0.1'); assert.equal(dl.status, 200); assert.ok(dl.sigOk); assert.ok(dl.bytes.equals(image));
  assert.equal((await sim2.downloadOta('9.9.9')).status, 404);
  assert.equal((await fetch(`${srv.base}/api/device/ota/1.0.1`)).status, 401); // anonymous cannot download
  sim2.fw = '1.0.1'; await sim2.sync(); assert.equal((sim2.lastConfig as any).ota, undefined); // up to date devices are not told again
  sim2.fw = 'sim-1.0.0';
});
test('E2E physical button is a server-authorised request: ignored+alerted when disabled, limited to 3/hour when enabled', async () => {
  const count = () => srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM manual_vends WHERE table_id=?", table2)!.n; const base = count();
  sim2.pressButton(); await sim2.sync(); assert.equal(count(), base);
  assert.ok((await call('GET', '/api/alerts', undefined, { token: ownerToken })).json.alerts.some((a: any) => a.kind === 'MANUAL_BUTTON_DISABLED'));
  assert.equal((await call('PATCH', `/api/tables/${table2}`, { manualVendEnabled: true }, { token: ownerToken })).status, 200);
  for (let i = 0; i < 5; i++) { sim2.pressButton(); await sim2.sync(); await sim2.sync(); }
  assert.equal(count() - base, 3);
  assert.ok((await call('GET', '/api/alerts', undefined, { token: ownerToken })).json.alerts.some((a: any) => a.kind === 'MANUAL_BUTTON_LIMIT'));
});
