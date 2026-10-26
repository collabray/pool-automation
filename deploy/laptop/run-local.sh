#!/bin/sh
# Mode C: Laptop/PC (Linux/macOS). One command:  sh deploy/laptop/run-local.sh
# Needs Node.js 22.18+ (https://nodejs.org). For M-Pesa callbacks you also need a public HTTPS address, e.g. a free Cloudflare quick tunnel:
#   cloudflared tunnel --url http://localhost:8080      (prints https://something.trycloudflare.com; use it as the Daraja callback address)
set -e
cd "$(dirname "$0")/../.."
command -v node >/dev/null || { echo "Install Node.js 22 first: https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "Node 22 or newer is required"; exit 1; }
node scripts/gen-env.ts
set -a; . ./.env; set +a
exec node --disable-warning=ExperimentalWarning src/server/main.ts
