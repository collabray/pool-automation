import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';

/** Applies migrations/*.sql in filename order, each in its own transaction. Checksums guard against edited history. */
export function migrate(db: Db, dir: string): string[] {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied: string[] = [];
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const row = db.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version=?', f);
    if (row) {
      if (row.checksum !== checksum) throw new Error(`Migration ${f} was modified after being applied`);
      continue;
    }
    db.raw.exec('BEGIN IMMEDIATE');
    try {
      // Re-check inside the lock: another process may have applied it meanwhile.
      if (!db.get('SELECT 1 FROM schema_migrations WHERE version=?', f)) {
        db.raw.exec(sql);
        db.run('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?,?,?)', f, checksum, new Date().toISOString());
        applied.push(f);
      }
      db.raw.exec('COMMIT');
    } catch (e) {
      db.raw.exec('ROLLBACK');
      throw e;
    }
  }
  return applied;
}
