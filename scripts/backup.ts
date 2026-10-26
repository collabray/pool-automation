// Usage: node scripts/backup.ts            one backup now
//        node scripts/backup.ts --daemon   backup now, then every day at 03:00 Nairobi time (used by docker compose)
//        node scripts/backup.ts --verify <file.enc>
import { resolve } from 'node:path';
import { Db } from '../src/core/db.ts';
import { backupDatabase, loadBackupKey, verifyBackup } from '../src/ops/backup.ts';

const env = process.env; const key = loadBackupKey(env.BACKUP_KEY); const dir = resolve(env.BACKUP_DIR ?? './backups'); const keep = Number(env.BACKUP_KEEP_DAYS ?? 14);
const arg = process.argv[2];
if (arg === '--verify') { console.log(JSON.stringify(verifyBackup(resolve(process.argv[3] ?? ''), key), null, 2)); process.exit(0); }
const run = () => { const db = new Db(resolve(env.DB_PATH ?? './data/pooltable.db')); try { const r = backupDatabase(db, dir, key, new Date(), keep); const v = verifyBackup(r.path, key); console.log(`[backup] ${r.path} ${r.bytes} bytes, pruned ${r.pruned}, verified: integrity=${v.integrity} ledgerImbalances=${v.ledgerImbalances} auditChainOk=${v.auditChainOk}`); if (v.integrity !== 'ok' || v.ledgerImbalances || !v.auditChainOk) process.exitCode = 2; } finally { db.close(); } };
run();
if (arg === '--daemon') {
  const msUntil3am = () => { const n = new Date(Date.now() + 3 * 3600_000); const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + (n.getUTCHours() >= 3 ? 1 : 0), 3) - 3 * 3600_000; return next - Date.now(); };
  const loop = () => setTimeout(() => { try { run(); } catch (e) { console.error('[backup] FAILED', e); } loop(); }, msUntil3am()); loop();
}
