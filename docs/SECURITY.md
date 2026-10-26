# Security and threat model

## Assets
(1) money integrity (no free games, no lost payments); (2) Daraja credentials and the till; (3) device secrets (they can vend); (4) staff accounts; (5) customer phone numbers (personal data, Kenya Data Protection Act 2019); (6) audit/ledger integrity.

## Threats and controls
| Threat | Control (and where it is tested) |
|---|---|
| Forged "payment succeeded" callback | Secret random path token (constant-time compare), optional Safaricom IP allowlist, payload shape validation, match to a stored pending request + amount + phone, unique receipt, STK Query confirmation in unusual cases. `tests/payments.test.ts`, `security.test.ts` |
| Replayed / duplicated callbacks and requests | Unique receipt; idempotency keys on every mutating endpoint; 100-way parallel duplicate test. `concurrency.test.ts` |
| Customer pays the shop's till for something else and gets games | Only pushes created by this system vend; C2B on a Till never vends; C2B Paybill vends only if the owner turned it on **and** the account is a valid *signed* table code; everything else → *unallocated*. `payments.test.ts` (shared-till tests) |
| Attendant steals cash / fakes sales | Shifts with float, sequential gap-detectable receipts, void/discount limits, manager approval with the manager's own credentials (single-use token bound to the requester), blind close, variance alerts, immutable closed shifts, hash-chained audit. `cash.test.ts`, `security.test.ts` |
| Attendant uses someone else's data (IDOR) | Server derives identity from the token; per-attendant queries; void only own sales. `security.test.ts` |
| Brute-force PIN/password | Per-user and per-IP rate limits, lockout after 5 failures (15 min), generic errors, PIN login limited to attendants, scrypt hashing. |
| Stolen session | 15-minute access tokens, rotating refresh tokens with reuse detection (reuse revokes the whole family), tokens die on deactivation or credential change, optional TOTP for owner/managers. |
| Tampered / forged vend command | HMAC signature per device, expiry, nonce replay memory in flash, vend-ID memory, hard parameter limits in firmware. `firmware tests`, `e2e.test.ts` |
| Rogue server / man in the middle | Controller pins your CA certificate (`certs/server_ca.pem`), verifies `X-Resp-Sig` on every response, only acts on authenticated responses. |
| Physical solenoid abuse / software fault holds output on | Output off at boot (hardware pull-down), independent 5 s on-time guard, separate high-priority task, hardware watchdog. Firmware tests; **hardware behaviour must be verified on site**. |
| Coin box theft / tampering | Coin pulse counting, collection reconciliation, tamper switch alert, "vend without payment" alert, unusual vend-rate alert. |
| SQL injection | Prepared statements everywhere (parameters only); injection tests. |
| XSS | Browser code never parses HTML (text nodes only); strict CSP (`script-src 'self'`, no inline script/style), enforced by a test that scans every page. JSON-only API. |
| CSRF | Authentication is a `Authorization: Bearer` header, not a cookie, so browsers never attach it automatically. Mutating calls also require `Content-Type: application/json` and pass an Origin/CORS check. |
| SSRF | The server only calls Daraja, Africa's Talking, Telegram, SMTP and the owner's webhook URL (https only), all configured by the owner; no user-supplied URLs are fetched. |
| Mass assignment | Every body is schema-validated and **unknown fields are rejected**. |
| Clickjacking, sniffing, referrer leaks | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS when HTTPS. |
| Path traversal on static files | Resolved path must stay inside `web/`. Tested. |
| Secrets at rest | Daraja credentials, device secrets and notification keys are AES-256-GCM encrypted with `APP_MASTER_KEY` (kept outside the database). Phone numbers are encrypted for refunds and HMAC-hashed for lookups. Backups are encrypted with a separate key. |
| Data protection | Export and erase a customer's identifiers (`/api/privacy/*`), automatic phone-number scrubbing after `retention.phone_days` (default 90), de-identified financial records are kept for accounting. |
| DoS / abuse | Body-size limits, per-IP/route/phone/table rate limits stored in the database, request timeouts; devices are limited per device. A volumetric attack needs upstream protection (Cloudflare). |

## Deliberate deviations and honest limits
* Passwords/PINs use **scrypt** (N=32768), not argon2id, because the Node 22 runtime has no argon2 and the project has zero dependencies. scrypt is memory-hard and acceptable; swap in argon2id if you add dependencies.
* The firmware encrypts WiFi password and device secret in NVS with a key derived from the chip's MAC and a random salt held in the same flash. **That stops casual reading, not an attacker who dumps the flash.** For real protection enable ESP32 **flash encryption and secure boot** (ESP-IDF docs) in production; this is not enabled by default and not verified by the author.
* OTA images are verified with ECDSA P-256 against a public key compiled into the firmware. Automatic **rollback** requires a bootloader built with rollback support; the stock Arduino bootloader may not have it. The code marks images valid after the first authenticated sync and requests rollback if it never happens; verify on your build.
* Static analysis / dependency audit: the server has no runtime dependencies; CI runs `npm audit` for the dev tooling.
* A compromised server or `APP_MASTER_KEY` compromises everything stored; protect the server and the key accordingly (disk encryption, SSH keys, firewall, updates).

## Hardening checklist for production
SSH keys only, no password login; firewall allows only 22/80/443; automatic security updates; `.env` mode 600 and backed up offline; TOTP on for owner and managers; Cloudflare in front if attacked; different `APP_MASTER_KEY` and `BACKUP_KEY`; keep `ota_private.pem` offline; review the audit log and alerts weekly.
