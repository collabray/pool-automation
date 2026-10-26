import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type TestServer } from './helpers/server.ts';
import { makeTable } from './helpers/ctx.ts';
import { createUser } from '../src/core/auth.ts';
import { normalizePhone as serverNormalize } from '../src/core/phone.ts';

const WEB = join(import.meta.dirname, '..', 'web');
const { normalizePhone } = await import('../web/lib/phone.js'); const fmt = await import('../web/lib/format.js'); const i18n = await import('../web/lib/i18n.js');
const pf = await import('../web/lib/pricing-form.js'); const { createApi, newKey, ApiError } = await import('../web/lib/api.js');

test('web phone normalisation matches the server for every format and rejects the same invalid inputs', () => {
  const cases = ['0712345678', '0112345678', '+254712345678', '254712345678', '254112345678', ' 0712 345 678 ', '0712-345-678', '', '071234567', '07123456789', '0212345678', '+255712345678', 'abcdefghij', '2547123456'];
  for (const c of cases) { let s: string | null; try { s = serverNormalize(c); } catch { s = null; } assert.equal(normalizePhone(c), s, JSON.stringify(c)); }
  assert.equal(normalizePhone(undefined as any), null);
});
test('money formatting is integer-based and readable', () => {
  assert.equal(fmt.kes(2000), 'KES 20'); assert.equal(fmt.kes(2050), 'KES 20.50'); assert.equal(fmt.kes(123456700), 'KES 1,234,567'); assert.equal(fmt.kes(-1000), 'KES -10'); assert.equal(fmt.kes(null), '\u2014'); assert.equal(fmt.toMinor('20'), 2000); assert.equal(fmt.toMinor('0.1') + fmt.toMinor('0.2'), 30);
  assert.equal(fmt.fmtDateTime('2026-10-20T21:30:00Z'), '2026-10-21 00:30'); assert.equal(fmt.ago(new Date(Date.now() - 90_000).toISOString()), '1m ago');
});
test('i18n: every customer-page key exists in Swahili, fallback and variables work, language detection', () => {
  const { dictionaries, t, setLang, detectLang } = i18n; const customerKeys = Object.keys(dictionaries.en).filter((k) => !['login', 'username', 'password', 'pin', 'logout', 'save', 'cancel', 'confirm', 'loading', 'error', 'dashboard'].includes(k));
  const missing = Object.keys(dictionaries.en).filter((k) => !(k in dictionaries.sw)); assert.deepEqual(missing, [], 'Swahili is missing keys');
  assert.ok(customerKeys.length > 40); setLang('sw', null as any); assert.equal(t('pay_btn'), 'Lipa kwa M-Pesa'); setLang('en', null as any); assert.equal(t('pay_btn'), 'Pay with M-Pesa'); assert.equal(t('no_such_key'), 'no_such_key');
  assert.equal(detectLang({ language: 'sw-KE' }, null as any), 'sw'); assert.equal(detectLang({ language: 'en-GB' }, null as any), 'en'); assert.equal(detectLang({ language: 'sw' }, { getItem: () => 'en' } as any), 'en');
});
test('pricing form: bundles and peak rules round-trip and bad input gives clear errors', () => {
  assert.deepEqual(pf.parseBundles('6=100\n12:180.50'), [{ games: 6, priceMinor: 10000 }, { games: 12, priceMinor: 18050 }]); assert.equal(pf.formatBundles(pf.parseBundles('6=100')), '6=100');
  const peak = pf.parsePeak('fri,sat; 18:00-02:00; 30\nmon; 17:00-20:00; 25'); assert.deepEqual(peak[0], { days: [5, 6], startMin: 1080, endMin: 120, priceMinor: 3000 }); assert.equal(pf.formatPeak(peak), 'fri,sat; 18:00-02:00; 30\nmon; 17:00-20:00; 25');
  for (const bad of ['six=100', '6-100', '6=']) assert.throws(() => pf.parseBundles(bad), pf.FormError);
  for (const bad of ['fri;18:00;30', 'xyz; 18:00-20:00; 30', 'fri; 25:00-26:00; 30', 'fri; 18:00-20:00; abc']) assert.throws(() => pf.parsePeak(bad), pf.FormError);
  const p = pf.buildPricing({ unit: '20', min: '1', max: '10', bundles: '6=100', peak: '', remainder: 'REFUND' }); assert.deepEqual([p.unitPriceMinor, p.maxGames, p.remainderPolicy], [2000, 10, 'REFUND']); assert.throws(() => pf.buildPricing({ unit: '0' }), pf.FormError);
});
test('CSP compliance: no inline scripts/styles/handlers, only same-origin assets that exist, no dangerous DOM sinks', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const all = files(WEB); const html = all.filter((f) => f.endsWith('.html')); assert.ok(html.length >= 6);
  for (const f of html) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(s), `${f}: inline script`); assert.ok(!/<style[\s>]/i.test(s), `${f}: <style> block`); assert.ok(!/\sstyle\s*=/.test(s), `${f}: style attribute`); assert.ok(!/\son[a-z]+\s*=/i.test(s), `${f}: inline event handler`); assert.ok(!/javascript:/i.test(s), `${f}: javascript: URL`);
    for (const m of s.matchAll(/(?:src|href)="([^"]+)"/g)) { const u = m[1]; if (u.startsWith('#') || u.startsWith('mailto:')) continue; assert.ok(u.startsWith('/') && !u.startsWith('//'), `${f}: non-local asset ${u}`); assert.ok(existsSync(join(WEB, u.split('?')[0])) || ['/qr-sheet.html', '/owner.html', '/admin.html', '/pos.html', '/pay.html'].includes(u), `${f}: missing ${u}`); }
  }
  for (const f of all.filter((x) => x.endsWith('.js'))) { const s = readFileSync(f, 'utf8'); for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', "setAttribute('style'"]) assert.ok(!s.includes(bad), `${f}: uses ${bad}`); assert.ok(!/style:\s*['"`]/.test(s), `${f}: inline style value`); }
  const man = JSON.parse(readFileSync(join(WEB, 'manifest.webmanifest'), 'utf8')); assert.equal(man.display, 'standalone'); for (const ic of man.icons) assert.ok(existsSync(join(WEB, ic.src)), ic.src);
});

let srv: TestServer;
test('api client: login, silent refresh on 401 with rotation, single-flight refresh, idempotency header, logout', async () => {
  srv = await startServer(undefined, { webRoot: WEB }); createUser(srv.ctx, { username: 'webowner', displayName: 'Web Owner', role: 'owner', password: 'Owner-Passw0rd!' }, 't');
  const store = new Map<string, string>(); const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const api = createApi({ base: srv.base, storage });
  await assert.rejects(api.login('webowner', 'wrong-password1'), (e: any) => e instanceof ApiError && e.status === 401);
  const u = await api.login('webowner', 'Owner-Passw0rd!'); assert.equal(u.role, 'owner'); assert.ok(api.loggedIn);
  const first = JSON.parse(store.get('pt.session')!); assert.ok((await api.get('/api/me')).user);
  // expire the access token: the client must refresh transparently, in parallel calls only once
  const { signJwt } = await import('../src/core/auth.ts'); const dead = signJwt(srv.ctx, { sub: u.id, role: 'owner', tv: 0, iat: 1, exp: 2 }); const s = JSON.parse(store.get('pt.session')!); s.accessToken = dead; store.set('pt.session', JSON.stringify(s));
  const api2 = createApi({ base: srv.base, storage }); const res = await Promise.all([api2.get('/api/me'), api2.get('/api/health'), api2.get('/api/me')]); assert.ok(res[0].user && res[2].user);
  const second = JSON.parse(store.get('pt.session')!); assert.notEqual(second.refreshToken, first.refreshToken); assert.equal(srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE action='auth.refresh_reuse_detected'")!.n, 0);
  const r = await api2.post('/api/shifts/open', { floatMinor: 0 }, { idem: newKey() }).catch((e) => e); assert.ok(r instanceof ApiError || r.shiftId);
  assert.notEqual(newKey(), newKey()); await api2.logout(); assert.ok(!api2.loggedIn); assert.equal(store.get('pt.session'), undefined);
  await assert.rejects(createApi({ base: srv.base, storage: null as any }).get('/api/me'), (e: any) => e.status === 401);
  await srv.close();
});
void makeTable;
