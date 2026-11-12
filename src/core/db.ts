import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type Param = string | number | null | Uint8Array;

/**
 * Thin synchronous wrapper over node:sqlite.
 * tx() uses BEGIN IMMEDIATE, so every write transaction takes the database write lock up front;
 * concurrent writers (other connections/threads/processes) queue on busy_timeout. This gives the
 * same serialisation guarantee as SELECT ... FOR UPDATE on PostgreSQL.
 */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;
  private cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA busy_timeout=60000;');
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  }

  get inTx(): boolean { return this.depth > 0; }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  get<T = Record<string, unknown>>(sql: string, ...p: Param[]): T | undefined {
    return this.stmt(sql).get(...p) as T | undefined;
  }
  all<T = Record<string, unknown>>(sql: string, ...p: Param[]): T[] {
    return this.stmt(sql).all(...p) as T[];
  }
  run(sql: string, ...p: Param[]): { changes: number } {
    const r = this.stmt(sql).run(...p);
    return { changes: Number(r.changes) };
  }

  /** Runs fn atomically. Nested calls join the outer transaction (an error anywhere rolls back everything). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.raw.exec('ROLLBACK'); } catch { /* connection already rolled back */ }
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  close(): void { this.raw.close(); }
}
