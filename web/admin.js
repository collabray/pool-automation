// Admin dashboard: board, tables & pricing, Daraja, unallocated payments, vouchers, staff, shifts & coins, reports, system, audit. Includes the first-run wizard.
import { h, mount } from './lib/dom.js';
import { t, setLang, getLang, detectLang } from './lib/i18n.js';
import { kes, toMinor, fmtDateTime, ago } from './lib/format.js';
import { createApi, newKey, ApiError } from './lib/api.js';
import { saveBlob } from './lib/download.js';
import { buildPricing, formatBundles, formatPeak, FormError } from './lib/pricing-form.js';

const TABS = ['dashboard', 'tables', 'payments', 'vouchers', 'staff', 'shifts', 'reports', 'system'];
const SETTING_LABELS = { 'business.name': 'Business name', 'public.base_url': 'Public website address (https://...)', 'brand.color': 'Brand colour (#rrggbb)', 'c2b.auto_credit': 'Auto-credit from C2B/QR payments (1 = on, 0 = off; keep OFF on a shared till)',
  'stk.expiry_ms': 'Customer waiting time (ms)', 'stk.cooldown_ms': 'Minimum time between pushes per phone (ms)', 'limits.stk_per_phone_hour': 'Max pushes per phone per hour', 'limits.stk_per_ip_hour': 'Max pushes per IP per hour', 'limits.stk_per_table_hour': 'Max pushes per table per hour',
  'cash.variance_threshold_minor': 'Shift variance alert threshold (cents)', 'cash.offline_enabled': 'Allow offline cash queue (1/0)', 'cash.offline_max_minor': 'Offline sale cap (cents)', 'manual.max_per_shift': 'Manual vends per attendant shift',
  'device.offline_after_ms': 'Device offline after (ms)', 'device.credits_waiting_alert_ms': 'Alert when credits wait offline for (ms)', 'vend.max_per_hour': 'Unusual vend rate (per table per hour)', 'coins.variance_threshold_minor': 'Coin box variance tolerance (cents)',
  'notify.min_severity': 'Notify from severity (LOW/MEDIUM/HIGH)', 'callback.ip_allowlist': 'Safaricom callback IP allowlist (comma separated, empty = off)', 'retention.phone_days': 'Keep customer phone numbers for (days)' };

export function startAdmin({ root, api, timers = globalThis, qrBase = '' }) {
  const S = { view: 'login', tab: 'dashboard', error: null, info: null, busy: false, data: {}, wizard: null, needsSetup: false, secretBox: null, report: { period: 'today' } };
  const err = (e) => (e instanceof ApiError ? e.message : e instanceof FormError ? e.message : t('network_error'));
  const say = (m, bad = false) => { S.info = { m, bad }; render(); timers.setTimeout(() => { S.info = null; render(); }, 6000); };
  const run = async (fn) => { S.busy = true; render(); try { await fn(); S.error = null; } catch (e) { S.error = err(e); if (e instanceof ApiError && e.status === 401) S.view = 'login'; } S.busy = false; render(); };
  const field = (label, id, props = {}) => [h('label', { for: id }, label), props.tag === 'textarea' ? h('textarea', { id, rows: props.rows || 3, ...strip(props) }) : props.options ? h('select', { id, onchange: props.onchange }, props.options.map(([v, l]) => h('option', { value: v, selected: v === props.value }, l))) : h('input', { id, ...strip(props) })];
  const strip = ({ tag, rows, options, ...rest }) => rest;
  const tbl = (cols, rows) => h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))), h('tbody', null, rows)));
  const val = (id) => root.querySelector ? root.querySelector('#' + id)?.value ?? '' : '';

  async function load(what) {
    try {
      if (what === 'dashboard') { const [hl, tb, al] = await Promise.all([api.get('/api/system/health'), api.get('/api/tables'), api.get('/api/alerts')]); S.data.dashboard = { hl, tables: tb.tables, alerts: al.alerts }; }
      if (what === 'tables') S.data.tables = (await api.get('/api/tables')).tables;
      if (what === 'payments') { const [d, u, rp] = await Promise.all([api.get('/api/daraja'), api.get('/api/unallocated'), api.get('/api/payments?limit=30')]); S.data.payments = { daraja: d, unalloc: u.payments, recent: rp.payments }; S.data.tables ||= (await api.get('/api/tables')).tables; }
      if (what === 'staff') S.data.staff = (await api.get('/api/staff')).staff;
      if (what === 'shifts') { const [s, c] = await Promise.all([api.get('/api/shifts'), api.get('/api/coins/collections')]); S.data.shifts = { shifts: s.shifts, coins: c.collections }; S.data.tables ||= (await api.get('/api/tables')).tables; }
      if (what === 'reports') { const q = S.report.period === 'custom' ? `period=custom&from=${S.report.from}&to=${S.report.to}` : `period=${S.report.period}`; const [r, c] = await Promise.all([api.get(`/api/reports/summary?${q}`), api.get(`/api/staff/compare?${q}`)]); S.data.reports = { r, staff: c.staff }; }
      if (what === 'system') { const [s, a, e, f, n] = await Promise.all([api.get('/api/settings'), api.get('/api/audit'), api.get('/api/errors').catch(() => ({ errors: [] })), api.get('/api/firmware').catch(() => ({ releases: [] })), api.get('/api/notifications').catch(() => ({}))]); S.data.system = { settings: s.settings, audit: a.entries, errors: e.errors, firmware: f.releases, notify: n }; }
      S.error = null;
    } catch (e) { S.error = err(e); if (e instanceof ApiError && e.status === 401) S.view = 'login'; }
    render();
  }
  const go = (tab) => { S.tab = tab; S.error = null; S.secretBox = null; load(tab); render(); };

  // ---------------- auth + wizard ----------------
  async function boot() {
    try { const st = await api.get('/api/setup/status'); S.needsSetup = st.needsSetup; S.setup = st; } catch { /* offline */ }
    if (S.needsSetup) { S.view = 'wizard'; S.wizard = { step: 0 }; } else if (api.loggedIn) { S.view = 'app'; S.tab = 'dashboard'; load('dashboard'); } else S.view = 'login';
    render();
  }
  async function afterLogin() { const st = await api.get('/api/setup/status'); S.setup = st; if (api.user.role === 'owner' && (!st.darajaConfigured || !st.tables)) { S.view = 'wizard'; S.wizard = { step: st.darajaConfigured ? 2 : 1 }; } else { S.view = 'app'; S.tab = 'dashboard'; load('dashboard'); } }
  function loginView() {
    return h('main', null, h('h1', null, 'Admin'), h('div', { class: 'card' }, ...field(t('username'), 'u', { autocapitalize: 'none', autocomplete: 'username', value: S.loginUser || '', oninput: (e) => { S.loginUser = e.target.value; } }), ...field(t('password'), 'p', { type: 'password', autocomplete: 'current-password' }), S.needTotp ? field('Authenticator code', 'c', { inputmode: 'numeric', maxlength: '6' }) : null,
      S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      h('button', { id: 'login', class: 'block', disabled: S.busy, onclick: () => run(async () => { try { await api.login(val('u').trim().toLowerCase(), val('p'), 'password', S.needTotp ? val('c') : undefined); S.needTotp = false; await afterLogin(); } catch (e) { if (e instanceof ApiError && e.code === 'TOTP_REQUIRED') S.needTotp = true; throw e; } }) }, t('login'))));
  }
  function wizardView() {
    const w = S.wizard; const steps = ['Owner account', 'M-Pesa (Daraja)', 'First table', 'Connect the controller', 'Test release', 'Print QR code'];
    const nav = h('p', { class: 'muted' }, `Step ${w.step + 1} of ${steps.length}: ${steps[w.step]}`);
    const errBox = S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null;
    if (w.step === 0) return h('main', null, nav, h('div', { class: 'card' }, h('h2', null, 'Create the owner account'), ...field('Business name', 'biz'), ...field('Your name', 'dn'), ...field(t('username'), 'u', { autocapitalize: 'none' }), ...field('Password (10+ characters, letters and numbers)', 'p', { type: 'password' }), errBox,
      h('button', { id: 'w-owner', class: 'block', disabled: S.busy, onclick: () => run(async () => { await api.post('/api/setup/owner', { username: val('u').trim().toLowerCase(), displayName: val('dn'), password: val('p'), businessName: val('biz') }); await api.login(val('u').trim().toLowerCase(), val('p')); w.step = 1; }) }, 'Create account')));
    if (w.step === 1) return h('main', null, nav, h('div', { class: 'card' }, h('h2', null, 'Safaricom Daraja credentials'), h('p', { class: 'muted' }, 'Start with Sandbox. Switch to Production only after a successful sandbox test.'), darajaForm(S.data.daraja || {}), errBox,
      h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: () => { w.step = 2; render(); } }, 'Skip for now (cash only)'), h('button', { id: 'w-daraja', disabled: S.busy, onclick: () => run(async () => { await saveDaraja(); const r = await api.post('/api/daraja/test'); S.testMsg = r; if (!r.ok) throw new ApiError(0, 'TEST', r.message); w.step = 2; }) }, 'Save and test connection')), S.testMsg ? h('div', { class: `msg ${S.testMsg.ok ? 'ok' : 'bad'}` }, S.testMsg.message) : null));
    if (w.step === 2) return h('main', null, nav, h('div', { class: 'card' }, h('h2', null, 'Your first table'), tableForm(null), errBox, h('button', { id: 'w-table', class: 'block', disabled: S.busy, onclick: () => run(async () => { const r = await api.post('/api/tables', collectTable(), { idem: newKey() }); w.created = r; w.step = 3; }) }, 'Create table')));
    if (w.step === 3) { const c = w.created; return h('main', null, nav, h('div', { class: 'card' }, h('h2', null, 'Connect the controller'), h('p', null, 'Flash the firmware, join the controller\u2019s WiFi setup page and enter exactly these values. The secret is shown only once.'),
      h('p', null, 'Device ID: ', h('strong', { class: 'mono', id: 'dev-id' }, c.deviceId)), h('p', null, 'Device secret: ', h('strong', { class: 'mono', id: 'dev-secret' }, c.deviceSecret)), h('p', { class: 'muted' }, 'See docs/TABLE-INSTALLATION.md for wiring and the bench test.'),
      h('button', { class: 'block', id: 'w-online', onclick: () => run(async () => { const tb = (await api.get('/api/tables')).tables.find((x) => x.id === c.tableId); if (tb.state !== 'ONLINE') throw new ApiError(0, 'OFFLINE', 'The controller has not connected yet. Check WiFi and try again in a moment.'); w.step = 4; }) }, 'Check connection'), errBox)); }
    if (w.step === 4) return h('main', null, nav, h('div', { class: 'card' }, h('h2', null, 'Test release'), h('p', null, 'Press the button: the table should release one game. Do this with the controller on the bench first.'), errBox,
      h('div', { class: 'row' }, h('button', { id: 'w-test', onclick: () => run(async () => { await api.post(`/api/tables/${w.created.tableId}/test-vend`, {}, { idem: newKey() }); say('Release command sent'); }) }, 'Release one game'), h('button', { class: 'secondary', onclick: () => { w.step = 5; render(); } }, 'It worked \u2192 next'))));
    return h('main', null, nav, h('div', { class: 'card' }, h('h2', null, 'Print the QR code'), h('p', null, 'First set your public website address in System \u2192 Settings, then open the printable sheet.'), h('a', { class: 'btn', href: '/qr-sheet.html', target: '_blank', rel: 'noopener' }, 'Open QR sheet'),
      h('button', { class: 'secondary block', id: 'w-done', onclick: () => { S.view = 'app'; go('dashboard'); } }, 'Finish setup')));
  }

  // ---------------- forms ----------------
  function darajaForm(d) {
    return h('div', null, ...field('Environment', 'd-env', { options: [['sandbox', 'Sandbox (testing)'], ['production', 'Production (live money)']], value: d.env }), ...field('Transaction type', 'd-tx', { options: [['CustomerPayBillOnline', 'Paybill'], ['CustomerBuyGoodsOnline', 'Till (Buy Goods)']], value: d.txType }),
      ...field('Shortcode (Paybill, or store/head-office number for a Till)', 'd-sc', { value: d.shortcode || '', inputmode: 'numeric' }), ...field('Receiving number (Till number; blank for Paybill)', 'd-pb', { value: d.partyB && d.partyB !== d.shortcode ? d.partyB : '', inputmode: 'numeric' }),
      ...field('Passkey', 'd-pk', { type: 'password', placeholder: d.configured ? 'unchanged \u2014 re-enter to change' : '' }), ...field('Consumer key', 'd-ck', { type: 'password' }), ...field('Consumer secret', 'd-cs', { type: 'password' }), ...field('Public HTTPS address of this server', 'd-cb', { value: d.callbackBaseUrl || '', placeholder: 'https://pool.example.com' }));
  }
  const saveDaraja = () => api.put('/api/daraja', { env: val('d-env'), txType: val('d-tx'), shortcode: val('d-sc').trim(), ...(val('d-pb').trim() ? { partyB: val('d-pb').trim() } : {}), passkey: val('d-pk'), consumerKey: val('d-ck'), consumerSecret: val('d-cs'), callbackBaseUrl: val('d-cb').trim().replace(/\/$/, '') });
  function tableForm(tb) {
    const p = tb?.pricing; const c = tb || {};
    return h('div', null, ...field('Table name', 'tf-name', { value: c.name || '' }), ...field('Vend mode', 'tf-mode', { options: [['COIN_PULSE', 'Coin pulse (electronic coin acceptor)'], ['SOLENOID_SLIDE', 'Solenoid pushes the coin slide'], ['GATE_SOLENOID', 'Solenoid opens the ball gate']], value: c.vendMode }),
      ...field('Pulses per game (coin pulse)', 'tf-pulses', { type: 'number', value: String(c.vendParams?.pulses ?? 1) }), ...field('Pulse width ms (coin pulse)', 'tf-pw', { type: 'number', value: String(c.vendParams?.pulseMs ?? 50) }), ...field('Gap between pulses ms', 'tf-gap', { type: 'number', value: String(c.vendParams?.gapMs ?? 50) }), ...field('Solenoid hold ms (slide/gate)', 'tf-hold', { type: 'number', value: String(c.vendParams?.holdMs ?? 1500) }),
      ...field('Release mode', 'tf-rel', { options: [['ONE', 'One game at a time'], ['ALL', 'All paid games at once']], value: c.releaseMode || 'ONE' }),
      h('label', null, h('input', { type: 'checkbox', id: 'tf-ready', checked: !!c.requiresReadySensor, style: undefined }), ' Release the next game only when the "balls captured / ready" sensor reports ready'),
      h('label', null, h('input', { type: 'checkbox', id: 'tf-confirm', checked: !!c.confirmBySensor }), ' A vend-confirmation sensor confirms each release (otherwise the controller\'s acknowledgement is enough)'),
      h('p', { class: 'muted' }, 'Gate/slide tables without a ready sensor should use "all at once" or coin-pulse mode.'),
      ...field('Wait for the controller before retrying (ms)', 'tf-timeout', { type: 'number', value: String(c.vendTimeoutMs ?? 15000) }), ...field('Retries before a release is marked failed', 'tf-attempts', { type: 'number', value: String(c.maxVendAttempts ?? 3) }),
      ...field('Value of one physical coin (KES, for coin box reconciliation)', 'tf-coin', { type: 'number', value: String((c.coinValueMinor ?? 2000) / 100) }),
      h('label', null, h('input', { type: 'checkbox', id: 'tf-manual', checked: !!c.manualVendEnabled }), ' Allow the physical test button and attendants\' manual release on this table'),
      h('h3', null, 'Pricing (KES)'), ...field('Price per game', 'tf-unit', { type: 'number', min: '1', value: String(p ? p.unitPriceMinor / 100 : 20) }), ...field('Minimum games per payment', 'tf-min', { type: 'number', value: String(p?.minGames ?? 1) }), ...field('Maximum games per payment', 'tf-max', { type: 'number', value: String(p?.maxGames ?? 20) }),
      ...field('Bundles (one per line: games=price, e.g. 6=100)', 'tf-bundles', { tag: 'textarea', value: formatBundles(p?.bundles) }), ...field('Peak prices (one per line: fri,sat; 18:00-02:00; 30)', 'tf-peak', { tag: 'textarea', value: formatPeak(p?.peakWindows) }),
      ...field('If a manual payment is not an exact multiple', 'tf-rem', { options: [['HOLD_CREDIT', 'Hold the remainder as credit'], ['REFUND', 'Refund the remainder'], ['REJECT', 'Reject the payment']], value: p?.remainderPolicy }));
  }
  const checked = (id) => (root.querySelector ? !!root.querySelector('#' + id)?.checked : false);
  function collectTable() {
    const mode = val('tf-mode'); const params = mode === 'COIN_PULSE' ? { pulses: +val('tf-pulses'), pulseMs: +val('tf-pw'), gapMs: +val('tf-gap') } : { holdMs: +val('tf-hold') };
    return { name: val('tf-name').trim(), vendMode: mode, vendParams: params, releaseMode: val('tf-rel'), requiresReadySensor: checked('tf-ready'), confirmBySensor: checked('tf-confirm'), vendTimeoutMs: +val('tf-timeout') || 15000, maxVendAttempts: +val('tf-attempts') || 3, coinValueMinor: toMinor(val('tf-coin') || 20), manualVendEnabled: checked('tf-manual'), pricing: buildPricing({ unit: val('tf-unit'), min: val('tf-min'), max: val('tf-max'), bundles: val('tf-bundles'), peak: val('tf-peak'), remainder: val('tf-rem') }) };
  }

  // ---------------- tabs ----------------
  function dashboardView() {
    const d = S.data.dashboard; if (!d) return h('p', { class: 'muted center' }, t('loading'));
    const hl = d.hl;
    return h('div', null, h('div', { class: 'grid' }, [['Open alerts', hl.openAlerts], ['Offline tables', hl.offlineTables], ['Pending M-Pesa', hl.pendingStk], ['Unallocated payments', hl.unallocatedPending], ['Ledger balanced', hl.ledgerBalanced ? 'Yes' : 'NO \u2014 investigate'], ['M-Pesa configured', hl.darajaConfigured ? 'Yes' : 'No']].map(([l, v]) => h('div', { class: 'card' }, h('div', { class: 'stat' }, h('small', null, l), String(v))))),
      h('h2', null, t('tables')), h('div', { class: 'grid' }, d.tables.map((tb) => h('div', { class: 'card' }, h('div', { class: 'row nogrow' }, h('strong', null, tb.name), h('span', { class: `pill ${tb.state === 'ONLINE' ? 'on' : tb.state === 'OFFLINE' ? 'off' : 'bad'}` }, tb.state), tb.tamper ? h('span', { class: 'pill bad' }, 'TAMPER') : null),
        h('p', { class: 'muted' }, `${t('credits_pending')}: ${tb.creditsPending} \u00b7 in flight ${tb.inFlight} \u00b7 today ${tb.gamesToday}`), h('p', { class: 'muted' }, `Last release ${ago(tb.lastVendAt)} \u00b7 seen ${ago(tb.lastSeenAt)} \u00b7 fw ${tb.fw || '\u2014'} \u00b7 RSSI ${tb.rssi ?? '\u2014'}`)))),
      h('h2', null, `Alerts (${d.alerts.length})`), d.alerts.map((a) => h('div', { class: `msg ${a.severity === 'HIGH' ? 'bad' : 'warn'}` }, h('strong', null, a.kind), ` \u2014 ${a.message} (${fmtDateTime(a.created_at)}) `, h('button', { class: 'small secondary', onclick: () => run(async () => { await api.post(`/api/alerts/${a.id}/resolve`); await load('dashboard'); }) }, 'Resolve'))));
  }
  function tablesView() {
    const list = S.data.tables || [];
    if (S.editing !== undefined) { const tb = S.editing; return h('div', { class: 'card' }, h('h2', null, tb ? `Edit ${tb.name}` : 'New table'), tableForm(tb), S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: () => { S.editing = undefined; render(); } }, t('cancel')), h('button', { id: 'save-table', onclick: () => run(async () => { const b = collectTable(); if (tb) await api.patch(`/api/tables/${tb.id}`, b); else S.secretBox = await api.post('/api/tables', b, { idem: newKey() }); S.editing = undefined; await load('tables'); }) }, t('save')))); }
    return h('div', null, h('div', { class: 'row nogrow' }, h('button', { id: 'new-table', onclick: () => { S.editing = null; render(); } }, 'Add table'), h('a', { class: 'btn secondary', href: '/qr-sheet.html', target: '_blank', rel: 'noopener' }, 'Printable QR sheet')),
      S.secretBox ? h('div', { class: 'msg warn' }, h('strong', null, 'Save these controller credentials now \u2014 the secret is shown once.'), h('p', { class: 'mono' }, `Device ID: ${S.secretBox.deviceId}`), h('p', { class: 'mono' }, `Secret: ${S.secretBox.deviceSecret}`)) : null,
      h('div', { class: 'grid' }, list.map((tb) => h('div', { class: 'card' }, h('strong', null, tb.name), h('p', { class: 'muted' }, `${tb.state} \u00b7 ${kes(tb.unitPriceMinor)}/game \u00b7 ${tb.vendMode} \u00b7 ${tb.releaseMode}`),
        h('div', { class: 'row nogrow' }, h('button', { class: 'small secondary', onclick: () => run(async () => { S.editing = await fullTable(tb); }) }, 'Edit'),
          h('button', { class: 'small secondary', onclick: () => run(async () => { await api.post(`/api/tables/${tb.id}/test-vend`, {}, { idem: newKey() }); say('Release command sent'); }) }, 'Test release'),
          h('button', { class: 'small secondary', onclick: () => run(async () => { if (typeof confirm === 'function' && !confirm('Issue a new device secret? The old one stops working immediately.')) return; S.secretBox = await api.post(`/api/tables/${tb.id}/rotate-device-secret`, {}, { idem: newKey() }); }) }, 'New device secret'),
          h('button', { class: 'small secondary', onclick: () => run(async () => { await api.patch(`/api/tables/${tb.id}`, { status: tb.state === 'DISABLED' ? 'ACTIVE' : 'DISABLED' }); await load('tables'); }) }, tb.state === 'DISABLED' ? 'Enable' : 'Disable'))))));
  }
  const fullTable = (tb) => api.get(`/api/tables/${tb.id}`);
  function paymentsView() {
    const d = S.data.payments; if (!d) return h('p', { class: 'muted center' }, t('loading'));
    const tables = S.data.tables || [];
    return h('div', null, h('div', { class: 'card' }, h('h2', null, 'M-Pesa (Daraja)'), darajaForm(d.daraja), S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      h('div', { class: 'row' }, h('button', { id: 'save-daraja', disabled: S.busy, onclick: () => run(async () => { await saveDaraja(); say('Saved'); await load('payments'); }) }, t('save')), h('button', { class: 'secondary', id: 'test-daraja', onclick: () => run(async () => { const r = await api.post('/api/daraja/test'); say(r.message, !r.ok); }) }, 'Test connection')),
      d.daraja.configured ? h('div', { class: 'muted' }, h('p', null, 'Register these URLs in the Daraja portal:'), h('p', { class: 'mono' }, `STK callback: ${d.daraja.stkCallbackUrl}`), h('p', { class: 'mono' }, `C2B confirmation: ${d.daraja.c2bConfirmationUrl}`), h('p', { class: 'mono' }, `C2B validation: ${d.daraja.c2bValidationUrl}`)) : null),
      h('div', { class: 'card' }, h('h2', null, `Unallocated payments (${d.unalloc.length})`), h('p', { class: 'muted' }, 'Money that arrived on your Till/Paybill but matched no game request (for example a drink). These never release games unless you assign them.'),
        d.unalloc.length ? tbl(['Received', 'Receipt', 'Amount', 'Why', 'Assign to table'], d.unalloc.map((u) => { let tid = tables[0]?.id, reason = ''; return h('tr', null, h('td', null, fmtDateTime(u.received_at)), h('td', { class: 'mono' }, u.receipt), h('td', null, kes(u.amount_minor)), h('td', null, u.reason),
          h('td', null, h('select', { 'aria-label': 'table', onchange: (e) => { tid = e.target.value; } }, tables.map((x) => h('option', { value: x.id }, x.name))), h('input', { placeholder: 'Reason (required)', 'aria-label': 'reason', oninput: (e) => { reason = e.target.value; } }), h('button', { class: 'small', onclick: () => run(async () => { await api.post(`/api/unallocated/${u.id}/assign`, { tableId: tid, reason }, { idem: newKey() }); await load('payments'); say('Assigned and audit-logged'); }) }, 'Assign'))); })) : h('p', { class: 'muted' }, '\u2713 Nothing waiting')),
      h('div', { class: 'card' }, h('h2', null, 'Recent payments'), tbl(['Time', 'Method', 'Reference', 'Table', 'Paid', 'Games', ''], (d.recent || []).map((p) => h('tr', null, h('td', null, fmtDateTime(p.created_at)), h('td', null, p.source), h('td', { class: 'mono' }, p.external_ref), h('td', null, p.table_name), h('td', null, kes(p.amount_minor)), h('td', null, String(p.games_credited)),
        h('td', null, p.reversed ? h('span', { class: 'pill bad' }, 'reversed') : p.source.startsWith('MPESA') && api.user?.role === 'owner' ? h('button', { class: 'small secondary', onclick: () => { const reason = (typeof prompt === 'function' ? prompt('Reason for reversing this payment?') : '') || ''; if (reason.length >= 3) run(async () => { const r = await api.post(`/api/payments/${p.id}/reverse`, { reason }, { idem: newKey() }); say(`Reversed: ${r.removedGames} game(s) removed${r.lossMinor ? `, loss ${kes(r.lossMinor)}` : ''}`); await load('payments'); }); } }, 'Reverse') : null))))));
  }
  function vouchersView() {
    const tables = S.data.tables || [];
    return h('div', { class: 'card' }, h('h2', null, 'Create vouchers'), ...field('How many', 'v-count', { type: 'number', value: '10', min: '1', max: '1000' }), ...field('Games each', 'v-games', { type: 'number', value: '1', min: '1', max: '100' }), ...field('Only valid on', 'v-table', { options: [['', 'Any table'], ...tables.map((x) => [x.id, x.name])] }),
      S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null, h('button', { id: 'make-vouchers', disabled: S.busy, onclick: () => run(async () => { S.vouchers = await api.post('/api/vouchers/batch', { count: +val('v-count'), games: +val('v-games'), ...(val('v-table') ? { tableId: val('v-table') } : {}) }, { idem: newKey() }); }) }, 'Create'),
      S.vouchers ? h('div', null, h('p', { class: 'msg warn' }, 'Codes are shown once. Print or copy them now.'), h('div', { class: 'grid', id: 'codes' }, S.vouchers.codes.map((c) => h('div', { class: 'card mono center' }, c))), h('button', { class: 'secondary noprint', onclick: () => window.print() }, 'Print'), h('button', { class: 'danger noprint', onclick: () => run(async () => { await api.post(`/api/vouchers/batch/${S.vouchers.batchId}/void`); S.vouchers = null; say('Batch voided'); }) }, 'Void this batch')) : null);
  }
  function staffView() {
    const rows = S.data.staff; if (!rows) return h('p', { class: 'muted center' }, t('loading'));
    return h('div', null, h('div', { class: 'card' }, h('h2', null, 'Add staff'), ...field(t('username'), 's-u', { autocapitalize: 'none' }), ...field('Name', 's-n'), ...field('Role', 's-r', { options: [['attendant', 'Attendant'], ['manager', 'Manager']] }), ...field('PIN (attendant, 4-8 digits)', 's-pin', { inputmode: 'numeric' }), ...field('Password (managers, 10+ chars)', 's-pw', { type: 'password' }),
      h('label', null, h('input', { type: 'checkbox', id: 's-money', checked: true }), ' Can see money figures'), S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      h('button', { id: 'add-staff', onclick: () => run(async () => { await api.post('/api/staff', { username: val('s-u').trim().toLowerCase(), displayName: val('s-n'), role: val('s-r'), ...(val('s-pin') ? { pin: val('s-pin') } : {}), ...(val('s-pw') ? { password: val('s-pw') } : {}), canSeeMoney: checked('s-money') }, { idem: newKey() }); await load('staff'); say('Added'); }) }, 'Add')),
      tbl(['User', 'Role', 'Active', 'Money visible', 'Void limit', 'Discount limit', ''], rows.map((u) => h('tr', null, h('td', null, `${u.display_name} (${u.username})`), h('td', null, u.role), h('td', null, u.active ? 'yes' : 'NO'), h('td', null, u.can_see_money ? 'yes' : 'no'), h('td', null, kes(u.void_limit_minor)), h('td', null, kes(u.discount_limit_minor)),
        h('td', null, h('button', { class: 'small secondary', onclick: () => run(async () => { await api.patch(`/api/staff/${u.id}`, { active: !u.active }); await load('staff'); }) }, u.active ? 'Deactivate' : 'Activate'), h('button', { class: 'small secondary', onclick: () => run(async () => { await api.patch(`/api/staff/${u.id}`, { canSeeMoney: !u.can_see_money }); await load('staff'); }) }, u.can_see_money ? 'Hide money' : 'Show money'),
          h('button', { class: 'small secondary', onclick: () => { const v = typeof prompt === 'function' ? prompt('Void limit in KES') : null; if (v) run(async () => { await api.patch(`/api/staff/${u.id}`, { voidLimitMinor: toMinor(v) }); await load('staff'); }); } }, 'Limits'))))));
  }
  function shiftsView() {
    const d = S.data.shifts; if (!d) return h('p', { class: 'muted center' }, t('loading')); const tables = S.data.tables || [];
    return h('div', null, h('h2', null, t('shifts')), tbl(['Attendant', 'Opened', 'Closed', 'Float', 'Expected', 'Counted', 'Variance'], d.shifts.map((s) => h('tr', null, h('td', null, s.attendant), h('td', null, fmtDateTime(s.opened_at)), h('td', null, s.closed_at ? fmtDateTime(s.closed_at) : h('span', { class: 'pill on' }, 'OPEN')), h('td', null, kes(s.float_minor)), h('td', null, s.expected_minor === null ? '\u2014' : kes(s.expected_minor)), h('td', null, s.counted_minor === null ? '\u2014' : kes(s.counted_minor)), h('td', null, s.variance_minor === null ? '\u2014' : [kes(s.variance_minor), ' ', s.variance_flagged ? h('span', { class: 'pill bad' }, 'flagged') : null])))),
      h('div', { class: 'card' }, h('h2', null, 'Coin box collection'), ...field('Table', 'cb-t', { options: tables.map((x) => [x.id, x.name]) }), ...field('Cash counted from the coin box (KES)', 'cb-c', { type: 'number', min: '0' }), ...field('Note', 'cb-n'), S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
        h('button', { id: 'collect', onclick: () => run(async () => { const r = await api.post('/api/coins/collections', { tableId: val('cb-t'), countedMinor: toMinor(val('cb-c')), ...(val('cb-n') ? { note: val('cb-n') } : {}) }, { idem: newKey() }); say(`Expected ${kes(r.expectedMinor)}, counted ${kes(r.countedMinor)}, variance ${kes(r.varianceMinor)}${r.flagged ? ' \u2014 FLAGGED' : ''}`, r.flagged); await load('shifts'); }) }, 'Record collection')),
      tbl(['When', 'Table', 'Expected', 'Counted', 'Variance'], d.coins.map((c) => h('tr', null, h('td', null, fmtDateTime(c.collected_at)), h('td', null, c.table_name), h('td', null, kes(c.expected_minor)), h('td', null, kes(c.counted_minor)), h('td', null, [kes(c.variance_minor), ' ', c.flagged ? h('span', { class: 'pill bad' }, 'flagged') : null])))));
  }
  function reportsView() {
    const d = S.data.reports; const r = d?.r;
    return h('div', null, h('div', { class: 'row nogrow noprint' }, ['today', 'yesterday', 'week', 'month'].map((p) => h('button', { class: S.report.period === p ? 'small' : 'small secondary', onclick: () => { S.report.period = p; load('reports'); } }, t(p))),
      h('button', { class: 'small secondary', onclick: () => saveReport('csv') }, 'CSV'), h('button', { class: 'small secondary', onclick: () => saveReport('pdf') }, 'PDF')),
      !r ? h('p', { class: 'muted center' }, t('loading')) : h('div', null, h('div', { class: 'grid' }, [[t('revenue'), kes(r.poolRevenueMinor)], [t('games_sold'), r.gamesSold], [t('games_played'), r.gamesPlayed], ['Vend failures', r.vendFailures], ['Refunds', kes(r.refundsMinor)], ['Other-business receipts (not pool revenue)', `${kes(r.unallocated.totalMinor)} (${r.unallocated.pendingCount} to assign)`]].map(([l, v]) => h('div', { class: 'card' }, h('div', { class: 'stat' }, h('small', null, l), String(v))))),
        h('div', { class: 'card' }, h('h2', null, 'Money vs coins vs vouchers'), tbl(['Method', 'Sales', 'Games', 'Amount'], Object.entries(r.byMethod).map(([m, v]) => h('tr', null, h('td', null, m), h('td', null, String(v.sales)), h('td', null, String(v.games)), h('td', null, kes(v.totalMinor)))))),
        h('div', { class: 'card' }, h('h2', null, 'Per table'), tbl(['Table', 'Revenue', 'Sold', 'Played'], r.byTable.map((x) => h('tr', null, h('td', null, x.name), h('td', null, kes(x.revenueMinor)), h('td', null, String(x.gamesSold)), h('td', null, String(x.gamesPlayed)))))),
        h('div', { class: 'card' }, h('h2', null, 'Per day'), tbl(['Day', 'Revenue', 'Games'], r.byDay.map((x) => h('tr', null, h('td', null, x.day), h('td', null, kes(x.revenueMinor)), h('td', null, String(x.games)))))),
        h('div', { class: 'card' }, h('h2', null, 'Per hour'), tbl(['Hour', 'Revenue', 'Games'], r.byHour.map((x) => h('tr', null, h('td', null, `${String(x.hour).padStart(2, '0')}:00`), h('td', null, kes(x.revenueMinor)), h('td', null, String(x.games)))))),
        h('div', { class: 'card' }, h('h2', null, 'Attendants'), tbl(['Name', 'Sales', 'Games', 'Money', 'Average', 'Voids', 'Refunds'], d.staff.map((s) => h('tr', null, h('td', null, s.name), h('td', null, String(s.salesCount)), h('td', null, String(s.gamesSold)), h('td', null, kes(s.totalMinor)), h('td', null, kes(s.averageSaleMinor)), h('td', null, String(s.voids)), h('td', null, String(s.refunds))))))));
  }
  async function saveReport(kind) { try { saveBlob(await api.blob(`/api/reports/export?period=${S.report.period}&format=${kind}`), `report.${kind}`); } catch (e) { S.error = err(e); render(); } }
  function systemView() {
    const d = S.data.system; if (!d) return h('p', { class: 'muted center' }, t('loading'));
    return h('div', null, h('div', { class: 'card' }, h('h2', null, 'Settings'), Object.entries(SETTING_LABELS).map(([k, label]) => field(label, 'set-' + k.replace(/\./g, '_'), { value: d.settings[k] ?? '' })), S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      h('button', { id: 'save-settings', onclick: () => run(async () => { const settings = {}; for (const k of Object.keys(SETTING_LABELS)) settings[k] = val('set-' + k.replace(/\./g, '_')); await api.put('/api/settings', { settings }); say('Settings saved'); }) }, t('save'))),
      h('div', { class: 'card' }, h('h2', null, 'Alerts delivery'), h('p', { class: 'muted' }, `Configured: ${['sms', 'telegram', 'webhook', 'email'].filter((k) => d.notify[k]).join(', ') || 'none'}`),
        ...field('Telegram bot token', 'n-tg-t', { type: 'password' }), ...field('Telegram chat id', 'n-tg-c'), ...field("Africa's Talking username", 'n-sms-u'), ...field("Africa's Talking API key", 'n-sms-k', { type: 'password' }), ...field('SMS recipients (comma separated, +254...)', 'n-sms-to'), ...field('Webhook URL (https)', 'n-wh'),
        h('div', { class: 'row' }, h('button', { onclick: () => run(async () => { const b = {}; if (val('n-tg-t')) b.telegram = { botToken: val('n-tg-t'), chatId: val('n-tg-c') }; if (val('n-sms-k')) b.sms = { username: val('n-sms-u'), apiKey: val('n-sms-k'), to: val('n-sms-to').split(',').map((x) => x.trim()).filter(Boolean) }; if (val('n-wh')) b.webhook = { url: val('n-wh') }; await api.put('/api/notifications', b); say('Saved'); await load('system'); }) }, t('save')), h('button', { class: 'secondary', onclick: () => run(async () => { const r = await api.post('/api/notifications/test'); say(`Sent: ${r.delivered}${r.errors.length ? ' \u2014 errors: ' + r.errors.join('; ') : ''}`, r.errors.length > 0); }) }, 'Send test alert'))),
      h('div', { class: 'card' }, h('h2', null, 'Firmware updates'), tbl(['Version', 'Size', 'Active', ''], d.firmware.map((f) => h('tr', null, h('td', null, f.version), h('td', null, String(f.size)), h('td', null, f.active ? 'yes' : 'no'), h('td', null, h('button', { class: 'small secondary', onclick: () => run(async () => { await api.patch(`/api/firmware/${f.version}`, { active: !f.active }); await load('system'); }) }, f.active ? 'Stop rollout' : 'Roll out'))))), h('p', { class: 'muted' }, 'Upload signed images with tools/sign-firmware.sh + tools/upload-firmware.sh (see docs/OPERATIONS.md).')),
      h('div', { class: 'card' }, h('h2', null, 'Two-step sign-in (recommended for the owner and managers)'),
        S.totp ? h('div', null, h('p', null, 'Add this key to an authenticator app (Google Authenticator, Authy, FreeOTP):'), h('p', { class: 'mono', id: 'totp-secret' }, S.totp.secret), h('p', { class: 'muted mono' }, S.totp.uri), ...field('6-digit code from the app', 'totp-code', { inputmode: 'numeric', maxlength: '6' }),
          h('button', { id: 'totp-confirm', onclick: () => run(async () => { await api.post('/api/me/totp/confirm', { code: val('totp-code') }); S.totp = null; say('Two-step sign-in is ON. You will be asked for a code at every sign-in.'); }) }, 'Turn on'))
          : h('button', { id: 'totp-begin', class: 'secondary', onclick: () => run(async () => { S.totp = await api.post('/api/me/totp/begin'); }) }, 'Set up two-step sign-in')),
      h('div', { class: 'card' }, h('h2', null, 'Audit log'), h('button', { class: 'small secondary', onclick: () => run(async () => { const v = await api.get('/api/audit/verify'); say(v.ok ? `Chain intact (${v.count} entries)` : `TAMPERING DETECTED at entry ${v.brokenAtSeq}: ${v.reason}`, !v.ok); }) }, 'Verify integrity'),
        tbl(['#', 'Time', 'Who', 'Action', 'Detail'], d.audit.map((a) => h('tr', null, h('td', null, String(a.seq)), h('td', null, fmtDateTime(a.ts)), h('td', { class: 'mono' }, String(a.actor).slice(0, 8)), h('td', null, a.action), h('td', { class: 'mono' }, String(a.data_json).slice(0, 120)))))),
      h('div', { class: 'card' }, h('h2', null, 'Error log'), d.errors.length ? tbl(['Time', 'Request', 'Message'], d.errors.map((e) => h('tr', null, h('td', null, fmtDateTime(e.at)), h('td', { class: 'mono' }, e.request_id), h('td', { class: 'mono' }, String(e.message).slice(0, 200))))) : h('p', { class: 'muted' }, '\u2713 No errors')));
  }
  const VIEWS = { dashboard: dashboardView, tables: tablesView, payments: paymentsView, vouchers: vouchersView, staff: staffView, shifts: shiftsView, reports: reportsView, system: systemView };
  // Form values survive re-renders of the SAME screen (busy state, errors); they are never carried to a different screen.
  const screenKey = () => `${S.view}|${S.tab}|${S.wizard?.step ?? ''}|${S.editing === undefined ? 'list' : S.editing?.id || 'new'}`;
  let lastKey = '';
  function snapshotInputs() { const o = {}; if (!root.querySelectorAll) return o; for (const sel of ['input', 'select', 'textarea']) for (const el of root.querySelectorAll(sel)) if (el.id) o[el.id] = el.getAttribute('type') === 'checkbox' ? { c: !!el.checked } : { v: el.value }; return o; }
  function restoreInputs(o) { for (const [id, v] of Object.entries(o)) { const el = root.querySelector ? root.querySelector('#' + id) : null; if (!el) continue; if ('c' in v) el.checked = v.c; else el.value = v.v; } }
  function render() {
    const key = screenKey(); const saved = key === lastKey ? snapshotInputs() : {}; lastKey = key; draw(); restoreInputs(saved);
  }
  function draw() {
    if (S.view === 'login') return mount(root, loginView());
    if (S.view === 'wizard') return mount(root, h('header', { class: 'top' }, h('h1', null, 'Setup'), null), wizardView());
    mount(root, h('header', { class: 'top' }, h('h1', null, api.user?.displayName ? `Admin \u00b7 ${api.user.displayName}` : 'Admin'), h('div', { class: 'row nogrow' }, h('button', { class: 'small secondary', onclick: () => { setLang(getLang() === 'en' ? 'sw' : 'en'); render(); } }, getLang() === 'en' ? 'SW' : 'EN'), h('button', { class: 'small secondary', id: 'logout', onclick: async () => { await api.logout(); S.view = 'login'; render(); } }, t('logout')))),
      h('nav', { class: 'tabs' }, TABS.map((k) => h('button', { class: S.tab === k ? 'active' : '', 'data-tab': k, onclick: () => go(k) }, { dashboard: t('dashboard'), tables: t('tables'), payments: t('payments'), vouchers: t('vouchers'), staff: t('staff'), shifts: t('shifts'), reports: t('reports'), system: t('system') }[k]))),
      h('main', null, S.info ? h('div', { class: `msg ${S.info.bad ? 'bad' : 'ok'}`, role: 'status' }, S.info.m) : null, S.error && !['tables', 'payments', 'vouchers', 'staff', 'shifts', 'system'].includes(S.tab) ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null, VIEWS[S.tab]()));
  }
  setLang(detectLang()); render(); boot();
  const iv = timers.setInterval(() => { if (S.view === 'app' && S.tab === 'dashboard' && !S.busy) load('dashboard'); }, 30000);
  return { state: S, go, boot, stop: () => timers.clearInterval(iv) };
}

if (typeof window !== 'undefined' && window.document && !window.__NO_AUTOSTART) startAdmin({ root: document.getElementById('app'), api: createApi({ storage: window.sessionStorage, prefix: 'pt.admin.' }) });
