# Design decisions

Chosen for security and robustness first. Each entry: decision, why, trade-off.

1. **Money = integer minor units (1 KES = 100).** No floats anywhere. M-Pesa only takes whole shillings, so `toMpesaShillings` rejects fractional amounts at the Daraja boundary.
2. **Ledger is append-only and double-entry.** Every transaction nets to zero per unit (`KES`, `GAME`). Balances are `SUM(amount)`; there is no balance column to edit. Triggers block UPDATE/DELETE. Guard rules (`games:table:*`, `games:inflight:*` never negative; wallet liabilities never positive) run inside the posting transaction, so a double-spend bug rolls back instead of committing.
3. **Game credits are fungible per table.** Flow: `games:issued` → `games:table:T` (available) → `games:inflight:T` → `games:vended:T` | back to available (cancel) | `games:refunded:T`. A vend row is only created by consuming one available credit, so vends can never exceed credits purchased.
4. **Exactly-once crediting uses three layers:** (a) `UNIQUE(ref_namespace, external_ref)` (one M-Pesa receipt, one cash receipt or one voucher can never credit twice; STK and C2B share the `MPESA` namespace), (b) `UNIQUE(idempotency_key)`, (c) everything runs in one `BEGIN IMMEDIATE` transaction.
5. **Concurrency model.** `Db.tx` takes the write lock up front (`BEGIN IMMEDIATE`). On PostgreSQL the equivalent is `SELECT ... FOR UPDATE` on the table row plus `SERIALIZABLE`/advisory locks; see "Open item: PostgreSQL" below.
6. **Pricing with bundles uses a min-cost DP.** Price of N games = cheapest mix of singles and bundles. Amount → games = the most games whose min cost fits the amount. KES 100 is 5 games without bundles and 6 with a "6 for 100" bundle. Peak windows set the single-game price (Nairobi UTC+3, wrap past midnight supported); bundles still compete via the DP.
7. **Refund value of a failed vend is conservative:** `floor(min(unit price, bundle price / games))`, so a refund can never exceed what the customer could have paid.
8. **Signed commands.** HMAC-SHA256 over a fixed, pipe-delimited field order (easy to reproduce in C++), per-device secret stored AES-256-GCM encrypted under `APP_MASTER_KEY`. Fields: vend ID, table, device, mode, pulses, pulse/gap/hold ms, nonce, issued/expiry (server epoch ms). Device checks signature → expiry (±5 s drift) → nonce replay, and records the nonce only after all checks pass.
9. **Resends reuse the vend ID with a new nonce.** The device must de-duplicate by vend ID (re-ack without re-vending). This makes retries after a lost ack or power cut safe: one payment never yields a second release. A late ack for any previously issued nonce is honoured.
10. **Late ack after FAILED moves the vend to ACKED→CONFIRMED** (`FAILED→ACKED` is a legal transition). If the device actually vended, the customer must not be refunded.
11. **A FAILED vend faults the table** (customers are blocked before paying, no further games released) until an attendant chooses RETRY, REFUND or KEEP_CREDIT, with a mandatory reason. Offline devices do not burn retry attempts.
12. **Audit log is hash-chained** (SHA-256 over seq, ts, actor, action, entity, canonical JSON data, prev hash) with contiguous sequence numbers; `verifyAuditChain` detects edits and deletions even if triggers are dropped by someone with file access. Entries are written in the same transaction as the change they describe.
13. **Phone numbers:** normalised to `254XXXXXXXXX`; lookups use a keyed HMAC (`PHONE_HASH_PEPPER`). Encryption of the raw number for display/refunds is added with the API layer (Phase 2/3).
14. **No timer anywhere.** The table ends each game itself; the "ready" sensor (optional) only gates when the next *paid* credit is released.
15. **TypeScript runs natively on Node ≥ 22.18** (type stripping), tests use `node:test`, DB uses built-in `node:sqlite`. Zero runtime dependencies in Phase 1 keeps the attack surface and supply-chain risk minimal. Syntax is restricted to erasable TypeScript (`erasableSyntaxOnly`). Fastify/React are added in later phases.

## Added during Phases 2-7
16. **Receipts are namespaced** (`MPESA`, `CASH`, `VOUCHER`) in a UNIQUE index; a separate `mpesa_receipts` registry catches the same M-Pesa receipt arriving through STK *and* C2B.
17. **Unallocated money is booked immediately** (`asset:mpesa` / `liability:unallocated`), so the books always match the till; assigning it later reclassifies it instead of double-counting. Reports show it separately from pool revenue.
18. **STK Query confirms *success* only without a receipt**: when only the query proves payment, credit uses a synthetic reference (`STKQ-<id>`) flagged `credited_without_receipt`; a later real callback just attaches the real receipt.
19. **The Daraja push is sent outside the database lock** (record request first, push, then update), so a slow Safaricom never blocks other payments; idempotency makes retries safe. A crash between record and push leaves an `INITIATING` row that the reconciler fails after a minute.
20. **Device protocol = signed HTTPS long-poll** (no MQTT/WebSocket, no dependencies, one public port, instant wake via an in-process event hub). Every request is HMAC-signed with a timestamp and nonce; responses are signed too; commands carry their own signature, nonce and expiry; expiry is judged against **server time**.
21. **At-most-once release** on the device: the vend ID is persisted before the output moves.
22. **Manager approvals are tokens, not ids**: an approval requires the manager's real credentials, is single-use, 5-minute, bound to the requesting user, and cannot be self-granted. (An earlier draft accepted a manager id from the client; the audit found and removed that hole.)
23. **No cookies**: bearer tokens only, which removes CSRF as a class; strict CSP forbids inline script and style, so browser code never builds HTML strings (text nodes only), enforced by a test scanning every page.
24. **Backups verify themselves** (decrypt → integrity check → ledger balance → audit chain) and `restore` verifies *before* replacing anything.
25. **Firmware logic is split**: everything with a decision in it lives in `lib/pooltable_core` (portable, tested on a PC with sanitizers, cross-checked against server signatures); `main.cpp` only wires hardware.
26. **Physical test button = a request**, not a local release: the server enforces the enable flag, a 3-per-hour limit, and logs/alerts it.
27. **Without a ready sensor, one-at-a-time mode releases the next credit as soon as the previous release is confirmed** (there is no timer to wait for). Gate/slide tables should therefore use *all at once* or fit a ready sensor; the guide and the admin form say so.

## Open item: PostgreSQL
The spec's primary database is PostgreSQL. Phase 1 was built and tested on SQLite because the build sandbox had no Postgres, no Docker and no network. The SQL schema is deliberately portable (TEXT ids, INTEGER money, ISO timestamps) but triggers, `AUTOINCREMENT` and `BEGIN IMMEDIATE` need Postgres equivalents, and the concurrency tests must be re-run against a real Postgres instance. This is tracked as the first task of Phase 2/6 and listed in "Needs verification".
