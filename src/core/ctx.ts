import type { Db } from './db.ts';

/** Everything a service function needs. `now` is injectable so time-dependent logic is testable. */
export interface Ctx {
  db: Db;
  now: () => Date;
  masterKey: Buffer;
}
