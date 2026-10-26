# Payments (Safaricom Daraja) and manual reconciliation

## What the system uses
* **STK Push (Lipa na M-Pesa Online)**: the normal path. The server sets the exact amount and the customer enters their PIN. Transaction type is configurable: *Paybill* (`CustomerPayBillOnline`) or *Till* (`CustomerBuyGoodsOnline`). For a Till, `BusinessShortCode` is the head-office/store number from Safaricom and `PartyB` is the Till number.
* **STK Query**: confirms uncertain results and recovers lost callbacks.
* **C2B (optional)**: a customer pays your Paybill by hand using a *signed table code* as the account number. Off by default.
* OAuth tokens are cached and refreshed automatically; the password is `base64(shortcode + passkey + timestamp)` with the timestamp in East Africa Time, per the Daraja spec.

> **The author could not reach Safaricom.** Request/response/callback shapes follow the public Daraja documentation and are tested against a local fake that implements them; the first run against the real sandbox may reveal differences (field types, masked phone numbers, error codes). Test in the sandbox, then with KES 20 live, before trusting it.

## Result codes handled
`0` success; `1032` cancelled by the user; `1` insufficient funds; `2001` wrong PIN; `1037` timeout (no response from the phone); anything else → "failed". A success callback arriving **after** a timeout still credits (the request stays reconcilable for 1 hour, `stk.late_window_ms`). A failure never overrides a success.

## What happens in each situation
| Situation | System behaviour |
|---|---|
| Customer double-taps Pay | Same idempotency key → one push. |
| Callback delivered twice or 100 times | Credited once; the rest return "duplicate". |
| Callback never arrives | Reconciler queries at 30 s, then 60 s, 120 s ... up to 10 min intervals; success → credited with reference `STKQ-<CheckoutRequestID>`, flagged "credited without receipt"; if the real callback arrives later it only records the real receipt. |
| Callback amount ≠ requested | Not credited; booked as *unallocated* (reason `AMOUNT_MISMATCH`); owner alerted. |
| Callback phone ≠ requested phone | Same, `PHONE_MISMATCH`. |
| Unknown CheckoutRequestID with money | *Unallocated* (`UNKNOWN_CHECKOUT_REQUEST`). |
| Success claimed on an already-cancelled request | Confirmed with STK Query first; disagreement → no credit + alert. |
| Daraja unreachable when pushing | Request marked FAILED; if the failure was ambiguous (the push might have gone through) an alert tells you to check *Unallocated payments*. |

## Shared till (drinks and games on one number)
Money from an STK Push *this system sent* is credited. Everything else that lands on your till is just money for something else. In a **Till**, customers paying manually produce a C2B record with no account field, so the system can never tell which table they meant: it is booked as **unallocated** and **never vends**, even if you enable auto-credit. In a **Paybill**, you may enable *Auto-credit from C2B/QR payments*; then a payment vends only if its account number is a valid signed table code (shown on the customer page under "Pay by M-Pesa Paybill"). Wrong, missing or forged codes → unallocated.

**Assigning an unallocated payment** (Admin → Payments): choose the table and type a reason. It credits games according to the table's prices and remainder policy, is idempotent (repeat clicks do nothing; assigning elsewhere is refused), restricted to owner/manager, and audit-logged. Reports show pool revenue and *other-business receipts* separately, so your drink sales never inflate game revenue.

## Reversals
Owner → API `POST /api/payments/:id/reverse` (with a reason): removes unplayed credits and reverses the money; games already played are booked to *reversal loss* and you are alerted. Payments that consumed wallet credit must be reversed by hand (the API refuses).

## Manual reconciliation (safe procedure)
1. Get the M-Pesa statement from your Safaricom portal for the day.
2. Admin → Reports → export CSV for the same period; compare M-Pesa lines by **receipt number**.
3. Receipt on the statement but missing in the system: look in *Unallocated payments* (assign it if it is a game); if it is not there, the callback and the query both failed: assign nothing automatically; ask the customer, then use *Manual release* (owner) with a reason, or create an adjustment note.
4. Receipt in the system but not on the statement: stop and investigate (could be a sandbox/test entry); do not delete anything: reverse it with a reason.
5. Never edit the database by hand. The ledger and audit log are designed to be append-only; the right fix is always a new, explained entry.

## Registering URLs with Safaricom
STK needs no registration (the callback URL goes in each push). For C2B you must register the **confirmation** and **validation** URLs shown in Admin → Payments for your Paybill in the Daraja portal (the project does not call the register-URL API for you). Validation always answers "accepted".
