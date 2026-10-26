import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { newCtx, makeTable, addUser } from './helpers/ctx.ts';
import { creditPurchase } from '../src/core/credit.ts';
import { openShift, cashSale } from '../src/core/cash.ts';
import { backupDatabase, restoreBackup, verifyBackup, decryptBackup, loadBackupKey, BackupError } from '../src/ops/backup.ts';
import { Db } from '../src/core/db.ts';
import { A, balance } from '../src/core/ledger.ts';
import { kes } from '../src/core/money.ts';

const key = randomBytes(32);
function seeded() { const ctx = newCtx(); const { tableId } = makeTable(ctx); const att = addUser(ctx, 'attendant'); openShift(ctx, att, kes(100)); for (let i = 0; i < 5; i++) cashSale(ctx, { attendantId: att, tableId, cashReceivedMinor: kes(20 * (i + 1)), idempotencyKey: 'k' + i }); creditPurchase(ctx, { source: 'MPESA_STK', idempotencyKey: 'm', externalRef: 'MRCPT0001', tableId, amountMinor: kes(40), actor: 't' }); return { ctx, tableId }; }

test('backup: encrypted at rest, restores to an identical, verified database; wrong key / tampering / junk are refused', () => {
  const { ctx, tableId } = seeded(); const dir = mkdtempSync(join(tmpdir(), 'bk-')); const b = backupDatabase(ctx.db, dir, key, ctx.now());
  const enc = readFileSync(b.path); assert.ok(!enc.includes(Buffer.from('SQLite format 3'))); assert.ok(!enc.includes(Buffer.from('MRCPT0001'))); assert.equal(statModeOk(b.path), true);
  const v = verifyBackup(b.path, key); assert.deepEqual([v.integrity, v.ledgerImbalances, v.auditChainOk, v.payments], ['ok', 0, true, 6]); assert.ok(v.auditEntries > 6);
  const dest = join(mkdtempSync(join(tmpdir(), 'rs-')), 'restored.db'); restoreBackup(b.path, key, dest);
  const r = new Db(dest); assert.equal(balance(r, A.gamesAvail(tableId)), balance(ctx.db, A.gamesAvail(tableId))); assert.equal(balance(r, A.cash), balance(ctx.db, A.cash)); assert.equal(balance(r, A.mpesa), kes(40)); r.close();
  assert.throws(() => restoreBackup(b.path, key, dest), /already exists/); restoreBackup(b.path, key, dest, true);
  assert.throws(() => decryptBackup(b.path, randomBytes(32)), BackupError);
  const bad = Buffer.from(enc); bad[bad.length - 5] ^= 1; const badPath = join(dir, 'bad.enc'); writeFileSync(badPath, bad); assert.throws(() => verifyBackup(badPath, key), /corrupted|tampered/);
  const junk = join(dir, 'junk.enc'); writeFileSync(junk, 'hello'); assert.throws(() => decryptBackup(junk, key), /not a Pool Table backup/);
  assert.throws(() => loadBackupKey(undefined), BackupError); assert.throws(() => loadBackupKey('c2hvcnQ='), /32 bytes/);
});
test('backup: a restore whose content fails verification is never put in place', () => {
  const { ctx } = seeded(); ctx.db.raw.exec('DROP TRIGGER ledger_no_update'); ctx.db.run('UPDATE ledger_entries SET amount=amount+1 WHERE id=1'); // simulate silent corruption in the live DB
  const dir = mkdtempSync(join(tmpdir(), 'bk-')); const b = backupDatabase(ctx.db, dir, key); const dest = join(mkdtempSync(join(tmpdir(), 'rs-')), 'r.db');
  assert.throws(() => restoreBackup(b.path, key, dest), /failed verification/); assert.equal(existsSync(dest), false);
});
test('backup: retention prunes old files only; backups are consistent while writes continue', () => {
  const { ctx, tableId } = seeded(); const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  const old = backupDatabase(ctx.db, dir, key, new Date('2026-01-01T00:00:00Z')); const past = new Date('2026-01-01T00:00:00Z'); utimesSync(old.path, past, past);
  writeFileSync(join(dir, 'notes.txt'), 'keep me'); const fresh = backupDatabase(ctx.db, dir, key, new Date('2026-10-20T00:00:00Z'), 14);
  assert.equal(fresh.pruned, 1); assert.ok(!existsSync(old.path)); assert.ok(existsSync(join(dir, 'notes.txt'))); assert.equal(readdirSync(dir).filter((f) => f.endsWith('.enc')).length, 1);
  creditPurchase(ctx, { source: 'CASH', idempotencyKey: 'late', externalRef: 'L1', tableId, amountMinor: kes(20), actor: 't' });
  const b2 = backupDatabase(ctx.db, dir, key, new Date('2026-10-21T00:00:00Z')); assert.equal(verifyBackup(b2.path, key).payments, 7); assert.equal(verifyBackup(fresh.path, key).payments, 6);
});
function statModeOk(p: string) { return (require_fs_mode(p) & 0o077) === 0; }
function require_fs_mode(p: string) { return (readFileSyncStat(p)); }
import { statSync } from 'node:fs';
function readFileSyncStat(p: string) { return statSync(p).mode; }
