// Usage: node scripts/gen-env.ts [--domain pool.example.com] [--email you@example.com]   creates .env with fresh random secrets (never overwrites)
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) { console.log('.env already exists: not touching it.'); process.exit(0); }
const a = process.argv; const get = (f: string) => { const i = a.indexOf(f); return i > 0 ? a[i + 1] : ''; }; const b64 = () => randomBytes(32).toString('base64');
writeFileSync('.env', `# Generated ${new Date().toISOString()}. BACK UP THIS FILE SEPARATELY from the database: without these keys the encrypted secrets are unrecoverable.
DB_PATH=./data/pooltable.db
APP_MASTER_KEY=${b64()}
PHONE_HASH_PEPPER=${b64()}
BACKUP_KEY=${b64()}
BACKUP_DIR=./backups
BACKUP_KEEP_DAYS=14
PORT=8080
HOST=127.0.0.1
TRUST_PROXY=0
HSTS=0
CORS_ORIGINS=
LOG_REQUESTS=0
DOMAIN=${get('--domain') || 'localhost'}
ACME_EMAIL=${get('--email')}
`, { mode: 0o600 });
console.log('Created .env (permissions 600). Open it to review, and store a copy of it somewhere safe and offline.');
