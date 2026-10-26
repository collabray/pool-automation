# Troubleshooting

Find the symptom, check the likely cause, apply the fix. When in doubt: look at **Admin → Dashboard** (alerts, offline tables) and **Admin → System → Audit/Error log**, then call for help with the *request ID* or *receipt number*.

## Payments
| Symptom | Likely cause | Fix |
|---|---|---|
| Customer never gets the PIN prompt (STK push not arriving) | Wrong Daraja credentials/shortcode/passkey; sandbox vs production mixed; phone is not on Safaricom or is switched off/out of coverage; the customer's STK is disabled or the SIM menu is locked; server IP not whitelisted; rate limit hit. | Admin → Payments → **Test connection**. Check environment, shortcode, passkey and transaction type (Paybill vs Till). Try another phone. Check Admin → System → Error log. Wait out the cooldown (15 s) or rate limit. Confirm Safaricom has whitelisted your server IP if required. |
| Customer paid (money gone) but screen says timeout and no games | Callback lost or delayed. | Do nothing for a minute: the reconciler asks Safaricom and credits automatically (it keeps trying for an hour). If still nothing: look in **Unallocated payments** for the receipt; assign it to the table with a reason. |
| Callback not received at all (pushes succeed, never credited, reconciler fixes them late) | Callback URL wrong/unreachable; domain/HTTPS certificate problem; firewall; tunnel down; the secret token in the URL changed; IP allowlist too strict. | Open `https://YOUR-DOMAIN/api/health` from your phone's mobile data. Compare the URL shown in Admin → Payments with what the push sent (the server always sends the current one). Clear *callback IP allowlist* temporarily. Check Caddy/tunnel logs. |
| Duplicate callbacks in the log | Normal: Safaricom sometimes resends. | Nothing: duplicates are recognised and ignored (verdict `DUPLICATE`). Credits are unique per receipt. |
| Wrong amount paid / unusual amount arrives | Customer paid manually (Paybill) a non-exact amount; or an STK amount mismatch. | The remainder policy applies: held as credit, refunded or rejected (the payment then shows in Unallocated). Assign or refund manually; see PAYMENTS.md. |
| A drink payment on the shared till appeared | Expected: it is booked as *other-business receipt*. | It must be in **Unallocated payments** and must not have released a game. Leave it there (it is simply not game money), or assign it if it was really for a game. |
| "Payments are not set up yet" on the customer page | Daraja not configured or credentials missing. | Complete Admin → Payments, then Test connection. |
| Customer sees "This table is offline / has a fault" before paying | The controller is not reporting, or a release failed and needs a decision. | See Device section below, or Dashboard → failed releases → Retry/Refund/Keep credit. This is intentional: it protects customers from paying for a table that cannot release. |
| Reports do not match the M-Pesa statement | Test/sandbox rows, unallocated payments, reversals, or a timezone confusion (reports use Nairobi time). | Follow "Manual reconciliation" in docs/PAYMENTS.md. |

## Releasing the balls
| Symptom | Likely cause | Fix |
|---|---|---|
| **Paid but balls not released** | Controller offline; table faulted; waiting for the ready sensor; one-at-a-time mode with a game in progress; release failed. | Dashboard shows "games waiting". If offline: fix WiFi/power, the credit releases by itself on reconnect (never lost). If *waiting for ready*: check the sensor wiring (Sensors below). If a release failed: resolve it (Retry / Keep / Refund). Owner can also use **Open table**. |
| **Double release** | Table's own mechanism pulses twice for one command (pulse width/gap too long or multiple pulses configured too high); or the table's controller accepts both the pulse and a leftover manual coin. | Reduce pulses per game / adjust width and gap (Installation §7). The firmware never executes a vend ID twice; check the vend list for two different vend IDs vs one. |
| **Balls released with no payment** | Someone pulled/jammed the mechanism, shorted the coin line, or the wiring tap triggers the table directly; or the physical coin path was used (logged as coins). | Look for a *Vend without payment* alert and coin events. Inspect the tap wiring for shorts, check the tamper switch and the coin box. A signed command can only come from your server, so a release without any vend record means the table was triggered outside the controller. |
| Pulses not counted by the table | Wrong polarity (acceptor idles low, not high); pulse width too short for the table's controller; optocoupler wired backwards; the acceptor GND not shared; wrong pulse count. | Measure idle voltage on the signal wire (Installation §3); widen the pulse (+10 ms steps); check the optocoupler's collector/emitter; verify with a logic analyzer. |
| Solenoid stuck or weak | Hold time too short/long; undersized supply; voltage drop in thin wire; missing/failed flyback diode (relay contacts burn); coil overheating. | Measure the supply under load; shorten/lengthen `holdMs`; use thicker wire; fit/replace the diode; give the solenoid time to cool. Never hold a solenoid longer than needed. |
| Relay clicks but nothing happens | Contacts not wired to the solenoid supply; wrong NO/NC terminal; supply off; fuse blown. | Check the NO contact and the supply with a multimeter; replace the fuse (same rating). |
| Sensor stuck (always ready / never ready) | Switch wired the wrong way; hall sensor polarity; magnet too far; broken wire; the ready logic inverted in `config.h`. | Watch the dashboard board while you press the switch; flip `READY_ACTIVE_LOW`; reposition the sensor/magnet. |
| Alerts: *sensor fault*, *repeated vend failures* | The controller refused/failed commands (guard limits exceeded, wrong vend mode set on the table vs the controller, sensor fault). | Check the table's vend mode and timing limits in Admin; see the vend's failure reason. |

## The controller (ESP32)
| Symptom | Likely cause | Fix |
|---|---|---|
| Won't connect to WiFi | Wrong password; 5 GHz-only network (ESP32 needs 2.4 GHz); weak signal; hidden or special-character network name. | Hold the setup button 5 s, re-run setup. Check RSSI on the dashboard (better than -75 dBm). Move/add an access point. |
| Connects to WiFi but "double blink" (server unreachable) | Wrong server address; server down; certificate problem; clock not set (TLS needs time). | Check the address (https://, no trailing path); open it from a phone; make sure the controller can reach NTP (UDP 123); the server certificate must be signed by the CA pinned in the firmware (re-run `prepare-certs.sh` if you changed domain/provider). |
| Keeps rebooting | Brownout from a weak or noisy supply; solenoid supply shared with the ESP32; boot-loop from a bad image. | Use a good 5 V ≥ 1 A adapter and short cable; separate the solenoid supply; check the *reset reason* on the dashboard (`brownout`, `panic`, `wdt`); re-flash by USB. |
| Device offline | Power/WiFi/internet outage; router rebooted; secret rotated; server unreachable. | Check each in that order. If you rotated the secret, re-enter the new one in setup mode. Paid credits wait safely on the server. |
| Power cuts | Normal. | Credits and shifts are safe (database transactions). The controller starts with the output off and remembers executed vend IDs. Consider a small UPS for the router and server. |
| Clock drift | NTP blocked. | Not a payment problem: commands are judged against **server time** with a 5 s tolerance; the device clock is only used for TLS and request timestamps (±2 minutes). Allow UDP 123 or fix the router's time. |

## Cash, shifts and coins
| Symptom | Likely cause | Fix |
|---|---|---|
| Coin box does not match the logged coins | Coins inserted while the controller was offline/unpowered; wrong *coin value*; acceptor pulses wired wrong; theft. | Check the coin value per table; compare dates; look for tamper alerts; do the collection regularly. The mismatch is flagged and kept for review. |
| Shift variance | Wrong change, an unrecorded sale/refund, a miscount, or theft. | Recount; check voids/refunds/discounts for that shift (Reports → Attendants); the owner may add a reasoned adjustment (it never edits the closed shift). |
| "Open a shift before taking cash" | The attendant has no open shift (or it was closed). | Shift → Open shift. |
| "APPROVAL_REQUIRED" | Discount/void above the attendant's limit. | A manager enters their own username and PIN/password in the approval screen. |

## Server and infrastructure
| Symptom | Likely cause | Fix |
|---|---|---|
| Certificate or tunnel problems | DNS not pointing at the server; ports 80/443 blocked; Let's Encrypt rate limit; `cloudflared` stopped; domain moved. | `docker compose logs caddy`; check DNS (`ping`); open ports; `systemctl status cloudflared`. |
| Database full / disk full | Backups or logs filling the disk. | Delete old backups you have already copied off; `docker system prune`; enlarge the disk. The database itself is small. |
| "Ledger balanced: NO" on the dashboard | Should never happen. Possible disk corruption or someone changed the database outside the app. | Stop taking payments. Run `node scripts/backup.ts --verify` on the latest backup; compare; restore the last good backup (OPERATIONS.md). Keep the bad file for investigation. |
| Forgotten owner password | - | On the server (with the same `.env`): `node scripts/reset-password.ts <username> '<new strong password>'` (add `--pin` for an attendant PIN). It ends all their sessions, unlocks the account and writes an audit entry. In Docker: `docker compose exec app node --disable-warning=ExperimentalWarning scripts/reset-password.ts ...`. |
| Everything is slow | Disk or CPU starved; thousands of audit rows are fine. | `docker stats`; check disk; a VPS with 1 GB RAM is enough. |

## How to reconcile one payment manually and safely
1. Get the **M-Pesa receipt number** (customer's SMS) and amount.
2. Search Admin → Payments → *Recent payments* and *Unallocated payments* for it.
3. Found in *Payments*: games were credited; if the customer didn't get them, look at the table's vends (failed release → Retry/Keep/Refund).
4. Found in *Unallocated*: assign to the right table with a reason ("customer showed SMS SGH7K2L9QW").
5. Not found anywhere: do **not** invent a payment. Verify on the Safaricom portal; if it exists there and the system never saw it, use the owner's **Open table** with the reason "manual: receipt XXXX" and record it. Reconcile with the statement the next day.
