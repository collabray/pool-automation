# Changelog

## 1.0.0-rc1
Release candidate: all seven phases. See docs/VERIFICATION.md for exactly what is and is not verified.

### Phase 7: documentation and audit
README, SETUP, installation/commissioning guide, architecture, security & threat model, payments, cash POS, operations, troubleshooting, API (OpenAPI generated from code), verification audit.
Audit fixes found while writing docs: table edit screen used to reset bundles/peak prices (now loads the full table config); manager approval required a real credential (was a client-supplied id); added payment list/reversal API + UI, owner password reset script, TOTP enrolment UI.

### Phase 6: deployment
Dockerfile (amd64/arm64), docker compose with Caddy automatic HTTPS, encrypted verified daily backups + verified restore, Raspberry Pi (systemd, Cloudflare Tunnel) and laptop modes, CI, load test (50 tables / 30 concurrent payments), `.env` generator.

### Phase 5: web apps
Customer pay page (EN/SW, kiosk), attendant POS, admin dashboard + first-run wizard, owner PWA (+ Android shell), printable QR sheet, strict-CSP static serving. Bug fixes found by running the pages: login forms lost the typed username; validation errors were opaque; admin forms were wiped on re-render.

### Phase 4: firmware
Portable tested core (protocol, SHA-256/HMAC, JSON, sequencer, coin counter, debouncer, device logic), ESP32 glue (provisioning portal, encrypted NVS, signed HTTPS sync, OTA with signature check, watchdog, OLED), Wokwi starter.

### Phase 3: API and devices
HTTP framework, auth (scrypt, rotating refresh tokens, TOTP, lockout), RBAC, device protocol and simulator, coin monitoring, alerts and notifications, OTA registry, privacy tools, reports and exports.

### Phase 2: payments and cash
Daraja client, STK flow, callback verification, reconciler, shared-till protection, unallocated payments, vouchers, shifts, cash sales, approvals, analytics.

### Phase 1: core
Ledger, pricing, credit queue, vend state machine, idempotency, hash-chained audit log, signed commands.
