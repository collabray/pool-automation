# Setup guide (step by step)

You do not need to be a programmer. You need: an hour or two, a credit/debit card or M-Pesa for the server and domain, and (for live payments) a Safaricom business account.

Words used here: **VPS** = a small computer you rent on the internet. **Domain** = your web address (e.g. `pool.kali.co.ke`). **Daraja** = Safaricom's developer portal that lets software request M-Pesa payments. **STK Push** = the M-Pesa PIN prompt that pops up on the customer's phone.

> M-Pesa must be able to reach your server over the internet to deliver payment confirmations. That is why a cloud server (or a tunnel) is needed.

---
## Option A: Cloud server (recommended)

### A1. Buy a server and a domain
1. Rent a small Linux VPS (Ubuntu 22.04 or 24.04, 1 vCPU, 1-2 GB RAM, 20 GB disk). Any reputable provider works. Note its **IP address**.
2. Buy a domain name. In the domain's DNS settings, add an **A record**: name `pool` (or `@`), value = your server's IP address. Wait 5-30 minutes. Test: `ping pool.yourdomain.co.ke` should show your IP.

### A2. Install Docker on the server
Connect with SSH (`ssh root@YOUR-IP`) and run:
```
curl -fsSL https://get.docker.com | sh
```
Also run the firewall basics: `ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable`.

### A3. Deploy
```
git clone <your copy of this repository> pooltable && cd pooltable
apt-get install -y nodejs   # only needed to run the next helper; or copy .env.example to .env and fill it in by hand
node scripts/gen-env.ts --domain pool.yourdomain.co.ke --email you@example.com
docker compose up -d --build
```
`gen-env.ts` creates `.env` with fresh random secrets. **Copy `.env` somewhere safe and offline** (password manager or a printed copy in a safe): without `APP_MASTER_KEY` and `BACKUP_KEY` your stored credentials and backups cannot be read.

Check it is up: open `https://pool.yourdomain.co.ke/api/health`; you should see `{"ok":true,...}`. (Caddy fetches a free HTTPS certificate automatically the first time; this can take a minute.)

### A4. First-run wizard
Open `https://pool.yourdomain.co.ke/admin.html`. The wizard walks you through:
1. **Owner account** (business name, your username, a strong password).
2. **M-Pesa (Daraja)**: see A5 below. You may *skip* and use cash only for now.
3. **First table**: name, how it vends (see the installation guide), price.
4. **Connect the controller**: the screen shows the **Device ID** and **Device secret**, once. Write them down; you type them into the controller in the installation guide.
5. **Test release**: appears after the controller is online.
6. **Print the QR code**.

Next, in *System → Settings*, set **Public website address** to `https://pool.yourdomain.co.ke`; the QR codes need it.

### A5. Safaricom Daraja: sandbox first, then live
1. Create an account at **developer.safaricom.co.ke**, then *My Apps → Add a new app*; tick **Lipa na M-Pesa Sandbox**. You get a **Consumer Key** and **Consumer Secret**.
2. Sandbox test values (shown in the portal under *APIs → M-Pesa Express → Simulate*): shortcode **174379** and the sandbox **Passkey**. Enter them in the wizard / *Payments* tab with environment = **Sandbox**, and "Public HTTPS address" = your website address. Press **Test connection**: it must say *Connected*.
3. In the *Payments* tab you will see the three **URLs** (STK callback, C2B confirmation/validation). The long secret in each URL is your protection against forged payment messages: do not share them.
4. Make a test payment from the customer page using your own phone in the sandbox (Safaricom's simulator sends the callback).
5. **Go live** (when sandbox works): apply for **Go Live** in the portal using your Paybill or Till (Buy Goods) number. Safaricom gives you the production **Passkey** (and, for a Till, a head-office/store number). Then in the *Payments* tab: environment **Production**, **transaction type** = Paybill or Till, **Shortcode** = the BusinessShortCode Safaricom gave you, **Receiving number** = the Till number (Till only). New Consumer Key/Secret are for the production app.
   - If Safaricom asks you to **whitelist your server's IP**, give them the VPS IP address.
   - Optional hardening: in *System → Settings* fill **Safaricom callback IP allowlist** with the IP addresses Safaricom publishes for callbacks. Leave it empty if unsure (the secret URL already protects you).
6. If your Till is shared with a shop (drinks etc.), read [docs/PAYMENTS.md](docs/PAYMENTS.md) "Shared till" before going live. Keep **Auto-credit from C2B/QR payments** at `0`.

### A6. Tables, prices and bundles
*Tables → Edit*:
- **Price per game** (default KES 20). **Minimum/maximum games** per payment.
- **Bundles**, one per line: `6=100` means 6 games for KES 100.
- **Peak prices**, one per line: `fri,sat; 18:00-02:00; 30` means KES 30 per game Friday/Saturday evening (Nairobi time).
- **If a manual payment is not an exact multiple**: hold the remainder as credit (default), refund it, or reject the payment.
- **Release mode**: *One at a time* or *All at once*. Tables with a ball-gate or slide **and no "ready" sensor** should use *All at once* (or coin-pulse mode), because without a sensor the system cannot know when the previous game ended.

### A7. Staff and cash policies
*Staff → Add*: attendants sign in with a **PIN** (4-8 digits, not 1234 or 1111), managers with a password. Per person you set: can they see money figures; their **void limit** and **discount limit** (above these, a manager must type their own PIN/password on the attendant's phone). *System → Settings* has the **shift variance alert** (default KES 50) and optional offline-sale limits.

### A8. Printing and fixing table QR codes
Open `https://pool.yourdomain.co.ke/qr-sheet.html` (signed in as owner), press Print. Laminate each QR and fix it to the matching table. The QR contains a **signed** table code, so people cannot guess or alter it. If a QR is ever damaged, just reprint it: the code does not change.

### A9. Backups
`docker compose` already runs a daily **encrypted backup** at 03:00 into `./backups`. Copy that folder off the server regularly (to your laptop or cloud storage). Practice a restore: [docs/OPERATIONS.md](docs/OPERATIONS.md).

---
## Option B: Raspberry Pi (local server)
Good if you want the server in the shop. Needs a Pi 4/5 (64-bit Raspberry Pi OS), a good power supply, and ideally an SSD or high-endurance SD card.
1. Copy the repository onto the Pi, then `sudo sh deploy/pi/install.sh pool.yourdomain.co.ke`. It installs Node.js 22, creates a locked-down service user, generates `.env` and starts the server and the backup service.
2. Public HTTPS without opening router ports: **Cloudflare Tunnel**. Put your domain on Cloudflare (free), install `cloudflared`, then follow the commands in the header of `deploy/pi/cloudflared.service`.
3. Continue with step A4 using your domain. Power-cut safety: the database is written with `synchronous=FULL` and write-ahead logging, so a sudden power loss does not corrupt paid credits; unfinished writes are rolled back. Use an uninterruptible power source (a small UPS) if you can.

## Option C: Laptop or PC
Fine for trying things out or a small shop. **One command**: `sh deploy/laptop/run-local.sh` (Windows: double-click `deploy\laptop\run-local.bat`). It needs Node.js 22.18 or newer from nodejs.org, creates the secrets for you and starts the server on port 8080.
- Public HTTPS for M-Pesa: run `cloudflared tunnel --url http://localhost:8080` in a second window; it prints a temporary `https://….trycloudflare.com` address. For permanent use, set up a named tunnel as in Option B.
- Start automatically: Linux, `deploy/laptop/pooltable-user.service`; Windows, add `run-local.bat` to Task Scheduler ("At log on", run with highest privileges).
- No Docker needed. The laptop must stay on and connected whenever tables are in use.

---
## Updating
`git pull && docker compose up -d --build` (Docker) or `sudo systemctl restart pooltable` after copying new files (Pi). Database changes are applied automatically at start-up and are versioned. Always take a manual backup first: `docker compose exec backup node scripts/backup.ts`.
