# API guide

The complete, always-current reference is **[openapi.json](openapi.json)** (OpenAPI 3.0), generated from the live route table and request schemas by `node scripts/gen-openapi.ts > docs/openapi.json`. View it with any OpenAPI viewer (e.g. Swagger Editor).

## Conventions
* JSON in, JSON out. Errors: `{ "error": { "code", "message", "details?" } }` with a sensible HTTP status (400 validation, 401 not signed in, 403 role not allowed, 404, 409 conflict, 422 idempotency key reused with a different body, 429 rate limited).
* **Money is always an integer in cents** (KES 20 = `2000`). Times are ISO-8601 UTC.
* **Authentication**: `POST /api/auth/login` (password) or `/api/auth/pin-login` (attendants) → `accessToken` (15 min) + `refreshToken` (rotates on every use). Send `Authorization: Bearer <accessToken>`. Roles: `owner`, `manager`, `attendant`; customers need no account; devices sign requests.
* **Idempotency**: mutating staff endpoints require/accept an `Idempotency-Key` header (any unique string up to 200 chars). Repeat the same request with the same key and you get the original response (header `Idempotent-Replay: true`) instead of a second action. Reusing a key with a different body is an error.
* Unknown JSON fields are rejected.

## Example: cash sale
```
curl -X POST https://pool.example.com/api/cash/sale \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"tableId":"<table id>","cashReceivedMinor":10000}'
→ 201 {"saleId":"…","receiptNo":"C-000123","games":5,"changeMinor":0,"heldMinor":0,"duplicate":false}
```

## Example: customer payment (no login; the table code comes from the QR)
```
GET  /api/public/table/K7M2QX-4HTW                      → name, state, prices, bundles, limits
POST /api/public/pay {"code":"K7M2QX-4HTW","games":5,"phone":"0712345678","idempotencyKey":"<uuid>"}
GET  /api/public/pay/<requestId>                        → status (PENDING/SUCCESS/CANCELLED/WRONG_PIN/INSUFFICIENT_FUNDS/TIMEOUT/FAILED/EXPIRED)
GET  /api/public/pay/<requestId>/events                 → Server-Sent Events stream of the same status
```

## Device protocol (for firmware authors)
`POST /api/device/sync` with headers `X-Device-Id`, `X-Ts` (ms), `X-Nonce` (32 hex), `X-Sig` and JSON `{fw, uptimeS, rssi, freeHeap, resetReason, sensors:{ready,tamper}, wait, acks:[{vendId,nonce,status,ts,signature}], events:[{id,kind,data}]}`. The response is `{commands:[{command, signature}], ackResults, config}` with headers `X-Resp-Sig`, `X-Server-Time`. Exact string formats for the signatures are in `src/core/command.ts` and `src/core/devices.ts`; the C++ implementation is `firmware/lib/pooltable_core/protocol.cpp`; test vectors are generated into `firmware/test/test_native/vectors.h`. OTA download: `GET /api/device/ota/<version>` (device-signed).

## Safaricom callbacks
`POST /api/mpesa/stk-callback/<secret token>`, `POST /api/mpesa/c2b/confirmation/<token>`, `POST /api/mpesa/c2b/validation/<token>`: always answer `{"ResultCode":0,"ResultDesc":"Accepted"}` for authentic origins and `403` otherwise. The exact URLs are shown in Admin → Payments.
