import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Db } from '../core/db.ts';
import { migrate } from '../core/migrate.ts';
import { loadMasterKey } from '../core/crypto.ts';
import { dispatch } from '../core/vend.ts';
import { enforceRetention } from '../core/privacy.ts';
import { pruneRateEvents } from '../core/ratelimit.ts';
import { buildApp } from './app.ts';

const env = process.env;
function required(name: string): string { const v = env[name]; if (!v) { console.error(`Missing required environment variable ${name}. See .env.example.`); process.exit(1); } return v; }

const dbPath = resolve(env.DB_PATH ?? './data/pooltable.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Db(dbPath);
const masterKey = loadMasterKey(required('APP_MASTER_KEY'));
const pepper = required('PHONE_HASH_PEPPER');
const ctx = { db, masterKey, now: () => new Date() };
const applied = migrate(db, resolve(import.meta.dirname, '../../migrations'));
if (applied.length) console.log('Applied migrations:', applied.join(', '));

const { app, background } = buildApp({ ctx, pepper, http: {
  trustProxy: env.TRUST_PROXY === '1', corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  webRoot: resolve(import.meta.dirname, '../../web'), hsts: env.HSTS === '1', log: env.LOG_REQUESTS === '1' ? (l) => console.log(l) : undefined } });

// Recovery on boot: reconcile pending payments, re-issue commands, then dispatch any stored credits.
(async () => {
  await background();
  for (const t of db.all<{ id: string }>('SELECT id FROM pool_tables WHERE device_id IS NOT NULL')) dispatch(ctx, t.id, 'boot');
})().catch((e) => console.error('boot recovery failed', e));

const timers = [setInterval(() => background().catch((e) => console.error('background', e)), 15_000), setInterval(() => { try { enforceRetention(ctx); pruneRateEvents(ctx); } catch (e) { console.error(e); } }, 3_600_000)];
const port = Number(env.PORT ?? 8080);
app.listen(port, env.HOST ?? '0.0.0.0').then((p) => console.log(`Pool table server listening on :${p}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { timers.forEach(clearInterval); await app.close(); db.close(); process.exit(0); });
