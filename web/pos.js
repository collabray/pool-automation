// Attendant cash POS (mobile first). Cash entry is blocked server-side without an open shift; every sale carries an idempotency key.
import { h, mount } from './lib/dom.js';
import { t, setLang, getLang, detectLang } from './lib/i18n.js';
import { kes, toMinor, fmtDateTime } from './lib/format.js';
import { createApi, newKey, ApiError } from './lib/api.js';
import { saveBlob } from './lib/download.js';

export function startPos({ root, api, timers = globalThis }) {
  const S = { view: api.loggedIn ? 'sell' : 'login', shift: null, tables: [], sel: null, cash: '', discount: '', discountReason: '', quote: null, key: newKey(), busy: false, error: null, receipt: null,
    approval: null, sales: [], stats: null, period: 'today', failed: [], closeResult: null, smsPhone: '', smsMsg: null, mode: 'cash', mpGames: '1', mpPhone: '', mpStatus: null, info: null };
  const err = (e) => (e instanceof ApiError ? e.message : t('network_error'));
  const flash = (m) => { S.info = m; render(); timers.setTimeout(() => { S.info = null; render(); }, 4000); };

  async function refresh() {
    try {
      const [sh, tb, fl] = await Promise.all([api.get('/api/shifts/current'), api.get('/api/tables'), api.get('/api/vends/failed')]);
      S.shift = sh.shift; S.tables = tb.tables; S.failed = fl.vends; S.error = null;
    } catch (e) { if (e instanceof ApiError && e.status === 401) S.view = 'login'; S.error = err(e); }
    render();
  }
  async function login(u, pin) {
    S.busy = true; S.error = null; render();
    try { const user = await api.login(u.trim().toLowerCase(), pin, 'pin'); S.user = user; S.view = 'sell'; await refresh(); } catch (e) { S.error = err(e); }
    S.busy = false; render();
  }
  async function openShift(floatShillings) {
    try { await api.post('/api/shifts/open', { floatMinor: toMinor(floatShillings || 0) }); await refresh(); } catch (e) { S.error = err(e); render(); }
  }
  let quoteSeq = 0;
  async function updateQuote() {
    const cash = toMinor(S.cash), disc = toMinor(S.discount || 0); const my = ++quoteSeq;
    if (!S.sel || !(cash > 0)) { S.quote = null; render(); return; }
    try { const q = await api.get(`/api/cash/quote?tableId=${encodeURIComponent(S.sel.id)}&cash=${cash}&discount=${disc}`); if (my === quoteSeq) { S.quote = q; renderQuote(); } } catch { /* shown on confirm */ }
  }
  async function confirmSale() {
    if (S.busy) return; const cash = toMinor(S.cash); if (!S.sel || !(cash > 0)) return;
    S.busy = true; S.error = null; render();
    const body = { tableId: S.sel.id, cashReceivedMinor: cash, ...(toMinor(S.discount) > 0 ? { discountMinor: toMinor(S.discount), discountReason: S.discountReason } : {}), ...(S.approval ? { approvalToken: S.approval } : {}) };
    try {
      const r = await api.post('/api/cash/sale', body, { idem: S.key });
      S.receipt = { ...r, tableName: S.sel.name, cash, at: new Date().toISOString() }; S.approval = null; S.view = 'receipt'; S.cash = ''; S.discount = ''; S.discountReason = ''; S.quote = null; S.key = newKey(); S.smsMsg = null;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') S.view = 'approve'; else S.error = err(e);
    }
    S.busy = false; render();
  }
  async function approve(user, secret, kind) {
    try { const r = await api.post('/api/approvals', { username: user.trim().toLowerCase(), secret, kind }); S.approval = r.token; S.pendingApproval?.(r.token); S.view = S.afterApproval || 'sell'; S.afterApproval = null; render(); if (S.view === 'sell') confirmSale(); }
    catch (e) { S.error = err(e); render(); }
  }
  async function voidSale(sale, reason, token) {
    try { await api.post('/api/cash/void', { saleId: sale.id, reason, ...(token ? { approvalToken: token } : {}) }, { idem: newKey() }); flash('Sale voided'); await loadSales(); }
    catch (e) { if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') { S.voidTarget = { sale, reason }; S.afterApproval = 'sales'; S.view = 'approveVoid'; S.error = null; } else S.error = err(e); render(); }
  }
  async function loadSales() { try { S.sales = (await api.get('/api/cash/sales')).sales; } catch (e) { S.error = err(e); } render(); }
  async function loadStats() { try { S.stats = await api.get(`/api/my/stats?period=${S.period}`); S.error = null; } catch (e) { S.error = err(e); } render(); }
  async function closeShift(counted) {
    try { S.closeResult = await api.post('/api/shifts/close', { countedMinor: toMinor(counted) }); S.shift = null; S.view = 'closed'; S.error = null; } catch (e) { S.error = err(e); }
    render();
  }
  async function mpesa() {
    if (S.busy) return; S.busy = true; S.error = null; render();
    try {
      const r = await api.post('/api/mpesa/pos-stk', { tableId: S.sel.id, games: parseInt(S.mpGames, 10), phone: S.mpPhone, idempotencyKey: S.mpKey ||= newKey() }); S.mpStatus = r.status; render();
      const poll = timers.setInterval(async () => { try { const s = await api.get(`/api/public/pay/${r.requestId}`); S.mpStatus = s.status; if (!['PENDING', 'INITIATING', 'TIMEOUT'].includes(s.status)) { timers.clearInterval(poll); S.mpKey = null; if (s.status === 'SUCCESS') flash(`M-Pesa ${s.receipt}: OK`); } render(); } catch { /* retry */ } }, 2000);
    } catch (e) { S.error = err(e); S.mpKey = null; }
    S.busy = false; render();
  }
  async function download(kind) { try { saveBlob(await api.blob(`/api/my/export?period=${S.period}&format=${kind}`), `my-sales.${kind}`); } catch (e) { S.error = err(e); render(); } }

  // ---------- views ----------
  const input = (id, label, props = {}) => [h('label', { for: id }, label), h('input', { id, ...props })];
  const money = (v) => (v === null || v === undefined ? '\u2014' : kes(v));
  function loginView() {
    let p = '';
    return h('main', null, h('h1', null, 'Attendant POS'), h('div', { class: 'card' }, input('u', t('username'), { autocapitalize: 'none', autocomplete: 'username', value: S.loginUser || '', oninput: (e) => { S.loginUser = e.target.value; } }),
      input('pin', t('pin'), { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', oninput: (e) => { p = e.target.value; } }),
      S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null, h('button', { id: 'login', class: 'block', disabled: S.busy, onclick: () => login(S.loginUser || '', p) }, t('login'))));
  }
  function shiftGate() {
    let f = '0';
    return h('main', null, h('div', { class: 'card' }, h('h2', null, t('open_shift')), ...input('float', 'Opening float (KES)', { type: 'number', inputmode: 'numeric', min: '0', value: '0', oninput: (e) => { f = e.target.value; } }),
      S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null, h('button', { id: 'open-shift', class: 'block', onclick: () => openShift(f) }, t('open_shift'))));
  }
  function sellView() {
    if (!S.shift) return shiftGate();
    const q = S.quote;
    return h('main', null, S.info ? h('div', { class: 'msg ok', role: 'status' }, S.info) : null,
      h('div', { class: 'row nogrow' }, ['cash', 'mpesa'].map((m) => h('button', { class: S.mode === m ? 'small' : 'small secondary', onclick: () => { S.mode = m; render(); } }, m === 'cash' ? 'Cash' : 'M-Pesa'))),
      h('h2', null, t('tables')),
      h('div', { class: 'grid' }, S.tables.map((tb) => h('button', { class: S.sel?.id === tb.id ? '' : 'secondary', disabled: tb.state === 'DISABLED', 'data-table': tb.name, onclick: () => { S.sel = tb; S.key = newKey(); updateQuote(); render(); } },
        `${tb.name} \u00b7 ${kes(tb.unitPriceMinor)}`, h('br'), h('small', null, tb.state === 'ONLINE' ? t('online') : tb.state === 'OFFLINE' ? t('offline') : tb.state)))),
      S.sel && S.mode === 'cash' ? h('div', { class: 'card' }, h('h2', null, S.sel.name), ...input('cash', `${t('cash_received')} (KES)`, { type: 'number', inputmode: 'numeric', min: '1', value: S.cash, oninput: (e) => { S.cash = e.target.value; S.key = newKey(); updateQuote(); } }),
        h('details', null, h('summary', null, 'Discount'), ...input('disc', 'Discount (KES)', { type: 'number', inputmode: 'numeric', min: '0', value: S.discount, oninput: (e) => { S.discount = e.target.value; updateQuote(); } }), ...input('dreason', 'Reason', { value: S.discountReason, oninput: (e) => { S.discountReason = e.target.value; } })),
        h('div', { id: 'quote', class: 'total' }, quoteText(q)),
        S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
        h('button', { id: 'confirm', class: 'block', disabled: S.busy || !q || q.rejected || q.games < 1, onclick: confirmSale }, t('confirm_cash'))) : null,
      S.sel && S.mode === 'mpesa' ? h('div', { class: 'card' }, h('h2', null, `${S.sel.name} \u00b7 M-Pesa`), ...input('mpg', 'Games', { type: 'number', min: '1', value: S.mpGames, oninput: (e) => { S.mpGames = e.target.value; } }), ...input('mpp', 'Customer phone', { type: 'tel', value: S.mpPhone, oninput: (e) => { S.mpPhone = e.target.value; } }),
        S.mpStatus ? h('div', { class: 'msg' }, S.mpStatus) : null, S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null, h('button', { class: 'block', id: 'mp-send', disabled: S.busy, onclick: mpesa }, 'Send M-Pesa request')) : null,
      S.failed.length ? h('div', { class: 'card' }, h('h2', null, 'Failed releases'), S.failed.map((v) => h('div', { class: 'msg bad' }, `${v.table_name}: ${v.failure_reason}`, h('div', { class: 'row nogrow' }, [['RETRY', 'Retry'], ['KEEP_CREDIT', 'Keep as credit'], ['REFUND', 'Refund']].map(([a, l]) => h('button', { class: 'small secondary', onclick: async () => { const reason = (typeof prompt === 'function' ? prompt('Reason?') : 'attendant action') || ''; if (reason.length < 3) return; try { await api.post(`/api/vends/${v.id}/resolve`, { action: a, reason }, { idem: newKey() }); await refresh(); } catch (e) { if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') { S.error = 'This refund is above your limit: ask a manager to resolve it from the admin dashboard.'; } else S.error = err(e); render(); } } }, l)))))) : null);
  }
  function quoteText(q) {
    if (!q) return '\u2014'; if (q.rejected) return `Not an exact amount (${kes(q.remainderMinor)} extra)`;
    return `${q.games} ${q.games === 1 ? t('game') : t('games')}${q.changeMinor ? ` \u00b7 ${t('change')} ${kes(q.changeMinor)}` : ''}${q.heldMinor ? ` \u00b7 ${kes(q.heldMinor)} held as credit` : ''}`;
  }
  function renderQuote() { const el = root.querySelector ? root.querySelector('#quote') : null; if (el) el.textContent = quoteText(S.quote); const b = root.querySelector ? root.querySelector('#confirm') : null; if (b) b.disabled = S.busy || !S.quote || S.quote.rejected || S.quote.games < 1; }
  function approveView(forVoid) {
    let s = '';
    return h('main', null, h('div', { class: 'card' }, h('h2', null, 'Manager approval needed'), h('p', { class: 'muted' }, 'A manager or the owner must enter their own name and PIN or password.'),
      ...input('au', 'Manager username', { autocapitalize: 'none', value: S.apUser || '', oninput: (e) => { S.apUser = e.target.value; } }), h('label', { for: 'ak' }, 'Credential type'), h('select', { id: 'ak', onchange: (e) => { S.apKind = e.target.value; } }, h('option', { value: 'pin', selected: (S.apKind || 'pin') === 'pin' }, 'PIN'), h('option', { value: 'password', selected: S.apKind === 'password' }, 'Password')),
      ...input('as', 'PIN / password', { type: 'password', oninput: (e) => { s = e.target.value; } }), S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: () => { S.view = forVoid ? 'sales' : 'sell'; S.error = null; render(); } }, t('cancel')),
        h('button', { id: 'approve', onclick: async () => { const u = S.apUser || '', kind = S.apKind || 'pin'; if (!forVoid) return approve(u, s, kind); try { const r = await api.post('/api/approvals', { username: u.trim().toLowerCase(), secret: s, kind }); S.view = 'sales'; S.error = null; await voidSale(S.voidTarget.sale, S.voidTarget.reason, r.token); } catch (e) { S.error = err(e); render(); } } }, t('confirm')))));
  }
  function receiptView() {
    const r = S.receipt;
    return h('main', null, h('div', { class: 'card center', id: 'receipt' }, h('h2', null, `${t('receipt_no')} ${r.receiptNo}`), h('p', { class: 'big' }, `${r.games} ${t('games')} \u2014 ${r.tableName}`), h('p', null, `${t('cash_received')}: ${kes(r.cash)}`),
      r.changeMinor ? h('p', { class: 'big' }, `${t('change')}: ${kes(r.changeMinor)}`) : null, h('p', { class: 'muted' }, fmtDateTime(r.at)),
      h('div', { class: 'row noprint' }, h('button', { class: 'secondary', onclick: () => window.print() }, 'Print'), h('button', { id: 'new-sale', onclick: () => { S.view = 'sell'; S.receipt = null; render(); } }, 'New sale')),
      h('div', { class: 'noprint' }, ...input('sms', 'SMS receipt to phone', { type: 'tel', value: S.smsPhone, oninput: (e) => { S.smsPhone = e.target.value; } }),
        h('button', { class: 'secondary block', id: 'sms-send', onclick: async () => { try { await api.post('/api/cash/receipt-sms', { saleId: r.saleId, phone: S.smsPhone }); S.smsMsg = 'Sent'; } catch (e) { S.smsMsg = err(e); } render(); } }, 'Send SMS'), S.smsMsg ? h('p', { class: 'muted' }, S.smsMsg) : null)));
  }
  function salesView() {
    return h('main', null, S.info ? h('div', { class: 'msg ok' }, S.info) : null, S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null, h('h2', null, 'Recent sales'),
      h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, ['#', t('tables'), t('games'), 'Cash', ''].map((x) => h('th', null, x)))),
        h('tbody', null, S.sales.map((s) => h('tr', null, h('td', null, s.receipt_no), h('td', null, s.table_name), h('td', null, String(s.games)), h('td', null, money(s.cash_received_minor - s.change_minor)),
          h('td', null, s.status === 'VOIDED' ? h('span', { class: 'pill bad' }, 'VOID') : h('button', { class: 'small secondary', onclick: () => { const reason = (typeof prompt === 'function' ? prompt('Reason for voiding?') : '') || ''; if (reason.length >= 3) voidSale(s, reason); } }, 'Void'))))))));
  }
  function dayView() {
    const s = S.stats;
    return h('main', null, h('div', { class: 'row nogrow' }, ['today', 'yesterday', 'week', 'month'].map((p) => h('button', { class: S.period === p ? 'small' : 'small secondary', onclick: () => { S.period = p; loadStats(); } }, t(p)))),
      S.error ? h('div', { class: 'msg bad' }, S.error) : null,
      s ? h('div', null, h('div', { class: 'grid' }, [[t('games_sold'), String(s.gamesSold)], ['Sales', String(s.salesCount)], [t('revenue'), money(s.totalMinor)], ['Average sale', money(s.averageSaleMinor)], ['Voids', String(s.voids.count)], ['Refunds', String(s.refunds.count)]].map(([l, v]) => h('div', { class: 'card' }, h('div', { class: 'stat' }, h('small', null, l), v)))),
        !s.moneyVisible ? h('p', { class: 'muted' }, 'Money figures are hidden for your account.') : null,
        h('div', { class: 'card' }, h('h2', null, 'By method'), h('table', null, h('tbody', null, Object.entries(s.byMethod).map(([m, v]) => h('tr', null, h('td', null, m), h('td', null, String(v.games)), h('td', null, money(v.totalMinor))))))),
        h('div', { class: 'card' }, h('h2', null, 'By table'), h('table', null, h('tbody', null, s.byTable.map((x) => h('tr', null, h('td', null, x.name), h('td', null, String(x.games)), h('td', null, money(x.totalMinor))))))),
        h('div', { class: 'card' }, h('h2', null, 'By hour'), h('table', null, h('tbody', null, s.byHour.map((x) => h('tr', null, h('td', null, `${String(x.hour).padStart(2, '0')}:00`), h('td', null, String(x.sales)), h('td', null, money(x.totalMinor))))))),
        s.variances.length ? h('div', { class: 'card' }, h('h2', null, 'Shift variances'), s.variances.map((v) => h('p', null, `${money(v.varianceMinor)} `, v.flagged ? h('span', { class: 'pill bad' }, 'flagged') : null))) : null,
        s.moneyVisible ? h('div', { class: 'row nogrow noprint' }, h('button', { class: 'secondary', onclick: () => download('csv') }, 'CSV'), h('button', { class: 'secondary', onclick: () => download('pdf') }, 'PDF')) : null) : h('p', { class: 'muted center' }, t('loading')));
  }
  function shiftView() {
    let c = '';
    if (!S.shift) return shiftGate();
    return h('main', null, h('div', { class: 'card' }, h('h2', null, t('close_shift')), h('p', { class: 'muted' }, `Opened ${fmtDateTime(S.shift.opened_at)} \u00b7 float ${money(S.shift.float_minor)}`),
      ...input('counted', 'Cash counted in the drawer (KES)', { type: 'number', inputmode: 'numeric', min: '0', oninput: (e) => { c = e.target.value; } }), S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      h('button', { id: 'close-shift', class: 'block danger', onclick: () => closeShift(c) }, t('close_shift'))));
  }
  function closedView() {
    const r = S.closeResult;
    return h('main', null, h('div', { class: 'card center', id: 'closed' }, h('h2', null, 'Shift closed'), h('p', null, `Expected ${kes(r.expectedMinor)} \u00b7 Counted ${kes(r.countedMinor)}`), h('p', { class: `big ${r.flagged ? 'msg bad' : ''}` }, `Variance ${kes(r.varianceMinor)}`), r.flagged ? h('p', { class: 'muted' }, 'The owner has been alerted.') : null, h('button', { class: 'block', onclick: async () => { await api.logout(); S.view = 'login'; render(); } }, t('logout'))));
  }
  function render() {
    const tabs = ['sell', 'sales', 'day', 'shift'];
    const bar = S.view === 'login' ? null : [h('header', { class: 'top' }, h('h1', null, api.user?.displayName || 'POS'), h('div', { class: 'row nogrow' }, h('button', { class: 'small secondary', onclick: () => { setLang(getLang() === 'en' ? 'sw' : 'en'); render(); } }, getLang() === 'en' ? 'SW' : 'EN'), h('button', { class: 'small secondary', id: 'logout', onclick: async () => { await api.logout(); S.view = 'login'; render(); } }, t('logout')))),
      ['receipt', 'approve', 'approveVoid', 'closed'].includes(S.view) ? null : h('nav', { class: 'tabs' }, tabs.map((v) => h('button', { class: S.view === v ? 'active' : '', onclick: () => { S.view = v; S.error = null; if (v === 'sales') loadSales(); if (v === 'day') loadStats(); render(); } }, { sell: t('sell'), sales: 'Sales', day: t('my_day'), shift: t('shift') }[v])))];
    const view = { login: loginView, sell: sellView, receipt: receiptView, approve: () => approveView(false), approveVoid: () => approveView(true), sales: salesView, day: dayView, shift: shiftView, closed: closedView }[S.view]();
    mount(root, bar, view);
  }
  setLang(detectLang()); render(); if (api.loggedIn) refresh();
  const iv = timers.setInterval(() => { if (S.view === 'sell' && api.loggedIn && !S.busy) refresh(); }, 20000);
  return { state: S, login, refresh, stop: () => timers.clearInterval(iv) };
}

if (typeof window !== 'undefined' && window.document && !window.__NO_AUTOSTART) startPos({ root: document.getElementById('app'), api: createApi({ storage: window.sessionStorage, prefix: 'pt.pos.' }) });
