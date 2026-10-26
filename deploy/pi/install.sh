#!/bin/sh
# Raspberry Pi (64-bit Raspberry Pi OS, Pi 4/5) installer. Run as root:  sudo sh deploy/pi/install.sh
set -e
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
id pooltable >/dev/null 2>&1 || useradd --system --home /opt/pooltable --shell /usr/sbin/nologin pooltable
mkdir -p /opt/pooltable/data /opt/pooltable/backups
cp -r package.json src migrations web scripts deploy /opt/pooltable/
[ -f /opt/pooltable/.env ] || (cd /opt/pooltable && node scripts/gen-env.ts --domain "${1:-localhost}" && sed -i 's/^HOST=.*/HOST=127.0.0.1/; s/^TRUST_PROXY=.*/TRUST_PROXY=1/; s/^HSTS=.*/HSTS=1/' .env)
chown -R pooltable:pooltable /opt/pooltable && chmod 600 /opt/pooltable/.env
cp /opt/pooltable/deploy/pi/pooltable.service /opt/pooltable/deploy/pi/pooltable-backup.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pooltable pooltable-backup
echo "Server running on 127.0.0.1:8080. Now set up the tunnel (deploy/pi/cloudflared.service) and open https://YOUR-DOMAIN/admin.html"
