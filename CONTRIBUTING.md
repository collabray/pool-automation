# Contributing

Thank you for helping. The bar is high because this system handles other people's money.

## Ground rules
1. **No change that touches money, credits, vending, auth or the device protocol without a test** that fails before and passes after. Concurrency-sensitive changes need a multi-connection test like those in `tests/concurrency.test.ts`.
2. Keep the project **dependency-free at runtime**. Dev tools (TypeScript, @types/node) are fine.
3. Money is integer cents everywhere. Never floats.
4. Never edit an applied migration; add `migrations/00N_name.sql`.
5. Every mutating endpoint must be schema-validated (unknown fields rejected), role-checked, and idempotent where a retry could double-act.
6. Don't add secrets to the repository or logs. Secrets go in environment variables or are encrypted in the database.
7. Browser code: build the DOM with `h()`/text nodes only; no inline script/style (the CSP test will fail).
8. Firmware decisions go in `firmware/lib/pooltable_core` with a native test; `main.cpp` stays thin. If you change the protocol, regenerate vectors: `node --disable-warning=ExperimentalWarning firmware/tools/gen-vectors.ts > firmware/test/test_native/vectors.h`.
9. Be honest in docs: if you did not test something on hardware or live credentials, say so in `docs/VERIFICATION.md`.

## Running things
Node.js 22.18+. `npm test` (server + web), `npm run test:firmware` (needs g++), `npm run load`, `npm run typecheck` (after `npm install`). Python with `opencv-python-headless` makes the QR decode test run.

## Pull requests
Small, focused, with a description of the risk. CI must be green (server, firmware, docker, android jobs).

## Reporting security problems
Please do **not** open a public issue for a vulnerability. Email the maintainers privately with steps to reproduce.
