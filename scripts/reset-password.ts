// Emergency access: sets a new password (or PIN) for a user, unlocks the account and signs them out everywhere. Needs the server's .env (same APP_MASTER_KEY).
// Usage (stop nothing; it is safe while running):  node scripts/reset-password.ts <username> <new-password-or-pin> [--pin]
import { resolve } from 'node:path';
import { Db } from '../src/core/db.ts';
import { loadMasterKey } from '../src/core/crypto.ts';
import { setCredentials } from '../src/core/auth.ts';
import { appendAudit } from '../src/core/audit.ts';

const [username, secret] = process.argv.slice(2); const isPin = process.argv.includes('--pin');
if (!username || !secret) { console.error('usage: node scripts/reset-password.ts <username> <new-password-or-pin> [--pin]'); process.exit(1); }
const ctx = { db: new Db(resolve(process.env.DB_PATH ?? './data/pooltable.db')), masterKey: loadMasterKey(process.env.APP_MASTER_KEY), now: () => new Date() };
const u = ctx.db.get<{ id: string }>('SELECT id FROM users WHERE username=?', username.toLowerCase());
if (!u) { console.error('No such user'); process.exit(1); }
ctx.db.tx(() => { setCredentials(ctx, u.id, isPin ? { pin: secret } : { password: secret }, 'cli-reset'); ctx.db.run('UPDATE users SET failed_attempts=0, locked_until=NULL, active=1 WHERE id=?', u.id); appendAudit(ctx.db, ctx.now(), { actor: 'cli', action: 'user.cli_reset', entityType: 'user', entityId: u.id }); });
console.log(`Credentials for "${username}" were reset and all their sessions ended. The change is recorded in the audit log.`);
