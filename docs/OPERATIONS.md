# Operations: backups, restore, upgrades, monitoring

## Backups
* **What**: a consistent snapshot of the whole database (payments, ledger, audit log, settings) taken while the server runs, encrypted with AES-256-GCM using `BACKUP_KEY`, written to `./backups/pooltable-YYYYMMDD-HHMMSS.db.enc` (file mode 600). Old files beyond `BACKUP_KEEP_DAYS` (14) are removed.
* **When**: automatically every day at 03:00 Nairobi time (the `backup` service in Docker, or `pooltable-backup.service` on the Pi), and once at start-up. Manual: `docker compose exec backup node scripts/backup.ts` (or `npm run backup`).
* **Every backup is verified** right after it is written: it is decrypted, opened, checked with SQLite's integrity check, the double-entry ledger is re-balanced and the audit hash chain is re-computed. The command prints `integrity=ok ledgerImbalances=0 auditChainOk=true`; any other result exits with an error.
* **Copy them off the machine** (a backup on the same disk dies with the disk). For example nightly `rsync -a server:/path/pooltable/backups/ ~/pool-backups/` or any cloud sync tool; the files are already encrypted.
* The encrypted *secrets* inside a backup (Daraja credentials, device secrets) are encrypted with `APP_MASTER_KEY`. To restore you need **both** `BACKUP_KEY` and the original `APP_MASTER_KEY`. Keep both safe, offline.

## Restore (rehearse this once!)
1. Stop the server: `docker compose stop app backup` (Pi: `sudo systemctl stop pooltable pooltable-backup`).
2. Verify the file first: `node scripts/backup.ts --verify backups/pooltable-20261020-030000.db.enc`.
3. Restore: `node scripts/restore.ts backups/pooltable-20261020-030000.db.enc --force`. The script decrypts to a staging file, **verifies integrity, ledger balance and audit chain, and only then** replaces the live database. A backup that fails verification is never put in place. (With Docker, run it with the data volume mounted: `docker compose run --rm --no-deps app node scripts/restore.ts /backups/<file> --force`.)
4. Start the server, open the dashboard, check *System → Verify integrity*, the table board and the latest payments.
5. Anything paid after the backup time is not in the restored data. Compare with your M-Pesa statement (PAYMENTS.md "Manual reconciliation") and your last shift reports.

**Disaster on a brand new machine**: install per SETUP.md, copy your saved `.env` (same `APP_MASTER_KEY`), copy a backup file in, run the restore command, start. Controllers reconnect on their own as soon as the domain points at the new server (they identify by device ID + secret, which are in the database).

## Upgrades
1. Take a manual backup and copy it away.
2. Update the code (`git pull`) and `docker compose up -d --build` (Pi: copy files, `sudo systemctl restart pooltable`).
3. Migrations in `migrations/` are applied automatically, in order, each in its own transaction; a checksum stops anyone silently editing an already-applied migration. Never edit an applied migration; add a new numbered file.
4. Check `/api/health`, then the dashboard. If something is wrong, stop, restore the pre-upgrade backup and the previous code.

**Firmware updates (over the air)**: build, then `sh firmware/tools/sign-firmware.sh .pio/build/esp32dev/firmware.bin ota_private.pem`, upload with `sh firmware/tools/upload-firmware.sh https://YOUR-DOMAIN 1.0.1 <bin>`, then *Admin → System → Firmware → Roll out*. Controllers see the new version on their next sync, download it, verify the SHA-256 and the **signature** against the public key built into them, install, restart, and only then keep it. Roll out to a quiet time; update one table first (the rollout applies to all, so test the image on the bench before uploading).

## Monitoring
* **Dashboard (30 s refresh)**: open alerts, offline tables, pending M-Pesa requests, unallocated payments, ledger balanced yes/no.
* **Alerts (SMS/Telegram/webhook/email)**: device offline; paid credits waiting on an offline table; vend failed; repeated vend failures; vend without payment; tamper; unusual vend rate; power cycling/brownouts; coin box mismatch; shift variance; STK anomalies (amount/phone mismatch, query disagreement); reversal after play. Set it up in *System → Alerts delivery* and press **Send test alert**.
* **External uptime check**: point a free monitor (e.g. UptimeRobot) at `https://YOUR-DOMAIN/api/health`.
* **Logs**: `docker compose logs -f app` (JSON files rotate at 10 MB x 5). Set `LOG_REQUESTS=1` temporarily while commissioning. Server errors are also stored (Admin → System → Error log) with a request ID the customer-visible error also shows.
* **Disk**: SQLite is small (a busy table is a few MB per year), but check `df -h` monthly; backups are the main consumer.
* **Audit integrity**: *System → Verify integrity* re-computes the hash chain. Run weekly; any "tampering detected" result means someone changed the database file outside the application.

## Routine data jobs
Hourly: phone-number retention (scrubs customers' numbers older than 90 days), rate-limit table cleanup. Every 15 s: device watchdog, stuck-vend sweep, payment reconciliation, alert delivery.
