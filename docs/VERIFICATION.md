# Final audit: what is verified, what is not, and what you must check on site

This is the honest status of the project at release candidate `1.0.0-rc1`. It was produced by re-reading the code and test results, not from memory of intentions.

## A. Verified by automated tests that were actually run
(Recorded in `FINAL-TEST-OUTPUT.txt`, `PHASE4-FIRMWARE-NATIVE-TEST-OUTPUT.txt`, `LOAD-TEST-OUTPUT.txt`.)

* **Pricing & money**: KES 20/40/100/custom, bundles, peak/off-peak with midnight wrap, remainder policies, integer-only money, phone normalisation (all formats and invalid inputs).
* **Ledger**: balanced transactions, immutability triggers, negative-balance guards, audit hash chain (tamper and deletion detected).
* **Exactly-once crediting**: 100 parallel duplicate callbacks (separate threads, separate DB connections) credit KES 100 as exactly 5 games once; parallel duplicate cash sales; parallel voucher redemption; 50 parallel vend requests create exactly the number of vends that were paid for.
* **Daraja flows against a local fake of the documented API**: success, cancel, wrong PIN, insufficient funds, timeout, late callback, lost callback with STK-Query recovery, duplicate callback, wrong amount, wrong phone, unknown CheckoutRequestID, forged callback, token caching/refresh, ambiguous failures.
* **Shared till**: a drink payment does not vend; C2B on a Till never vends; wrong/missing/forged account codes never vend; manual assignment is role-limited, reasoned, idempotent and audit-logged; reports separate other-business receipts.
* **Vend engine**: queue order, one-at-a-time vs all-at-once, ready-sensor gating, offline store-and-forward, power-loss reconnect without a double release, timeouts/retries/failure, refund/keep/retry, late ack after failure, all 49 state pairs.
* **Cash/shift**: shift required, remainder policies, discounts and voids with single-use manager approval, receipts without gaps, blind close variance, closed-shift immutability, offline-queue settings.
* **Security**: auth (JWT forgery, alg=none, expiry), RBAC matrix, IDOR, mass assignment, lockout/rate limits, refresh-token reuse detection, forged callbacks, SQLi probes, headers/CORS/CSP scan of every page, path traversal, device signature/replay/stale-time/rotation, secrets never returned, privacy export/erase.
* **End to end with the device simulator**: customer → STK → callback → credit → signed vend → ack → "balls released" screen; attendant cash → vend → shift close with correct variance; lost-ack + reboot; sensor fault; coin events; tamper; OTA distribution; physical-button request.
* **Firmware portable core** (g++, AddressSanitizer + UBSan): SHA-256/HMAC (NIST/RFC vectors), JSON parser, **signature compatibility with the TypeScript server byte for byte**, command verification outcomes, sequencer timing/rollover/guards, coin debounce, reboot persistence.
* **Web apps**: the real page scripts were run against the real server with a fake DOM (customer, POS, owner, admin wizard, QR sheet) plus a CSP/DOM-sink scan.
* **Backups**: encrypted, verified, restore refuses corrupted data.
* **Load**: 50 simulated controllers + 30 concurrent payments (60 callbacks incl. duplicates): all invariants held; p95 latencies in the low hundreds of ms on the build machine.
* **QR generator**: output decoded by OpenCV for every symbol size 1-10 (this caught and fixed a real bug).

## B. NOT verified: needs on-site verification with real hardware/credentials
| Item | Why it could not be tested here | What to do |
|---|---|---|
| **The firmware for the actual ESP32** (`firmware/src/main.cpp`): WiFi, TLS, NVS encryption, captive portal, interrupts, FreeRTOS tasks, OTA, OLED | No PlatformIO/Xtensa toolchain or board. The *portable core* is tested; the Arduino glue was never compiled. | Build, flash, and run the bench test (TABLE-INSTALLATION §6-9). Expect to fix small compile issues on first build. |
| **Wiring and electrical behaviour**: opto/relay switching, flyback, voltage levels, the output staying off at boot, brownout behaviour | No hardware. | Bench test with a dummy load, then the commissioning checklist. Use an electrician for anything mains. |
| **Your table's mechanism accepting the emulated pulses / solenoid timing** | Depends on the specific table. | Tune pulses/width/gap/hold (§7); 20 consecutive releases. |
| **Live Safaricom Daraja** (sandbox and production): exact payload shapes, masked phone numbers in callbacks, error codes, IP whitelisting, STK Query semantics | No access to Safaricom. | Sandbox first, then a real KES 20 payment; compare with the statement. |
| **Real HTTPS deployment**: Docker image build, Caddy certificates, Cloudflare Tunnel, systemd units, `install.sh` | No Docker, no network, no root in the build environment. Files are written carefully but unrun. | Follow SETUP.md; report/fix issues on first deployment. |
| **Real browsers and phones** | No browser available; page logic was tested with a fake DOM (no layout, no real events). | Open every page on a phone: customer (scan the QR), POS, owner, admin; check dark mode and small screens; try the PWA install. |
| **Android app** | No Android SDK. Source only. | Build per `android/README.md` or use the PWA. |
| **TypeScript type-check** (`npm run typecheck`) | `@types/node` could not be installed offline. The code runs under Node's type-stripping and all tests pass, but a full static type check has never been run. | Run `npm install && npm run typecheck`; fix what it reports. CI does this. |
| **PostgreSQL** | Not implemented (see below). | n/a unless you need it. |
| **OTA rollback** and **flash encryption/secure boot** | Hardware/bootloader features. | Verify on your board build before relying on them (SECURITY.md). |
| **Wokwi simulation** (`firmware/diagram.json`) | Not run. | Optional starting point. |
| **SMS (Africa's Talking), Telegram, email, webhook** | Tested against local fake servers only. | Press "Send test alert" with real credentials. |

## C. Known limitations and deliberate deviations from the brief
1. **Database**: SQLite (WAL, `synchronous=FULL`), not PostgreSQL. The brief allows SQLite for single-machine mode; PostgreSQL support is **not implemented** (no driver, no port of the triggers). SQLite comfortably handles dozens of tables on one machine (see the load test), but it means one server process and no horizontal scaling.
2. **No ORM, no Fastify/NestJS, no React/SvelteKit**: plain Node `http` and hand-written SQL/JS so the project has **zero runtime dependencies** (a deliberate security and build-reliability choice, and the sandbox had no network). Trade-off: more hand-written code to maintain.
3. **Device transport is HTTPS long-polling with per-request HMAC signatures**, not MQTT or WebSocket. It needs a single public HTTPS port, works through any NAT, and wakes in milliseconds, but it is not MQTT; "rotating tokens" are replaced by per-request signatures with nonces and the ability to rotate the device secret.
4. **argon2id** → scrypt (see SECURITY.md).
5. **Multi-business isolation: not implemented** (single business, as the brief's default).
6. **Daraja dynamic QR API and C2B URL-registration API are not called**; the signed-table-code Paybill method and manual URL registration are provided instead.
7. **POS offline queue**: server-side support and settings exist, but the POS page does not queue sales offline.
8. **Customer choosing retry/refund/keep after a failed release**: only staff can resolve; customers are told to see the attendant.
9. **Custom date ranges** exist in the API (`period=custom`) but the POS/Admin screens offer today/yesterday/week/month only.
10. **Per-table vend-rate limiting** is an *alert* (unusual vend rate), not a hard block; credits are the hard limit.
11. **Refund value of a failed bundle game** is conservative (`floor(min(unit price, bundle price ÷ games))`), so an owner refund can be slightly below what a bundle buyer paid per game.
12. **PDF export** is a plain text-table PDF, not a designed report; CSV is the complete export.
13. **OLED display** support is compiled only in the `esp32dev_oled` build and is untested.
14. **Phone-number masking by Safaricom**: if the callback phone is missing or not numeric, the system falls back to confirming with STK Query. Behaviour under Safaricom's real masking is unverified.
15. **The first-run wizard** runs in the admin page; there is no separate command-line installer.
16. Security items an auditor may flag: JWT secret is derived from `APP_MASTER_KEY` (one secret to protect); access tokens live in `sessionStorage`/`localStorage` (standard SPA trade-off, mitigated by CSP and no HTML parsing); no built-in WAF.

## D. Recommended order to go live
1. Run the server on a laptop (`sh deploy/laptop/run-local.sh`), create a table, use the **device simulator** logic via the dashboard to understand the flow.
2. Deploy to a VPS; Daraja **sandbox**; make test payments.
3. Build and flash one controller; bench-test with a dummy load; install on one table; run the commissioning checklist.
4. Switch Daraja to production with a **KES 20** live test; keep an eye on the dashboard for a week with one table before adding more.
5. Rehearse a backup restore before you need it.
