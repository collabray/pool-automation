// Owner / manager mobile app (installable PWA). Shows games played and money earned, lets the owner open a table remotely, and surfaces alerts.
import { h, mount } from './lib/dom.js';
import { t, setLang, getLang, detectLang } from './lib/i18n.js';
import { kes, ago, fmtDateTime } from './lib/format.js';
import { createApi, newKey, ApiError } from './lib/api.js';

const PERIODS = [['today', 'today'], ['yesterday', 'yesterday'], ['week', 'week'], ['month', 'month']];

export function startOwner({ root, api, timers = globalThis, confirmFn = (m) => (typeof confirm === 'function' ? confirm(m) : true) }) {
  const S = { view: api.loggedIn ? 'home' : 'login', period: 'today', data: null, tables: [], alerts: [], staff: [], error: null, busy: false, toast: null, needTotp: false };
  let refreshTimer = null;
  const toast = (msg, bad = false) => { S.toast = { msg, bad }; render(); timers.setTimeout(() => { S.toast = null; render(); }, 4000); };
  const fail = (e) => { if (e instanceof ApiError && e.status === 401) { S.view = 'login'; S.error = null; } S.error = e instanceof ApiError ? e.message : t('network_error'); };

  async function load() {
    try {
      const [dash, board, al, cmp] = await Promise.all([api.get('/api/owner/dashboard'), api.get('/api/tables'), api.get('/api/alerts'), api.get(`/api/staff/compare?period=${S.period}`)]);
      const rep = S.period === 'today' ? dash.today : await api.get(`/api/reports/summary?period=${S.period}`);
      S.data = { dash, rep }; S.tables = board.tables; S.alerts = al.alerts; S.staff = cmp.staff; S.error = null; S.view = 'home';
    } catch (e) { fail(e); }
    render();
  }
  async function login(u, p, totp) {
    S.busy = true; S.error = null; render();
    try { const user = await api.login(u, p, 'password', totp); if (user.role === 'attendant') { await api.logout(); throw new ApiError(403, 'FORBIDDEN', 'This app is for owners and managers. Attendants use the POS.'); } S.needTotp = false; await load(); }
    catch (e) { if (e instanceof ApiError && e.code === 'TOTP_REQUIRED') S.needTotp = true; S.error = e instanceof ApiError ? e.message : t('network_error'); }
    S.busy = false; render();
  }
  async function openTable(tb) {
    if (!confirmFn(`${t('open_table')}: ${tb.name}?`)) return;
    try { await api.post(`/api/owner/tables/${tb.id}/open`, { reason: 'Owner remote open' }, { idem: newKey() }); toast(`${tb.name}: ${t('open_table')} \u2713`); await load(); }
    catch (e) { toast(e instanceof ApiError ? e.message : t('network_error'), true); }
  }

  const stat = (label, value) => h('div', { class: 'card' }, h('div', { class: 'stat' }, h('small', null, label), value));
  const stateOf = (tb) => (tb.state === 'ONLINE' ? ['on', t('online')] : tb.state === 'OFFLINE' ? ['off', t('offline')] : ['bad', t('faulted')]);
  function loginView() {
    let p = '', c = '';
    return h('main', null, h('h1', null, 'Pool Owner'), h('div', { class: 'card' },
      h('label', { for: 'u' }, t('username')), h('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', value: S.loginUser || '', oninput: (e) => { S.loginUser = e.target.value; } }),
      h('label', { for: 'p' }, t('password')), h('input', { id: 'p', type: 'password', autocomplete: 'current-password', oninput: (e) => { p = e.target.value; } }),
      S.needTotp ? [h('label', { for: 'c' }, 'Authenticator code'), h('input', { id: 'c', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', oninput: (e) => { c = e.target.value; } })] : null,
      S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      h('button', { id: 'login', class: 'block', disabled: S.busy, onclick: () => login(S.loginUser || '', p, c) }, t('login'))));
  }
  function homeView() {
    const r = S.data?.rep, d = S.data?.dash;
    const methods = r ? Object.entries(r.byMethod) : [];
    const maxHour = Math.max(1, ...(r?.byHour ?? []).map((x) => x.revenueMinor));
    return h('main', null,
      h('div', { class: 'row nogrow noprint' }, PERIODS.map(([k, label]) => h('button', { class: S.period === k ? 'small' : 'small secondary', onclick: () => { S.period = k; load(); } }, t(label)))),
      S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
      r ? h('div', { class: 'grid' }, stat(t('revenue'), kes(r.poolRevenueMinor)), stat(t('games_sold'), String(r.gamesSold)), stat(t('games_played'), String(r.gamesPlayed)),
        S.period === 'today' ? stat('vs ' + t('yesterday'), kes(d.yesterday.poolRevenueMinor)) : null) : h('p', { class: 'muted center' }, t('loading')),
      r && methods.length ? h('div', { class: 'card' }, h('h2', null, 'By payment method'), h('table', null, h('tbody', null, methods.map(([m, v]) => h('tr', null, h('td', null, m), h('td', null, `${v.games} ${t('games')}`), h('td', null, v.totalMinor ? kes(v.totalMinor) : '\u2014')))))) : null,
      r && r.byHour.length ? h('div', { class: 'card' }, h('h2', null, 'By hour'), r.byHour.map((x) => h('div', { class: 'row nogrow' }, h('span', { class: 'mono', style: undefined }, String(x.hour).padStart(2, '0') + ':00'), h('div', { class: 'barwrap', role: 'img', 'aria-label': kes(x.revenueMinor) }, h('div', { class: 'bar', 'data-w': String(Math.round((x.revenueMinor / maxHour) * 100)) })), h('span', null, kes(x.revenueMinor))))) : null,
      h('h2', null, t('tables')),
      h('div', { class: 'grid' }, S.tables.map((tb) => { const [cls, label] = stateOf(tb);
        return h('div', { class: 'card' }, h('div', { class: 'row nogrow' }, h('strong', null, tb.name), h('span', { class: `pill ${cls}` }, label), tb.tamper ? h('span', { class: 'pill bad' }, 'TAMPER') : null),
          h('p', { class: 'muted' }, `${t('credits_pending')}: ${tb.creditsPending + tb.inFlight} \u00b7 ${t('games_played')}: ${tb.gamesToday}`), h('p', { class: 'muted' }, `Seen ${ago(tb.lastSeenAt)}`),
          h('button', { class: 'block', disabled: tb.state !== 'ONLINE', onclick: () => openTable(tb) }, t('open_table'))); })),
      S.staff.length ? h('div', { class: 'card' }, h('h2', null, t('staff')), h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, ['Name', t('games_sold'), t('revenue'), 'Voids'].map((x) => h('th', null, x)))),
        h('tbody', null, S.staff.map((s) => h('tr', null, h('td', null, s.name), h('td', null, String(s.gamesSold)), h('td', null, kes(s.totalMinor)), h('td', null, String(s.voids)))))))) : null,
      h('h2', null, `Alerts (${S.alerts.length})`),
      S.alerts.length ? S.alerts.map((a) => h('div', { class: `msg ${a.severity === 'HIGH' ? 'bad' : 'warn'}` }, h('strong', null, a.kind), ' \u2014 ', a.message, h('div', { class: 'muted' }, fmtDateTime(a.created_at)),
        h('button', { class: 'small secondary', onclick: async () => { await api.post(`/api/alerts/${a.id}/resolve`); load(); } }, 'Resolve'))) : h('p', { class: 'muted' }, '\u2713'),
      d && d.unallocatedPending ? h('div', { class: 'msg warn' }, `${d.unallocatedPending} payment(s) need assigning \u2014 open the admin dashboard.`) : null);
  }
  function render() {
    const bar = h('header', { class: 'top' }, h('h1', null, S.data?.dash?.business || 'Pool Owner'), h('div', { class: 'row nogrow' },
      h('button', { class: 'small secondary', 'aria-label': t('lang'), onclick: () => { setLang(getLang() === 'en' ? 'sw' : 'en'); render(); } }, getLang() === 'en' ? 'SW' : 'EN'),
      S.view === 'home' ? [h('button', { class: 'small secondary', id: 'refresh', onclick: load }, '\u21bb'), h('button', { class: 'small secondary', id: 'logout', onclick: async () => { await api.logout(); S.view = 'login'; S.data = null; render(); } }, t('logout'))] : null));
    mount(root, bar, S.view === 'login' ? loginView() : homeView(), S.toast ? h('div', { class: `msg ${S.toast.bad ? 'bad' : 'ok'}`, role: 'status' }, S.toast.msg) : null);
    // bar widths are set through the CSSOM (inline style attributes are blocked by the CSP)
    if (root.querySelectorAll) for (const el of root.querySelectorAll('[data-w]')) el.style.width = el.getAttribute('data-w') + '%';
  }
  setLang(detectLang()); render();
  if (api.loggedIn) load();
  refreshTimer = timers.setInterval(() => { if (S.view === 'home' && !S.busy) load(); }, 30000);
  return { state: S, load, login, openTable, stop: () => timers.clearInterval(refreshTimer) };
}

if (typeof window !== 'undefined' && window.document && !window.__NO_AUTOSTART) {
  startOwner({ root: document.getElementById('app'), api: createApi({ storage: window.localStorage, prefix: 'pt.owner.' }) });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
