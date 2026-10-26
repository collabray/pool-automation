# Attendant cash POS

Open `https://YOUR-DOMAIN/pos.html` on the attendant's phone (add it to the home screen). Sign in with username + PIN.

## A normal day
1. **Open shift** and enter the opening **float** (cash already in the drawer). You cannot take cash without an open shift (the server enforces this).
2. **Sell**: tap the table, type the cash received. The screen shows how many games it buys, the change, or the amount held as credit, calculated by the server using that table's prices, bundles and remainder policy. Tap **Confirm cash received**. Games are credited and the table releases them. A **receipt** (sequential number, e.g. `C-000123`) can be shown, printed or sent by SMS.
3. **M-Pesa for a customer** (toggle at the top): enter games and the customer's phone, they get the PIN prompt, the status updates here.
4. **Sales**: list of recent sales with **Void** (reason required).
5. **My day**: games sold, sales, average sale, voids, refunds, breakdown by method, table and hour, and your variances. Choose today / yesterday / this week / this month. Money figures are hidden if the owner turned that off for you. You only ever see your own data. CSV/PDF export is available when money is visible.
6. **Shift → Close shift**: count the drawer and enter the amount (you do **not** see the expected figure: a "blind close"). The system saves expected, counted and variance; variances above the threshold alert the owner. A closed shift can never be edited; only the owner can add a signed adjustment.

## Rules the system enforces
| Rule | Detail |
|---|---|
| Idempotent sales | Each tap of *Confirm* carries a key; double-taps and retries never create a second sale. |
| Remainders | Per table: hold as credit, give change, or reject non-exact amounts. |
| Discounts | Need a reason; above your **discount limit** a manager must type their own PIN/password on your phone ("Manager approval"). Approvals are single-use, expire in 5 minutes and cannot be used by someone else or for yourself. |
| Voids | Need a reason; only your own sale; only while the shift is open and **no game from it has been released**; above your **void limit** needs manager approval. A release that already happened is handled as a *failed/refund vend* instead. |
| Failed releases | The POS lists them: **Retry**, **Keep as credit** or **Refund**, each with a reason. A **refund** above your void limit needs manager approval (done from the admin dashboard by a manager). |
| Manual release | Off by default per table; when enabled, attendants get a few per shift (setting), always with a reason, always logged. |
| Offline | The server supports an *offline cash queue* (admin setting, off by default, capped, idempotent on sync), but **the POS web page does not yet queue sales while offline**; it needs a connection. See docs/VERIFICATION.md. |
| Receipts | Sequential numbers with no gaps unless a sale was rolled back before saving (gaps are detectable by `receiptGaps`). |

## For owners and managers
Admin → Shifts shows every shift with expected/counted/variance. Admin → Reports compares attendants (sales, games, money, average, voids, refunds). Everything is in the audit log.
