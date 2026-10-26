// Customer "Pay for games" page. Opened from the QR code on the table (?t=<signed table code>); also works as a kiosk (?kiosk=1).
import { h, mount } from './lib/dom.js';
import { t, setLang, getLang, detectLang } from './lib/i18n.js';
import { kes } from './lib/format.js';
import { normalizePhone } from './lib/phone.js';
import { createApi, newKey, ApiError } from './lib/api.js';

const TERMINAL = new Set(['SUCCESS', 'CANCELLED', 'WRONG_PIN', 'INSUFFICIENT_FUNDS', 'FAILED', 'EXPIRED']);
const MESSAGE = { CANCELLED: 'st_cancelled', WRONG_PIN: 'st_wrong_pin', INSUFFICIENT_FUNDS: 'st_insufficient', TIMEOUT: 'st_timeout', FAILED: 'st_failed', EXPIRED: 'st_expired' };

export function startPay({ root, code, kiosk = false, base = '', fetchImpl, EventSourceImpl = globalThis.EventSource, timers = globalThis, now = Date.now, storage = null }) {
  const api = createApi({ base, storage: null, fetchImpl });
  const S = { info: null, games: null, custom: false, phone: storage?.getItem?.('pt.phone') || '', view: 'loading', req: null, error: null, busy: false, key: newKey(), voucher: '', voucherMsg: null, left: 0 };
  let stopWatch = () => {}, countdownEl = null, infoTimer = null, resetTimer = null;

  const errText = (e) => {
    if (e instanceof ApiError) {
      if (e.code === 'TABLE_UNAVAILABLE') return t(e.details === 'OFFLINE' ? 'tbl_offline' : e.details === 'DISABLED' ? 'tbl_disabled' : 'tbl_faulted');
      if (e.code === 'RATE_LIMITED') return t('rate_limited'); if (e.code === 'NOT_CONFIGURED') return t('not_configured');
      if (e.code === 'INVALID_PHONE') return t('phone_invalid'); if (e.status === 404) return t('unknown_table'); return e.message;
    }
    return t('network_error');
  };
  const unitCount = () => S.info.maxGames - S.info.minGames + 1;
  const totalFor = (g) => (g >= S.info.minGames && g <= S.info.maxGames ? S.info.prices[g - S.info.minGames] : null);

  async function loadInfo() {
    try { S.info = await api.get(`/api/public/table/${encodeURIComponent(code)}`); if (S.games === null) S.games = Math.min(Math.max(S.info.minGames, 1), S.info.maxGames); S.error = null; if (S.view === 'loading' || S.view === 'error') S.view = 'form'; }
    catch (e) { S.error = errText(e); if (!S.info) S.view = 'error'; }
  }
  function watch(requestId) {
    stopWatch();
    let es = null, poll = null, closed = false;
    const apply = (s) => { if (closed || !s) return; S.req = s; if (TERMINAL.has(s.status) || s.status === 'TIMEOUT') { if (TERMINAL.has(s.status)) stop(); S.view = 'done'; } else S.view = 'pending'; render(); if (S.view === 'done' && S.req.status === 'SUCCESS' && kiosk) { resetTimer = timers.setTimeout(reset, 20000); } };
    const fetchOnce = async () => { try { apply(await api.get(`/api/public/pay/${requestId}`)); } catch { /* transient: next poll will retry */ } };
    const stop = () => { closed = true; es?.close?.(); timers.clearInterval(poll); };
    if (EventSourceImpl) { try { es = new EventSourceImpl(`${base}/api/public/pay/${requestId}/events`); es.onmessage = (m) => { try { apply(JSON.parse(m.data)); } catch { /* ignore malformed frame */ } }; es.onerror = () => { /* polling below is the fallback */ }; } catch { es = null; } }
    poll = timers.setInterval(fetchOnce, es ? 5000 : 2000); fetchOnce();
    stopWatch = stop;
  }
  function reset() { stopWatch(); timers.clearTimeout(resetTimer); S.req = null; S.busy = false; S.key = newKey(); S.error = null; S.view = 'form'; render(); loadInfo().then(render); }

  async function pay() {
    if (S.busy) return;                                  // double tap: ignored
    const phone = normalizePhone(S.phone);
    if (!phone) { S.error = t('phone_invalid'); render(); return; }
    S.busy = true; S.error = null; render(); storage?.setItem?.('pt.phone', S.phone);
    try {
      const r = await api.post('/api/public/pay', { code, games: S.games, phone: S.phone, idempotencyKey: S.key });
      S.req = { requestId: r.requestId, status: r.status, amountMinor: r.amountMinor, games: r.games, expiresAtMs: r.expiresAtMs }; S.view = r.status === 'FAILED' ? 'done' : 'pending'; S.busy = false; render();
      if (r.status !== 'FAILED') watch(r.requestId);
    } catch (e) { S.busy = false; S.error = errText(e); S.key = newKey(); render(); if (e instanceof ApiError && e.code === 'TABLE_UNAVAILABLE') loadInfo().then(render); }
  }
  async function redeem() {
    if (S.busy || !S.voucher.trim()) return; S.busy = true; S.voucherMsg = null; render();
    try { await api.post('/api/public/voucher', { code, voucher: S.voucher.trim() }); S.voucherMsg = { ok: true, text: t('voucher_ok') }; S.voucher = ''; }
    catch (e) { S.voucherMsg = { ok: false, text: errText(e) }; }
    S.busy = false; render();
  }

  const gamesLabel = (n) => `${n} ${n === 1 ? t('game') : t('games')}`;
  function formView() {
    const i = S.info, total = totalFor(S.games), quick = [1, 2, 3, 5].filter((g) => g >= i.minGames && g <= i.maxGames);
    return [
      h('div', { class: 'card' },
        h('p', { class: 'muted' }, `${t('price_per_game')}: `, h('strong', null, kes(i.unitPriceMinor))),
        i.bundles.length ? h('p', { class: 'muted' }, i.bundles.map((b) => `${gamesLabel(b.games)} = ${kes(b.priceMinor)}`).join(' \u00b7 ')) : null,
        h('label', null, t('how_many')),
        h('div', { class: 'quick', role: 'group' }, quick.map((g) => h('button', { class: S.games === g && !S.custom ? 'sel' : 'secondary', type: 'button', 'aria-pressed': String(S.games === g && !S.custom), onclick: () => { S.games = g; S.custom = false; render(); } }, String(g))),
          h('button', { class: S.custom ? 'sel' : 'secondary', type: 'button', onclick: () => { S.custom = true; render(); } }, t('custom'))),
        S.custom ? h('input', { id: 'custom', type: 'number', inputmode: 'numeric', min: i.minGames, max: i.maxGames, value: String(S.games), 'aria-label': t('custom'), oninput: (e) => { const n = parseInt(e.target.value, 10); if (Number.isInteger(n)) { S.games = Math.min(Math.max(n, i.minGames), i.maxGames); renderTotal(); } } }) : null,
        h('p', { class: 'muted center' }, `${t('min_games')} ${i.minGames} \u00b7 ${t('max_games')} ${i.maxGames}`),
        h('div', { class: 'total', id: 'total' }, `${gamesLabel(S.games)} = ${kes(total)}`),
        h('label', { for: 'phone' }, t('phone')),
        h('input', { id: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: t('phone_hint'), value: S.phone, oninput: (e) => { S.phone = e.target.value; } }),
        S.error ? h('div', { class: 'msg bad', role: 'alert' }, S.error) : null,
        h('button', { class: 'block', id: 'pay', type: 'button', disabled: S.busy, onclick: pay }, S.busy ? t('paying') : `${t('pay_btn')} \u2014 ${kes(total)}`)),
      otherWays(),
    ];
  }
  function renderTotal() { const el = root.querySelector ? root.querySelector('#total') : null; if (el) el.textContent = `${gamesLabel(S.games)} = ${kes(totalFor(S.games))}`; const b = root.querySelector ? root.querySelector('#pay') : null; if (b && !S.busy) b.textContent = `${t('pay_btn')} \u2014 ${kes(totalFor(S.games))}`; }
  function otherWays() {
    return h('div', { class: 'card' }, h('h2', null, t('other_ways')),
      S.info.paybill ? h('div', null, h('h3', null, t('paybill')), h('p', null, `${t('paybill_no')}: `, h('strong', { class: 'mono' }, S.info.paybill.number)), h('p', null, `${t('account_no')}: `, h('strong', { class: 'mono' }, S.info.paybill.account)), h('p', { class: 'muted' }, t('paybill_note'))) : null,
      h('label', { for: 'voucher' }, t('voucher')),
      h('div', { class: 'row' }, h('input', { id: 'voucher', value: S.voucher, autocapitalize: 'characters', autocomplete: 'off', oninput: (e) => { S.voucher = e.target.value; } }), h('button', { class: 'secondary', id: 'redeem', type: 'button', disabled: S.busy, onclick: redeem }, t('redeem'))),
      S.voucherMsg ? h('div', { class: `msg ${S.voucherMsg.ok ? 'ok' : 'bad'}`, role: 'status' }, S.voucherMsg.text) : null);
  }
  function blockedView() {
    const m = { OFFLINE: 'tbl_offline', FAULTED: 'tbl_faulted', DISABLED: 'tbl_disabled' }[S.info.state];
    return h('div', { class: 'card' }, h('div', { class: 'msg warn', role: 'alert' }, t(m)), h('button', { class: 'secondary block', type: 'button', onclick: () => loadInfo().then(render) }, t('try_again')));
  }
  function pendingView() {
    countdownEl = h('strong', { id: 'countdown' }, '');
    const tick = () => { S.left = Math.max(0, Math.ceil((S.req.expiresAtMs - now()) / 1000)); if (countdownEl) countdownEl.textContent = String(S.left); };
    tick(); const iv = timers.setInterval(() => { if (!countdownEl || S.view !== 'pending') return timers.clearInterval(iv); tick(); }, 1000);
    return h('div', { class: 'card center' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('waiting_for') }), h('p', { class: 'big' }, t('check_phone')), h('p', { class: 'muted' }, `${kes(S.req.amountMinor)} \u00b7 ${gamesLabel(S.req.games)}`), h('p', null, t('waiting_for'), ' \u00b7 ', countdownEl, ' ', t('seconds_left')));
  }
  function doneView() {
    const r = S.req;
    if (r.status === 'SUCCESS') return h('div', { class: 'card center' }, h('p', { class: 'big', id: 'success' }, t('success_title')), h('p', null, `${t('games_left')}: `, h('strong', null, String(r.gamesRemaining ?? r.games))), h('p', null, `${t('receipt')}: `, h('strong', { class: 'mono' }, r.receipt || '\u2014')), kiosk ? null : h('button', { class: 'secondary block', type: 'button', onclick: reset }, t('pay_title')));
    return h('div', { class: 'card' }, h('div', { class: 'msg bad', role: 'alert', id: 'failure' }, t(MESSAGE[r.status] || 'st_failed')), h('button', { class: 'block', id: 'retry', type: 'button', onclick: reset }, t('try_again')));
  }

  function render() {
    const langBtn = h('button', { class: 'secondary small noprint', type: 'button', 'aria-label': t('lang'), onclick: () => { setLang(getLang() === 'en' ? 'sw' : 'en'); render(); } }, getLang() === 'en' ? 'Kiswahili' : 'English');
    let body;
    if (S.view === 'loading') body = h('p', { class: 'center muted' }, t('loading'));
    else if (S.view === 'error') body = h('div', { class: 'card' }, h('div', { class: 'msg bad', role: 'alert' }, S.error || t('network_error')), h('button', { class: 'secondary block', type: 'button', onclick: () => loadInfo().then(render) }, t('try_again')));
    else if (S.view === 'pending') body = pendingView();
    else if (S.view === 'done') body = doneView();
    else body = S.info.state !== 'AVAILABLE' ? [blockedView(), otherWays()] : formView();
    mount(root, h('div', { class: 'row nogrow', style: undefined }, h('div', null, h('h1', { style: undefined }, S.info ? S.info.name : t('pay_title')), S.info ? h('p', { class: 'muted' }, S.info.business) : null), langBtn), body);
  }

  setLang(detectLang());
  if (typeof document !== 'undefined' && document.documentElement?.style?.setProperty) { /* brand colour is applied through the CSSOM (allowed by CSP, unlike inline style attributes) */ }
  render();
  loadInfo().then(() => { if (S.info && document?.documentElement?.style?.setProperty) document.documentElement.style.setProperty('--brand', S.info.brandColor || '#0b6e4f'); render(); });
  infoTimer = timers.setInterval(() => { if (S.view === 'form') loadInfo().then(() => { if (S.view === 'form' && !S.busy && document?.activeElement?.tagName !== 'INPUT') render(); }); }, 20000);
  return { state: S, stop: () => { stopWatch(); timers.clearInterval(infoTimer); timers.clearTimeout(resetTimer); }, pay, redeem };
}

if (typeof window !== 'undefined' && window.document && !window.__NO_AUTOSTART) {
  const q = new URLSearchParams(location.search);
  if (q.has('kiosk')) document.body.classList.add('kiosk');
  startPay({ root: document.getElementById('app'), code: q.get('t') || '', kiosk: q.has('kiosk'), storage: window.localStorage });
}
