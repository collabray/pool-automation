// Load test: 50 tables (each with a simulated ESP32 long-polling the server) and 30 concurrent customer payments, end to end
// (public pay API -> fake Daraja -> callback -> credit -> signed command -> device executes -> signed ack).
// Run: npm run load        Exit code 1 if any invariant is violated.
import { startServer, api } from '../tests/helpers/server.ts';
import { FakeDaraja } from '../tests/helpers/fake-daraja.ts';
import { createTable } from '../src/core/tables.ts';
import { saveDarajaConfig } from '../src/core/daraja.ts';
import { signedTableCode } from '../src/core/tablecode.ts';
import { DeviceSim } from '../src/sim/device-sim.ts';
import { A, balance, verifyLedger } from '../src/core/ledger.ts';
import { verifyAuditChain } from '../src/core/audit.ts';
import { kes } from '../src/core/money.ts';
import { setSetting } from '../src/core/settings.ts';

const TABLES = Number(process.env.LOAD_TABLES ?? 50), PAYMENTS = Number(process.env.LOAD_PAYMENTS ?? 30);
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const stats = (name: string, a: number[]) => console.log(`${name.padEnd(38)} n=${String(a.length).padStart(3)}  p50=${pct(a, 50)}ms  p95=${pct(a, 95)}ms  max=${Math.max(0, ...a)}ms`);

const fake = new FakeDaraja(); await fake.start(); const srv = await startServer(fake, { webRoot: null }); const call = api(srv.base);
saveDarajaConfig(srv.ctx, { env: 'sandbox', shortcode: fake.shortcode, partyB: fake.shortcode, passkey: fake.passkey, consumerKey: fake.key, consumerSecret: fake.secret, txType: 'CustomerPayBillOnline', callbackBaseUrl: 'https://load.example.com', callbackToken: 'load-token' }, 'load');
setSetting(srv.ctx, 'limits.stk_per_ip_hour', '1000'); setSetting(srv.ctx, 'limits.stk_per_table_hour', '1000'); setSetting(srv.ctx, 'limits.stk_per_phone_hour', '1000');
const pricing = { unitPriceMinor: kes(20), bundles: [], peakWindows: [], minGames: 1, maxGames: 20, remainderPolicy: 'HOLD_CREDIT' };
const tables = Array.from({ length: TABLES }, (_, i) => { const t = createTable(srv.ctx, { name: `Table ${i + 1}`, vendMode: i % 3 === 0 ? 'COIN_PULSE' : i % 3 === 1 ? 'SOLENOID_SLIDE' : 'GATE_SOLENOID', vendParams: i % 3 === 0 ? { pulses: 2 } : { holdMs: 800 }, pricing, releaseMode: 'ALL', actor: 'load' });
  const code = signedTableCode(srv.ctx, srv.ctx.db.get<{ public_code: string }>('SELECT public_code FROM pool_tables WHERE id=?', t.tableId)!.public_code);
  return { ...t, code, mode: (i % 3 === 0 ? 'COIN_PULSE' : i % 3 === 1 ? 'SOLENOID_SLIDE' : 'GATE_SOLENOID') as 'COIN_PULSE' | 'SOLENOID_SLIDE' | 'GATE_SOLENOID', sim: null as DeviceSim | null }; });
let running = true; const executedAt = new Map<string, number>(); let syncErrors = 0, syncs = 0;
const loops = tables.map(async (t) => { const sim = new DeviceSim({ baseUrl: srv.base, deviceId: t.deviceId, secret: t.deviceSecret, mode: t.mode }); t.sim = sim;
  while (running) { try { const r = await sim.sync(5); syncs++; if (r.status !== 200) syncErrors++; for (const v of r.executed) executedAt.set(v, Date.now()); } catch { syncErrors++; await new Promise((r) => setTimeout(r, 200)); } } });
await new Promise((r) => setTimeout(r, 1500));
console.log(`${TABLES} simulated controllers online: ${srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM pool_tables WHERE online=1')!.n}`);

// 30 customers pay at the same moment, on 30 different tables, for different numbers of games.
const results = await Promise.all(Array.from({ length: PAYMENTS }, async (_, i) => {
  const t = tables[i % TABLES]; const games = (i % 5) + 1; const tPay = Date.now();
  const pay = await call('POST', '/api/public/pay', { code: t.code, games, phone: `07${String(10000000 + i)}`, idempotencyKey: `load-${i}-${Date.now()}` }); const tPaid = Date.now();
  if (pay.status !== 201) return { ok: false, why: `pay ${pay.status} ${JSON.stringify(pay.json)}` };
  return { ok: true, i, t, games, payMs: tPaid - tPay, requestId: pay.json.requestId as string, tPaid };
}));
const good = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok); const bad = results.filter((r) => !r.ok);
// Safaricom answers each push: deliver all 30 callbacks concurrently (some duplicated, as Safaricom sometimes does).
const t0 = Date.now(); const cbLat: number[] = [];
await Promise.all(good.flatMap((g) => { const push = fake.pushes.find((p) => p.checkoutRequestId === srv.ctx.db.get<{ c: string }>('SELECT checkout_request_id c FROM mpesa_requests WHERE id=?', g.requestId)!.c)!;
  const body = fake.callbackBody(push.checkoutRequestId, { receipt: `LOAD${String(g.i).padStart(6, '0')}` });
  return [0, 1].map(async () => { const s = Date.now(); const r = await call('POST', '/api/mpesa/stk-callback/load-token', body); cbLat.push(Date.now() - s); if (r.status !== 200) syncErrors++; }); }));
// wait until every paid game has been physically released and acknowledged
const expected = good.reduce((s, g) => s + g.games, 0);
const deadline = Date.now() + 30_000; const confirmed = () => srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM vends WHERE state='CONFIRMED'")!.n;
while (confirmed() < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
const total = Date.now() - t0; running = false; await new Promise((r) => setTimeout(r, 6500));
const vendLat = good.map((g) => { const ids = srv.ctx.db.all<{ id: string }>("SELECT v.id FROM vends v WHERE v.table_id=?", g.t.tableId).map((x) => x.id); const times = ids.map((id) => executedAt.get(id)).filter((x): x is number => !!x); return times.length ? Math.max(...times) - t0 : 0; });

const payments = srv.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM payments WHERE source='MPESA_STK'")!.n; const issued = -balance(srv.ctx.db, A.gamesIssued);
const vends = srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM vends')!.n; const executed = [...executedAt.keys()].length; const e5xx = srv.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM error_log')!.n;
console.log('\n=== results ===');
stats('POST /api/public/pay (30 at once)', good.map((g) => g.payMs)); stats('stk-callback (60 incl. duplicates)', cbLat); stats('callback -> all games released', vendLat.filter(Boolean));
console.log(`total time from callbacks to last release: ${total}ms; device syncs served: ${syncs}`);
const checks: [string, boolean][] = [
  [`all ${PAYMENTS} payments accepted (${bad.length} failed: ${bad.map((b: any) => b.why).slice(0, 2)})`, bad.length === 0], [`exactly ${PAYMENTS} credited despite duplicate callbacks (got ${payments})`, payments === PAYMENTS],
  [`games issued == games paid for (${issued} vs ${expected})`, issued === expected], [`vends created == games paid for (${vends} vs ${expected})`, vends === expected], [`every vend executed exactly once by a device (${executed} vs ${expected})`, executed === expected && confirmed() === expected],
  ['ledger balanced', verifyLedger(srv.ctx.db).length === 0], ['audit chain intact', verifyAuditChain(srv.ctx.db).ok], [`no server errors logged (${e5xx})`, e5xx === 0], [`no failed device syncs (${syncErrors})`, syncErrors === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
await Promise.all(loops).catch(() => undefined); await srv.close(); await fake.stop();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
