# Data model (Phase 1)

| Table | Purpose | Key constraints |
|---|---|---|
| `pool_tables` | Table config: pricing JSON (price, bundles, peak windows, min/max games, remainder policy), vend mode + timings, release mode ONE/ALL, sensor flags, device id + encrypted device secret, status ACTIVE/DISABLED/FAULTED, online/ready | CHECKs on enums and ranges |
| `payments` | One row per confirmed payment that produced credits | `UNIQUE(ref_namespace, external_ref)`, `UNIQUE(idempotency_key)` |
| `ledger_entries` | Immutable double-entry lines (KES and GAME units) | UPDATE/DELETE blocked by trigger; amount ≠ 0 |
| `vends` | One row per released game; state machine QUEUED→SENT→ACKED→CONFIRMED / FAILED / CANCELLED / REFUNDED | `UNIQUE(table_id, seq)` |
| `vend_commands` | Every nonce issued per vend (to honour late acks) | PK (vend_id, nonce) |
| `vend_events` | Append-only transition history | triggers block changes |
| `idempotency_keys` | Stored responses for replay | PK (scope, key) |
| `audit_log` | Hash-chained audit trail | contiguous `seq`, unique `hash`, triggers |
| `alerts` | Owner alerts (e.g. VEND_FAILED) | |
| `settings` | Key/value settings | |

Accounts: `asset:mpesa|cash|voucher`, `revenue:pool:<table>`, `liability:credit:<table>:<owner>` (held remainders), `liability:refund_due`, `games:issued`, `games:table:<t>`, `games:inflight:<t>`, `games:vended:<t>`, `games:refunded:<t>`.

Added in later migrations:

| Table | Purpose |
|---|---|
| `users`, `refresh_tokens`, `approval_tokens` | staff accounts (scrypt hashes, TOTP secret encrypted), rotating sessions, single-use manager approvals |
| `mpesa_requests`, `mpesa_callbacks`, `mpesa_receipts` | every STK push we made, raw callbacks (for forensics), global receipt registry |
| `unallocated_payments` | money received that matched no request (never vends until assigned) |
| `vouchers` | hashed single-use codes |
| `shifts`, `shift_adjustments`, `cash_sales`, `receipt_counters` | cash POS: shifts (closed = immutable), sales, gap-detectable receipt numbers |
| `device_nonces`, `device_events`, `vend_commands` | device replay protection, event de-duplication, every command/nonce issued |
| `coin_events`, `coin_collections`, `manual_vends` | physical coin counting and reconciliation, manual releases |
| `firmware_releases` | signed OTA images |
| `rate_events`, `alerts`, `error_log`, `settings` | rate limits, owner alerts, server errors, configuration |

Money is integer cents; timestamps are ISO-8601 UTC text. See `migrations/*.sql` for exact definitions and constraints.
