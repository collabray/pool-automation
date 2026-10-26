import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../core/db.ts';
import { verifyAuditChain } from '../core/audit.ts';
import { verifyLedger } from '../core/ledger.ts';

const MAGIC = Buffer.from('PTBK1');
export class BackupError extends Error {}

export function loadBackupKey(b64: string | undefined): Buffer {
  if (!b64) throw new BackupError('BACKUP_KEY is not set');
  const k = Buffer.from(b64, 'base64'); if (k.length !== 32) throw new BackupError('BACKUP_KEY must be 32 bytes, base64-encoded'); return k;
}
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/** Consistent online snapshot (VACUUM INTO) -> AES-256-GCM encrypted file. Safe while the server is running. */
export function backupDatabase(db: Db, destDir: string, key: Buffer, now = new Date(), keepDays = 14): { path: string; bytes: number; sha256: string; pruned: number } {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const tmp = join(tmpdir(), `pt-snap-${randomBytes(6).toString('hex')}.db`);
  if (/['"\\]/.test(tmp)) throw new BackupError('unsafe temporary path');
  try {
    db.raw.exec(`VACUUM INTO '${tmp}'`);
    const plain = readFileSync(tmp); const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(MAGIC);
    const ct = Buffer.concat([c.update(plain), c.final()]); const out = Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
    const path = join(destDir, `pooltable-${stamp(now)}.db.enc`); writeFileSync(path, out, { mode: 0o600 }); chmodSync(path, 0o600);
    return { path, bytes: out.length, sha256: createHash('sha256').update(out).digest('hex'), pruned: prune(destDir, keepDays, now) };
  } finally { rmSync(tmp, { force: true }); }
}
function prune(dir: string, keepDays: number, now: Date): number {
  let n = 0;
  for (const f of readdirSync(dir)) { if (!/^pooltable-\d{8}-\d{6}\.db\.enc$/.test(f)) continue; if (now.getTime() - statSync(join(dir, f)).mtimeMs > keepDays * 86_400_000) { rmSync(join(dir, f)); n++; } }
  return n;
}
export function decryptBackup(encPath: string, key: Buffer): Buffer {
  const b = readFileSync(encPath);
  if (b.length < MAGIC.length + 28 || !b.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError('not a Pool Table backup file');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(5, 17)); d.setAAD(MAGIC); d.setAuthTag(b.subarray(17, 33));
  try { return Buffer.concat([d.update(b.subarray(33)), d.final()]); } catch { throw new BackupError('backup is corrupted, tampered with, or the BACKUP_KEY is wrong'); }
}
export interface Verification { integrity: string; ledgerImbalances: number; auditChainOk: boolean; auditEntries: number; payments: number; tables: number }
/** Opens the decrypted copy and checks it end to end (SQLite integrity, double-entry balance, audit hash chain). */
export function verifyDatabaseFile(path: string): Verification {
  const db = new Db(path);
  try {
    const integrity = (db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check) ?? 'unknown'; const a = verifyAuditChain(db);
    return { integrity, ledgerImbalances: verifyLedger(db).length, auditChainOk: a.ok, auditEntries: a.ok ? a.count : -1, payments: db.get<{ n: number }>('SELECT COUNT(*) n FROM payments')!.n, tables: db.get<{ n: number }>('SELECT COUNT(*) n FROM pool_tables')!.n };
  } finally { db.close(); }
}
export function verifyBackup(encPath: string, key: Buffer): Verification {
  const tmp = join(tmpdir(), `pt-verify-${randomBytes(6).toString('hex')}.db`);
  try { writeFileSync(tmp, decryptBackup(encPath, key), { mode: 0o600 }); return verifyDatabaseFile(tmp); } finally { for (const s of ['', '-wal', '-shm']) rmSync(tmp + s, { force: true }); }
}
/** Restores into destPath. Refuses to overwrite unless force; verifies BEFORE moving the result into place. */
export function restoreBackup(encPath: string, key: Buffer, destPath: string, force = false): Verification {
  if (existsSync(destPath) && !force) throw new BackupError(`${destPath} already exists; stop the server, move it aside, or pass --force`);
  const staging = destPath + '.restoring'; rmSync(staging, { force: true });
  writeFileSync(staging, decryptBackup(encPath, key), { mode: 0o600 });
  const v = verifyDatabaseFile(staging);
  if (v.integrity !== 'ok' || v.ledgerImbalances > 0 || !v.auditChainOk) { for (const s of ['', '-wal', '-shm']) rmSync(staging + s, { force: true }); throw new BackupError(`backup failed verification: ${JSON.stringify(v)}`); }
  for (const s of ['-wal', '-shm']) rmSync(destPath + s, { force: true });
  rmSync(destPath, { force: true }); writeFileSync(destPath, readFileSync(staging), { mode: 0o600 }); for (const s of ['', '-wal', '-shm']) rmSync(staging + s, { force: true });
  return v;
}
