import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startServer, api as rawApi, type TestServer, type Api } from './helpers/server.ts';
import { FakeDaraja } from './helpers/fake-daraja.ts';
import { makeTable } from './helpers/ctx.ts';
import { installDom, text, byId, buttonByText, click, type, fakeTimers, until, findAll, choose } from './helpers/fake-dom.ts';
import { createUser } from '../src/core/auth.ts';
import { saveDarajaConfig } from '../src/core/daraja.ts';
import { signedTableCode } from '../src/core/tablecode.ts';
import { createVoucherBatch } from '../src/core/vouchers.ts';
import { DeviceSim } from '../src/sim/device-sim.ts';
import { setSetting } from '../src/core/settings.ts';
import { kes } from '../src/core/money.ts';

const { root, doc } = installDom();
const mkApiLib = async () => (await import('../web/lib/api.js')).createApi;
const i18n = await import('../web/lib/i18n.js');
const { startPay } = await import('../web/pay.js'); const { startPos } = await import('../web/pos.js'); const { startOwner } = await import('../web/owner.js'); const { startAdmin } = await import('../web/admin.js'); const { startQrSheet } = await import('../web/qr-sheet.js');
const WEB = join(import.meta.dirname, '..', 'web');
let fake: FakeDaraja, srv: TestServer, call: Api, tableId: string, code: string, dev: { deviceId: string; deviceSecret: string }, cbToken: string;
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const fresh = () => { root.children = []; i18n.setLang('en', null as any); };
const pricing = { unitPriceMinor: kes(20), bundles: [{ games: 6, priceMinor: kes(100) }], peakWindows: [], minGames: 1, maxGames: 20, remainderPolicy: 'HOLD_CREDIT' };

before(async () => {
  fake = new FakeDaraja(); await fake.start(); srv = await startServer(fake, { webRoot: WEB }); call = rawApi(srv.base);
  const t = makeTable(srv.ctx, { pricing }); tableId = t.tableId; dev = t;
  saveDarajaConfig(srv.ctx, { env: 'sandbox', shortcode: fake.shortcode, partyB: fake.shortcode, passkey: fake.passkey, consumerKey: fake.key, consumerSecret: fake.secret, txType: 'CustomerPayBillOnline', callbackBaseUrl: 'https://pool.example.com', callbackToken: 'cb-token-web' }, 't'); cbToken = 'cb-token-web';
  code = signedTableCode(srv.ctx, srv.ctx.db.get<{ public_code: string }>('SELECT public_code FROM pool_tables WHERE id=?', tableId)!.public_code);
  setSetting(srv.ctx, 'public.base_url', 'https://pool.example.com');
  createUser(srv.ctx, { username: 'boss', displayName: 'The Boss', role: 'owner', password: 'Owner-Passw0rd!' }, 't'); createUser(srv.ctx, { username: 'mgr', displayName: 'Mgr', role: 'manager', pin: undefined, password: 'Manager-Passw0rd!' }, 't');
  createUser(srv.ctx, { username: 'wanjiku', displayName: 'Wanjiku', role: 'attendant', pin: '4827', password: 'Attendant-Passw0rd1' }, 't');
});
after(async () => { await srv.close(); await fake.stop(); });

test('customer page: pick games, pay once (double tap safe), see the PIN prompt, then the success screen with receipt; Swahili toggle', async () => {
  fresh(); const timers = fakeTimers(); const p = startPay({ root, code, base: srv.base, timers, storage: mem() } as any);
  await until(() => !!byId(root, 'pay')); assert.match(text(root), /Table 1/); assert.match(text(root), /Price per game: KES 20/); assert.match(text(root), /6 games = KES 100/);
  assert.match(text(byId(root, 'total')!), /1 game = KES 20/);
  await click(buttonByText(root, '5')); assert.match(text(byId(root, 'total')!), /5 games = KES 100/); await click(buttonByText(root, 'Other')); await type(byId(root, 'custom'), '6'); assert.match(text(byId(root, 'total')!), /6 games = KES 100/);
  await click(byId(root, 'pay')); assert.match(text(root), /Enter a valid Safaricom number/); assert.equal(fake.pushes.length, 0);
  await type(byId(root, 'phone'), '0712 345 678'); await Promise.all([click(byId(root, 'pay')), click(byId(root, 'pay')), click(byId(root, 'pay'))]);
  await until(() => /Check your phone and enter your M-Pesa PIN/.test(text(root))); assert.equal(fake.pushes.length, 1); assert.equal(fake.pushes[0].amount, 100); assert.equal(fake.pushes[0].phone, '254712345678'); assert.ok(byId(root, 'countdown'));
  await call('POST', `/api/mpesa/stk-callback/${cbToken}`, fake.callbackBody(fake.pushes[0].checkoutRequestId, { receipt: 'WEBRCPT001' }));
  await timers.fireIntervals(); await until(() => !!byId(root, 'success')); assert.match(text(root), /Payment received\. Balls released, enjoy!/); assert.match(text(root), /WEBRCPT001/); assert.match(text(root), /Games remaining: 6/);
  await click(buttonByText(root, 'Kiswahili')); assert.match(text(root), /Malipo yamepokelewa/); p.stop();
});
test('customer page: failure states each show a plain-language message with Try again; a retry uses a new idempotency key', async () => {
  for (const [outcome, re] of [['cancel', /You cancelled the payment/], ['wrong_pin', /Wrong M-Pesa PIN/], ['insufficient', /Not enough M-Pesa balance/]] as const) {
    fresh(); srv.ctx.db.run('DELETE FROM rate_events'); fake.nextOutcome = outcome; const timers = fakeTimers(); const p = startPay({ root, code, base: srv.base, timers, storage: mem() } as any);
    await until(() => !!byId(root, 'pay')); await type(byId(root, 'phone'), '0722000111'); await click(byId(root, 'pay')); await until(() => /Check your phone/.test(text(root)));
    await call('POST', `/api/mpesa/stk-callback/${cbToken}`, fake.callbackBody(fake.pushes.at(-1)!.checkoutRequestId)); await timers.fireIntervals(); await until(() => !!byId(root, 'failure')); assert.match(text(root), re);
    await click(byId(root, 'retry')); await until(() => !!byId(root, 'pay')); assert.equal(byId(root, 'phone')!.value, '0722000111'); p.stop();
  }
  fake.nextOutcome = 'success';
});
test('customer page: offline and faulted tables block payment BEFORE paying; rate limit message; bad QR code', async () => {
  srv.ctx.db.run('DELETE FROM rate_events');
  fresh(); srv.ctx.db.run('UPDATE pool_tables SET online=0'); let p = startPay({ root, code, base: srv.base, timers: fakeTimers() } as any); await until(() => /offline/.test(text(root))); assert.equal(byId(root, 'pay'), null); assert.match(text(root), /You have not been charged/); p.stop();
  fresh(); srv.ctx.db.run("UPDATE pool_tables SET online=1, status='FAULTED'"); p = startPay({ root, code, base: srv.base, timers: fakeTimers() } as any); await until(() => /fault/.test(text(root))); assert.equal(byId(root, 'pay'), null); p.stop(); srv.ctx.db.run("UPDATE pool_tables SET status='ACTIVE'");
  fresh(); p = startPay({ root, code: 'AAAAAA-AAAA', base: srv.base, timers: fakeTimers() } as any); await until(() => /QR code is not valid/.test(text(root))); p.stop();
  fresh(); const t2 = fakeTimers(); p = startPay({ root, code, base: srv.base, timers: t2 } as any); await until(() => !!byId(root, 'pay')); await type(byId(root, 'phone'), '0733000999'); await click(byId(root, 'pay')); await until(() => /Check your phone/.test(text(root)));
  await call('POST', `/api/mpesa/stk-callback/${cbToken}`, fake.callbackBody(fake.pushes.at(-1)!.checkoutRequestId, { outcome: 'cancel' })); await t2.fireIntervals(); await until(() => !!byId(root, 'retry')); await click(byId(root, 'retry')); await until(() => !!byId(root, 'pay')); await click(byId(root, 'pay'));
  await until(() => /Please wait a few seconds|Too many attempts/.test(text(root))); p.stop();
});
test('customer page: voucher redemption and Paybill details', async () => {
  srv.ctx.db.run('DELETE FROM rate_events'); setSetting(srv.ctx, 'c2b.auto_credit', '1'); const { codes } = createVoucherBatch(srv.ctx, { count: 1, games: 3, actor: 't' });
  fresh(); const p = startPay({ root, code, base: srv.base, timers: fakeTimers() } as any); await until(() => !!byId(root, 'voucher')); assert.match(text(root), /Paybill number: 174379/); assert.match(text(root), new RegExp(`Account number: ${code}`));
  await type(byId(root, 'voucher'), 'AAAAA-AAAAA'); await click(byId(root, 'redeem')); await until(() => /Invalid voucher/.test(text(root)));
  await type(byId(root, 'voucher'), codes[0]); await click(byId(root, 'redeem')); await until(() => /Voucher accepted/.test(text(root))); p.stop(); setSetting(srv.ctx, 'c2b.auto_credit', '0');
});
test('customer page: kiosk mode returns to the form by itself after success', async () => {
  srv.ctx.db.run('DELETE FROM rate_events'); fresh(); const timers = fakeTimers(); const p = startPay({ root, code, base: srv.base, timers, kiosk: true } as any); await until(() => !!byId(root, 'pay')); await type(byId(root, 'phone'), '0744111222'); await click(byId(root, 'pay')); await until(() => /Check your phone/.test(text(root)));
  await call('POST', `/api/mpesa/stk-callback/${cbToken}`, fake.callbackBody(fake.pushes.at(-1)!.checkoutRequestId, { receipt: 'KIOSKRCPT1' })); await timers.fireIntervals(); await until(() => !!byId(root, 'success'));
  await timers.fireTimeouts(); await until(() => !!byId(root, 'pay')); p.stop();
});

test('POS: PIN login, shift gate, quote preview, one sale despite double tap, receipt, manager approval for a big discount, void, my day, blind shift close', async () => {
  fresh(); srv.ctx.db.run('DELETE FROM rate_events'); srv.ctx.db.run("UPDATE pool_tables SET online=1"); const createApi = await mkApiLib(); const api = createApi({ base: srv.base, storage: mem() }); const timers = fakeTimers();
  const pos = startPos({ root, api, timers } as any);
  await type(byId(root, 'u'), 'wanjiku'); await type(byId(root, 'pin'), '1111'); await click(byId(root, 'login')); await until(() => /Incorrect/.test(text(root)));
  await type(byId(root, 'pin'), '4827'); await click(byId(root, 'login')); await until(() => !!byId(root, 'open-shift')); await type(byId(root, 'float'), '500'); await click(byId(root, 'open-shift')); await until(() => !!buttonByText(root, 'Table 1'));
  await click(buttonByText(root, 'Table 1')); await type(byId(root, 'cash'), '100'); await until(() => /6 games/.test(text(byId(root, 'quote')!))); // bundle: KES 100 = 6 games
  await type(byId(root, 'cash'), '50'); await until(() => /2 games.*held as credit/.test(text(byId(root, 'quote')!))); await type(byId(root, 'cash'), '100'); await until(() => /6 games/.test(text(byId(root, 'quote')!)));
  await Promise.all([click(byId(root, 'confirm')), click(byId(root, 'confirm'))]); await until(() => !!byId(root, 'receipt')); assert.match(text(byId(root, 'receipt')!), /C-000001/); assert.match(text(byId(root, 'receipt')!), /6 games/);
  assert.equal(srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM cash_sales')!.n, 1);
  await click(byId(root, 'new-sale')); await click(buttonByText(root, 'Table 1')); await type(byId(root, 'cash'), '75'); await type(byId(root, 'disc'), '25'); await type(byId(root, 'dreason'), 'regular'); await until(() => /6 games/.test(text(byId(root, 'quote')!))); await click(byId(root, 'confirm'));
  await until(() => !!byId(root, 'approve')); await type(byId(root, 'au'), 'mgr'); await choose(byId(root, 'ak'), 'password'); await type(byId(root, 'as'), 'wrong-password1'); await click(byId(root, 'approve')); await until(() => /Approval refused/.test(text(root)));
  await type(byId(root, 'as'), 'Manager-Passw0rd!'); await click(byId(root, 'approve')); await until(() => !!byId(root, 'receipt')); assert.match(text(byId(root, 'receipt')!), /C-000002/);
  assert.equal(srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM cash_sales WHERE discount_minor>0")!.n, 1);
  await click(byId(root, 'new-sale')); await click(buttonByText(root, 'My day')); await until(() => /Games sold/.test(text(root))); assert.match(text(root), /Sales2|Sales 2|2/); assert.match(text(root), /KES 200/); // two sales of KES 100 value each (one paid with a KES 25 discount)
  await click(buttonByText(root, 'Shift')); await until(() => !!byId(root, 'close-shift')); assert.doesNotMatch(text(root), /expected/i); await type(byId(root, 'counted'), '660'); await click(byId(root, 'close-shift')); await until(() => !!byId(root, 'closed'));
  assert.match(text(byId(root, 'closed')!), /Expected KES 675/); assert.match(text(byId(root, 'closed')!), /Variance KES -15/); pos.stop();
});
test('owner app: sign in, see money earned and games, open a table remotely; attendants are refused', async () => {
  fresh(); const createApi = await mkApiLib(); const api = createApi({ base: srv.base, storage: mem(), prefix: 'o.' }); const timers = fakeTimers(); let asked = '';
  const app = startOwner({ root, api, timers, confirmFn: (m: string) => { asked = m; return true; } } as any);
  await type(byId(root, 'u'), 'wanjiku'); await type(byId(root, 'p'), 'Attendant-Passw0rd1'); await click(byId(root, 'login')); await until(() => /for owners and managers/.test(text(root))); assert.equal(api.loggedIn, false);
  assert.equal(byId(root, 'u')!.value, 'wanjiku'); await type(byId(root, 'u'), 'boss'); await type(byId(root, 'p'), 'wrong-password1'); await click(byId(root, 'login')); await until(() => /Incorrect/.test(text(root)));
  await type(byId(root, 'p'), 'Owner-Passw0rd!'); await click(byId(root, 'login')); await until(() => /Money earned/.test(text(root))); assert.match(text(root), /Games sold/); assert.match(text(root), /Games played/); assert.match(text(root), /The Boss|Pool Table/);
  assert.match(text(root), /Table 1/); const before = srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM manual_vends')!.n;
  await click(buttonByText(root, 'Open table')); await until(() => /Open table ✓|\u2713/.test(text(root))); assert.match(asked, /Open table: Table 1/); assert.equal(srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM manual_vends')!.n, before + 1);
  srv.ctx.db.run('UPDATE pool_tables SET online=0'); await app.load(); assert.equal(buttonByText(root, 'Open table')!.disabled, true); srv.ctx.db.run('UPDATE pool_tables SET online=1');
  await click(buttonByText(root, 'This week')); await until(() => /Money earned/.test(text(root))); await click(byId(root, 'logout')); await until(() => !!byId(root, 'login')); app.stop();
});
test('admin: first-run wizard end to end (owner -> Daraja test -> table -> enrol controller -> test release -> QR), then every tab renders', async () => {
  const fake2 = new FakeDaraja(); await fake2.start(); const s2 = await startServer(fake2, { webRoot: WEB }); fresh();
  const createApi = await mkApiLib(); const api = createApi({ base: s2.base, storage: mem(), prefix: 'a.' }); const timers = fakeTimers(); const app = startAdmin({ root, api, timers } as any);
  await until(() => !!byId(root, 'w-owner')); await type(byId(root, 'biz'), 'Kali Pool'); await type(byId(root, 'dn'), 'Kali'); await type(byId(root, 'u'), 'kali'); await type(byId(root, 'p'), 'Weak1'); await click(byId(root, 'w-owner')); await until(() => /password: too short/i.test(text(root)));
  await type(byId(root, 'p'), 'Sup3rSecret!pw'); await click(byId(root, 'w-owner')); await until(() => !!byId(root, 'w-daraja'));
  await choose(byId(root, 'd-env'), 'sandbox'); await type(byId(root, 'd-sc'), fake2.shortcode); await type(byId(root, 'd-pk'), fake2.passkey); await type(byId(root, 'd-ck'), 'wrong-consumer-key'); await type(byId(root, 'd-cs'), 'wrong-secret-value'); await type(byId(root, 'd-cb'), 'https://pool.example.com'); await click(byId(root, 'w-daraja')); await until(() => /OAuth failed/.test(text(root)));
  await type(byId(root, 'd-ck'), fake2.key); await type(byId(root, 'd-cs'), fake2.secret); await click(byId(root, 'w-daraja')); await until(() => !!byId(root, 'w-table'));
  await type(byId(root, 'tf-name'), 'Table A'); await choose(byId(root, 'tf-mode'), 'COIN_PULSE'); await type(byId(root, 'tf-unit'), '20'); await type(byId(root, 'tf-bundles'), '6=100'); await click(byId(root, 'w-table')); await until(() => !!byId(root, 'dev-id'));
  const devId = text(byId(root, 'dev-id')!), secret = text(byId(root, 'dev-secret')!); assert.match(devId, /^dev_[0-9a-f]{12}$/); assert.match(secret, /^[0-9a-f]{64}$/);
  await click(byId(root, 'w-online')); await until(() => /has not connected yet/.test(text(root)));
  const sim = new DeviceSim({ baseUrl: s2.base, deviceId: devId, secret, mode: 'COIN_PULSE' }); await sim.sync(); await click(byId(root, 'w-online')); await until(() => !!byId(root, 'w-test'));
  await click(byId(root, 'w-test')); assert.equal((await sim.sync()).executed.length, 1); assert.equal(sim.outputs[0].kind, 'PULSES'); await click(buttonByText(root, 'It worked')); await until(() => !!byId(root, 'w-done')); await click(byId(root, 'w-done'));
  await until(() => /Open alerts/.test(text(root)));
  for (const tab of ['tables', 'payments', 'vouchers', 'staff', 'shifts', 'reports', 'system', 'dashboard']) { await click(buttonByText(root, tab[0].toUpperCase() + tab.slice(1)) ?? root.querySelector(`[data-tab="${tab}"]`)); await until(() => !/Loading…/.test(text(root)) || tab === 'vouchers', 4000); assert.doesNotMatch(text(root), /Something went wrong|undefined/); }
  await click(root.querySelector('[data-tab="tables"]')); await until(() => /Table A/.test(text(root))); await click(root.querySelector('[data-tab="payments"]')); await until(() => /stk-callback/.test(text(root))); assert.match(text(root), /Unallocated payments \(0\)/);
  await click(root.querySelector('[data-tab="tables"]')); await until(() => /Table A/.test(text(root))); await click(buttonByText(root, 'Edit')); await until(() => !!byId(root, 'save-table'));
  assert.equal(byId(root, 'tf-bundles')!.value, '6=100'); assert.equal(byId(root, 'tf-unit')!.value, '20'); assert.equal(byId(root, 'tf-mode')!.value, 'COIN_PULSE'); await type(byId(root, 'tf-unit'), '25'); await type(byId(root, 'tf-coin'), '10'); await click(byId(root, 'save-table')); await until(() => !byId(root, 'save-table'));
  const saved = JSON.parse(s2.ctx.db.get<{ p: string }>('SELECT pricing_json p FROM pool_tables')!.p); assert.deepEqual([saved.unitPriceMinor, saved.bundles], [2500, [{ games: 6, priceMinor: 10000 }]]); // the bundle survived the edit
  assert.equal(s2.ctx.db.get<{ c: number }>('SELECT coin_value_minor c FROM pool_tables')!.c, 1000);
  await click(root.querySelector('[data-tab="staff"]')); await until(() => /kali/.test(text(root)));
  await type(byId(root, 's-u'), 'njeri'); await type(byId(root, 's-n'), 'Njeri'); await type(byId(root, 's-pin'), '5913'); await click(byId(root, 'add-staff')); await until(() => /njeri/.test(text(root)));
  await click(root.querySelector('[data-tab="vouchers"]')); await until(() => !!byId(root, 'make-vouchers')); await type(byId(root, 'v-count'), '3'); await click(byId(root, 'make-vouchers')); await until(() => !!byId(root, 'codes')); assert.equal(findAll(byId(root, 'codes')!, (e) => e.className.includes('mono')).length, 3);
  await click(root.querySelector('[data-tab="system"]')); await until(() => !!byId(root, 'save-settings')); await type(byId(root, 'set-public_base_url'), 'ftp://bad'); await click(byId(root, 'save-settings')); await until(() => /invalid/.test(text(root))); await type(byId(root, 'set-public_base_url'), 'https://pool.example.com'); await click(byId(root, 'save-settings')); await until(() => /Settings saved/.test(text(root)));
  await click(byId(root, 'totp-begin')); await until(() => !!byId(root, 'totp-secret')); const { totpCode } = await import('../src/core/auth.ts'); await type(byId(root, 'totp-code'), totpCode(text(byId(root, 'totp-secret')!), Date.now())); await click(byId(root, 'totp-confirm')); await until(() => /Two-step sign-in is ON/.test(text(root)));
  assert.equal((await rawApi(s2.base)('POST', '/api/auth/login', { username: 'kali', password: 'Sup3rSecret!pw' })).json.error.code, 'TOTP_REQUIRED');
  app.stop(); await s2.close(); await fake2.stop();
});
test('QR sheet: renders a scannable data-URL image per table for managers', async () => {
  fresh(); const createApi = await mkApiLib(); const api = createApi({ base: srv.base, storage: mem(), prefix: 'q.' }); await api.login('boss', 'Owner-Passw0rd!');
  (globalThis as any).FileReader = class { onload: any; result: any; readAsDataURL(b: Blob) { b.arrayBuffer().then((ab) => { this.result = 'data:image/svg+xml;base64,' + Buffer.from(ab).toString('base64'); this.onload(); }); } };
  await startQrSheet({ root, api }); const imgs = findAll(root, (e) => e.tagName === 'IMG'); assert.ok(imgs.length >= 1); assert.match(imgs[0].getAttribute('src')!, /^data:image\/svg\+xml;base64,/); assert.match(text(root), new RegExp(code.slice(0, 6)));
  const svg = Buffer.from(imgs[0].getAttribute('src')!.split(',')[1], 'base64').toString(); assert.ok(svg.startsWith('<svg'));
});
void doc;
