# Table installation and commissioning guide

> **Status of this guide.** The control software is tested, but **no part of the wiring, the ESP32 firmware build, or the interaction with a real table's mechanism could be tested by the author.** Treat this guide as a careful design to be *verified at the bench before it goes anywhere near a customer*. Follow the checklists; they exist because some things can only be proven on your table.

## 0. Safety first (read twice)

- **Mains electricity (230 V) can kill.** This system is designed so that *you never touch mains wiring*: the ESP32 side is powered by a small plug-in power adapter, and the controller only switches the table's own **low-voltage** coin/solenoid signal. If your table's solenoid or coin mechanism runs on mains voltage, or you are unsure, **stop and hire a qualified electrician** for that part.
- Always **unplug the table and wait 1 minute** before opening it. Never work on a live table. Never bridge anything you have not measured.
- **Never power the ESP32 from the same unregulated supply as a solenoid.** Solenoids create voltage spikes that reset or destroy microcontrollers. Use a separate regulated supply for the controller, and a diode across every DC solenoid.
- Fit a **fuse** in the supply to anything that can draw serious current.
- Keep wiring tidy and strain-relieved inside an enclosure with cable glands. No bare conductors. Nothing may touch moving parts or the ball path.
- The controller is designed so that if it crashes, loses WiFi or loses power, the release output turns **off**. Test that (section 9) rather than trusting it.

## 1. Tools and parts

### Tools
Multimeter; small screwdrivers; wire stripper/crimper; a phone or camera (photograph everything before you touch it); marker and masking tape for labelling wires; a laptop with a USB cable; cable ties; *(optional but very useful)* a cheap 8-channel USB logic analyzer (free PulseView software) to see the real pulse timing.

### Bill of materials (generic names; any equivalent works)

| Qty | Part | Notes |
|---|---|---|
| 1 | ESP32 development board (ESP32-WROOM-32, e.g. "DevKit V1" with USB) | Not an ESP32-S2/C3 unless you change pins and build settings. |
| 1 | Regulated 5 V USB power adapter, 1 A or more, with a short good-quality cable | Dedicated to the controller. |
| 1-2 | Optocoupler module or discrete PC817 (or similar), with ~330 Ω resistor for the LED | For COIN_PULSE output and the coin-input tap. |
| 0-1 | **Relay module with optocoupler isolation** (separate coil supply, "JD-VCC") rated well above the load | For SOLENOID_SLIDE / GATE_SOLENOID if you switch a solenoid supply. Contact rating must exceed solenoid voltage and current by at least 2x. |
| 0-1 | Logic-level MOSFET module or transistor (alternative to relay for small DC solenoids) | Only if you are comfortable with it. |
| 1 per DC solenoid | **Flyback diode**, e.g. 1N4007 (or 1N5819) | Mandatory across every DC solenoid or relay coil. |
| 1 | Regulated DC supply for the solenoid (voltage/current matching the solenoid) | Separate from the controller supply. |
| 1 | Fuse holder + fuse (rated slightly above the solenoid's running current) | In the solenoid supply's positive line. |
| 1 | Microswitch or hall-effect sensor module | "Balls captured / table ready" (optional). |
| 1 | Normally-closed or normally-open micro switch | Coin-box door / tamper (optional). |
| 1 | Pushbutton | Setup/reset (hold 5 s) and optional test request. |
| 1 | Pull-down resistor 10 kΩ | Holds the release output off while the ESP32 boots/crashes. **Required.** |
| - | Plastic enclosure (IP54 or better if damp/dusty), cable glands, screw terminal blocks, ferrules, heat-shrink, double-sided foam tape or DIN rail clips | No permanent drilling of the table: mount the box with tape/straps/brackets. |
| - | Hook-up wire (22-24 AWG for signals, thicker for solenoid), spade/clip-on connectors for tapping | Clip-on connectors keep it reversible. |
| opt. | 0.96" I²C OLED (SSD1306) | Shows status; build `esp32dev_oled`. |

## 2. Identify what your table does today

Open the table safely (unplugged) and find the **coin mechanism**. Photograph it from several angles, plus the controller board and any labels (brand, model, voltage). You will have one of three situations:

| What you see | It is | Use vend mode |
|---|---|---|
| A small metal/plastic box (the **electronic coin acceptor**) with a 3-4 wire connector going to a controller board; it often has a light/LED and a coin slot. Labels like "CH-926", "JY-923", "multi coin selector". | **Electronic acceptor with a pulse output.** It sends one or more electrical pulses per coin to the table's controller. | `COIN_PULSE` |
| A **mechanical slide**: you push a coin into a slot and a metal slide moves; the coin falls and trips a lever that releases the balls. No electronics. | **Mechanical coin slide.** | `SOLENOID_SLIDE` (a solenoid pushes the slide) |
| A **ball gate/lock** released by a solenoid or lever when a coin is detected; the coin acceptor may be wired straight to the solenoid. | **Solenoid gate.** | `GATE_SOLENOID` (energise the gate solenoid) |

What to photograph/record: wire colours and which terminal each goes to; any voltage printed on the board or acceptor (e.g. "12V DC"); the solenoid's label (voltage, "AC" or "DC", coil resistance if you can measure it with the multimeter set to ohms *with everything unplugged*).

If you cannot tell, take the photos to someone who services pool tables, or send them to whoever supports your table brand, **before buying parts**.

## 3. Measure before you connect anything

Do this on the **low-voltage** side only, and ask an electrician if the acceptor runs on mains.

**Coin acceptor (COIN_PULSE).** With the table powered (carefully, hands off the mains parts) and a multimeter on DC volts:
1. Black probe on the acceptor's **GND** wire (usually black), red on each other wire in turn. Typically you find: **+12 V (or +5 V)**, **COIN/SIGNAL** and sometimes **COUNTER**. The signal wire usually sits at the supply voltage (idle) and is pulled to ~0 V for a short time when a coin is accepted ("open-collector, active low").
2. Write down the **idle voltage** of the signal wire (e.g. 12.0 V) and what it does when you drop a real coin (watch the meter flick to ~0 V).
3. **Pulse timing.** A multimeter cannot see 50 ms pulses. Use a logic analyzer (connect to GND and signal, never to 12 V on a 3.3 V analyzer: use the optocoupler input of section 5.3 first), or look it up in the acceptor's manual: common values are 20-100 ms low with 20-100 ms gaps, selectable by dip switches. If unknown, start with the defaults (50 ms/50 ms) and tune in section 8.
4. Also note **how many pulses = one game** (the table's setting, often 1 pulse per coin or "credit").

**Solenoid.** Unplugged: measure the coil resistance. If it reads a few ohms to a few hundred ohms it is a coil. Read its label for voltage and whether **AC or DC**. Current = voltage ÷ resistance (for DC). Choose the relay/MOSFET and the fuse accordingly. **If AC mains, stop: use an electrician.**

## 4. Mounting without damaging the table (and keeping it reversible)

- Put the controller in its enclosure and fix it with **adhesive foam tape or straps** inside the cabinet, away from the ball path, moving parts, heat and any spot customers could reach.
- Connect to the table's wiring using **clip-on/spade connectors, wire taps in the existing terminal blocks, or inline connectors**: do not cut or solder the table's original wires. To uninstall, remove the connectors and the table is exactly as before.
- For the coin tap in section 5.3 you attach in *parallel* with the acceptor's signal wire (its output is open-collector, so two sources can share the line). Take a photo of the unmodified original connection first.
- Label every wire at both ends.

## 5. Wiring (ESP32 pin table first, then each mode)

### Pin table (change in `firmware/src/config.h` if needed)

| Function | ESP32 pin | Direction | Notes |
|---|---|---|---|
| **Vend output** | GPIO 26 | Output | To optocoupler LED/relay input. **10 kΩ pull-down to GND is mandatory.** `VEND_ACTIVE_HIGH=true` by default; if your relay board is active-low, set it to `false` **and** use a pull-up to 3.3 V instead. |
| Coin pulse input | GPIO 27 | Input (pull-up) | From the optocoupler output. Active-low by default. |
| Balls-captured / ready | GPIO 25 | Input (pull-up) | Switch to GND when the table is ready/idle (closed = ready). |
| Tamper / coin-box door | GPIO 33 | Input (pull-up) | Switch to GND when the door is opened (tamper). Change `TAMPER_ACTIVE_LOW`/polarity as needed. |
| Setup button | GPIO 14 | Input (pull-up) | Button to GND. Hold 5 s = factory reset of WiFi/credentials. |
| Status LED | GPIO 2 | Output | On-board LED on most boards. |
| OLED (optional) | GPIO 21 (SDA), 22 (SCL) | I²C | 3.3 V OLED. |
| Power | USB 5 V adapter | - | Dedicated, regulated. |

All inputs use the ESP32's internal pull-ups, so a switch simply connects the pin to GND. **Never connect any pin directly to 5 V or 12 V**: always through an optocoupler or a proper level shifter.

### 5.1 `COIN_PULSE`: emulate the coin acceptor

The ESP32 makes the table believe a coin was inserted by pulling the acceptor's signal line to ground through an **optocoupler** (the same thing the acceptor itself does). The optocoupler gives full electrical isolation.

```
 ESP32                                             Table's coin acceptor wiring (low voltage)
 ──────                                            ─────────────────────────────────────────
 GPIO26 ──[330 Ω]──► (+) PC817 LED (−) ──► GND     Controller board  "COIN" input ──┬── (existing acceptor signal wire)
          │                                                                         │
        [10 kΩ]                                       PC817 transistor  COLLECTOR ──┘   (tap in parallel, clip-on connector)
          │                                           PC817 transistor  EMITTER  ────►  table GND (same as acceptor GND)
         GND
```
- Connect the optocoupler's **collector** to the signal wire and the **emitter** to the table's **GND** (the acceptor's black wire). If the signal idles at +12 V/+5 V and pulses low, this is right. If your measurements show the opposite (idle low, pulses high), do not use this wiring: ask for help.
- Do **not** connect the ESP32's ground to the table's ground; the optocoupler isolates them.
- Settings (Admin → Tables → Edit): *Pulses per game*, *Pulse width ms*, *Gap ms* (hard limits 1-20 pulses, 10-1000 ms; enforced again inside the firmware).

### 5.2 `SOLENOID_SLIDE` and `GATE_SOLENOID`: energise a solenoid

```
 Separate regulated DC supply (matches the solenoid) ── FUSE ──┬──────────────► solenoid (+)
                                                               │      ┌─ flyback diode across the coil:
                                                       relay   │      │  cathode (stripe) to (+), anode to (−)
 ESP32 GPIO26 ──► relay module IN  (module has its own VCC/GND)  COM ──┘
 ESP32 5V/GND ──► relay module VCC/GND (JD-VCC jumper REMOVED, coil on its own supply if the module allows)
                                  relay NO contact ──► solenoid (−) ── supply (−)
```
- Use a relay module whose **input is optoisolated**. The relay's contacts only carry the **solenoid supply**, never the ESP32's.
- The **diode is mandatory** across a DC coil.
- *Hold time* (`holdMs`) is how long the solenoid is energised. The firmware refuses anything outside 50-5000 ms and independently cuts the output if it were ever on longer than 5 s. Choose the **shortest time that works reliably**; long holds heat the coil.
- A solenoid that is rated for intermittent duty must never be held continuously.

### 5.3 Reading the physical coin acceptor (to log real coins)

```
 acceptor +V (12 V) ──[1.2 kΩ for 12 V; 470 Ω for 5 V]──► PC817 LED (+)
 acceptor SIGNAL wire ─────────────────────────────────► PC817 LED (−)        (LED lights when the signal is pulled low)
 PC817 transistor: COLLECTOR ──► ESP32 GPIO27 (internal pull-up)    EMITTER ──► ESP32 GND
```
Each accepted coin pulls the signal low, the LED conducts, GPIO27 goes low. Pulses outside 15-150 ms, or closer together than 3 ms, are ignored as noise (`config.h`). Each coin becomes a **cash game** entry with no server payment, logged and reconciled at coin box collections.

### 5.4 Sensors and tamper switch
- **Ready (balls captured)**: a microswitch the returning balls press, or a hall sensor + magnet on the ball gate. Wire between GPIO25 and GND (switch closed = ready). Enable *"Release the next game only when the ready sensor reports ready"* in the table settings. With a sensor, the system will not release a second game until the first has ended.
- **Tamper**: a switch on the coin-box door between GPIO33 and GND.

## 6. Flashing the firmware and first power-up (on the bench)

1. Install **PlatformIO** (VS Code extension or `pip install platformio`).
2. Create the two certificate files the firmware embeds: `cd firmware && sh tools/prepare-certs.sh pool.yourdomain.co.ke`. This saves `certs/server_ca.pem` (the certificate authority your server's HTTPS uses, so the controller trusts *only* your server) and creates your **firmware signing key** `ota_private.pem` (move it offline; it is what proves updates are yours).
3. Connect the ESP32 by USB and run `pio run -e esp32dev -t upload` (use `-e esp32dev_oled` if you fitted an OLED). Open the serial monitor: `pio device monitor`.
4. On first boot (no credentials) the controller starts its **setup WiFi**: name `PoolTable-xxxxxx`, with a random password printed in the serial monitor. Join it with your phone; a page opens (or go to `http://192.168.4.1`). Enter: shop **WiFi name and password**, your **server address** (`https://pool.yourdomain.co.ke`), and the **Device ID** and **Device secret** from the admin dashboard. Press save: it restarts and connects. (WiFi password and device secret are stored encrypted in the chip's memory. For real protection against someone who steals the chip, also enable ESP32 flash encryption: see docs/SECURITY.md.)
5. Within a minute the admin dashboard shows the table **Online**. LED meaning: slow blink = no WiFi; double blink = WiFi ok but cannot reach the server; brief flash every 3 s = healthy; fast blink = tamper switch open.
6. In **Admin → Tables → Test release** (or the wizard) press the button: the table should release one game. Do this **on the bench with the solenoid/acceptor wired to a dummy load first** (an LED or a spare solenoid), then on the table.

To reset: hold the setup button for 5 s while powering on (or while running). To change WiFi later do the same and repeat step 4.

## 7. Choosing pulse width, gap and hold time
- **Coin pulse**: start at 1 pulse per game, 50 ms width, 50 ms gap. Press *Test release* 20 times; the table must register exactly one game each time. If it misses, increase the pulse width in steps of 10-20 ms (the table's controller may need ≥ 30-50 ms). If it double-counts, reduce pulses or lengthen the gap. Match the multi-pulse count to what the table expects for one game. Record the final values in your commissioning notes.
- **Solenoid**: start with 400 ms (slide) or 1500 ms (gate). Find the **shortest** hold that releases reliably 20 times in a row, then add 30% margin.

## 8. Bench test BEFORE mounting on the table
With the controller wired to a dummy load (LED/test solenoid) and the sensors on the bench:
- [ ] Power on: the vend output is **off** (LED/load off) before WiFi connects.
- [ ] Online in the dashboard; *Test release* gives exactly one pulse train / one hold of the expected length (check with a multimeter's min/max or a logic analyzer).
- [ ] Unplug the controller's power during a release: the load turns off and no second release happens when power returns.
- [ ] Press ready/tamper switches and see the dashboard react.
- [ ] Hold the setup button 5 s: credentials are erased (you can re-enter them).

## 9. Commissioning checklist (on the real table)
Tick every box and keep a copy.
- [ ] **Release test per mode**: 20 consecutive *Test release* presses → exactly 20 releases, none missed or doubled.
- [ ] **Power-loss test**: pay (or use the test release) → pull the controller's power mid-release → power back: no extra release; the credit is not lost (it is either released once or shown as waiting).
- [ ] **WiFi-loss test**: switch the shop router off, make a payment with the *cash POS* (Admin shows the table Offline, customers are blocked from paying with a clear message); switch it back on: the stored credit releases.
- [ ] **Duplicate-payment test**: double-tap *Pay* on the customer page, and tap *Confirm cash* twice: only **one** push / **one** sale / **one** release each.
- [ ] **Sensor test**: with a ready sensor, pay for 2 games: the second releases only after the sensor reports the table ready.
- [ ] **Tamper test**: open the coin-box door: an alert reaches you (SMS/Telegram) within a minute.
- [ ] **Real KES 20 payment in production**: pay KES 20 from your own phone on the live system: PIN prompt → receipt → one release → shown in Reports.
- [ ] **Refund test**: cause a failed release (e.g. unplug the solenoid) and resolve it with *Refund* and with *Retry*: ledger and reports show it.
- [ ] **Shared-till test**: if the Till is shared, pay KES 20 *to the Till manually* (no push): it must **not** release; it appears in *Unallocated payments*.
- [ ] **Clock/NTP check**: the dashboard shows the controller seen "now".
- [ ] **Coin test** (if the physical coin path is used): insert 3 real coins: three cash games are logged; do a coin-box collection and the counts match.
- [ ] **No mains work was done by an unqualified person**; enclosure closed; strain relief checked.

## 10. Go-live checklist
- [ ] Daraja is in **Production** with the correct shortcode/transaction type; *Test connection* passes.
- [ ] Callback URLs registered with Safaricom match the *Payments* tab; a live KES 20 test passed.
- [ ] **Auto-credit from C2B/QR** is OFF unless you deliberately use a Paybill with account codes.
- [ ] Staff created; PINs distributed privately; limits set; owner TOTP enabled (Admin → account).
- [ ] QR codes printed, laminated and fixed to the **correct** table (scan each one).
- [ ] Alerts configured (SMS/Telegram) and a test alert received.
- [ ] A backup ran and a **restore was rehearsed**.
- [ ] Owner phone: PWA/Android app installed.
- [ ] A paper note on the table: attendant's phone number for problems.

## 11. Day-2 operations
**Daily**: open the dashboard (or owner app): all tables Online? any alerts? unallocated payments to assign? Close attendants' shifts and look at variances.
**Weekly**: collect and count the coin box (record it: Admin → Shifts → Coin box); review voids/refunds; check the backup folder has fresh files; confirm each table's *Test release* still works.
**Monthly**: restore-test a backup on a spare machine; review the audit log (*Verify integrity*); update the server (`docker compose pull/up`); check firmware updates; inspect wiring, connectors and the enclosure for moisture or dust; rotate attendant PINs when staff leave (deactivate them at once).

See [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md) when something misbehaves.
