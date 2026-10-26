// Usage: node scripts/restore.ts <backup.db.enc> [--force]     (stop the server first!)
import { resolve } from 'node:path';
import { loadBackupKey, restoreBackup } from '../src/ops/backup.ts';
const file = process.argv[2]; if (!file) { console.error('usage: node scripts/restore.ts <backup.db.enc> [--force]'); process.exit(1); }
const dest = resolve(process.env.DB_PATH ?? './data/pooltable.db');
const v = restoreBackup(resolve(file), loadBackupKey(process.env.BACKUP_KEY), dest, process.argv.includes('--force'));
console.log(`Restored to ${dest}\nVerified: ${JSON.stringify(v)}\nStart the server again. Remember: APP_MASTER_KEY must be the same one that was used when the data was written.`);
