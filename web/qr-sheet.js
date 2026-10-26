// Printable QR sheet: one signed QR per table. Print (Ctrl+P) on A4 and laminate; the QR never changes unless the table code is rotated.
import { h, mount } from './lib/dom.js';
import { createApi, ApiError } from './lib/api.js';
import { blobToDataUrl } from './lib/download.js';

export async function startQrSheet({ root, api, ids = null }) {
  mount(root, h('main', null, h('p', { class: 'center muted' }, 'Loading\u2026')));
  try {
    const tables = (await api.get('/api/tables')).tables.filter((t) => !ids || ids.includes(t.id));
    const cards = [];
    for (const t of tables) {
      const [info, svg] = await Promise.all([api.get(`/api/tables/${t.id}/qr`), api.blob(`/api/tables/${t.id}/qr.svg`)]);
      cards.push(h('div', { class: 'qr' }, h('h2', null, t.name), h('img', { src: await blobToDataUrl(svg), alt: `QR code for ${t.name}`, width: '260', height: '260' }), h('p', null, 'Scan to pay for games / Scan ulipie michezo'), h('p', { class: 'mono muted' }, info.code)));
    }
    mount(root, h('main', null, h('div', { class: 'noprint' }, h('button', { onclick: () => window.print() }, 'Print'), h('p', { class: 'muted' }, 'Tip: set the public website address in Admin \u2192 System first. Laminate the printout and fix it to the table.')), h('div', { class: 'sheet' }, cards)));
  } catch (e) { mount(root, h('main', null, h('div', { class: 'msg bad', role: 'alert' }, e instanceof ApiError ? e.message : 'Could not load. Sign in at /admin.html first, then reopen this page.'))); }
}
if (typeof window !== 'undefined' && window.document && !window.__NO_AUTOSTART) startQrSheet({ root: document.getElementById('app'), api: createApi({ storage: window.sessionStorage, prefix: 'pt.admin.' }), ids: new URLSearchParams(location.search).get('ids')?.split(',') ?? null });
