#!/bin/sh
# Creates the two deployment-specific files the firmware embeds:
#   certs/server_ca.pem  root CA that signed your server's HTTPS certificate (the device refuses any other server)
#   certs/ota_pub.pem    public key matching the private key you use to sign firmware (keep ota_private.pem OFFLINE, never on the server)
# Usage: tools/prepare-certs.sh pool.example.com
set -e
cd "$(dirname "$0")/.."
DOMAIN=${1:?usage: prepare-certs.sh <domain>}
mkdir -p certs
# Collect the chain the server presents and keep the LAST certificate (the root or the top intermediate), which is what the device pins.
openssl s_client -showcerts -servername "$DOMAIN" -connect "$DOMAIN:443" </dev/null 2>/dev/null | awk '/BEGIN CERT/{n++} {if(n) print > "certs/chain_" n ".tmp"} /END CERT/{}' 
LAST=$(ls certs/chain_*.tmp | sort -V | tail -1)
openssl x509 -in "$LAST" -out certs/server_ca.pem && rm -f certs/chain_*.tmp
echo "Wrote certs/server_ca.pem (verify its subject yourself: openssl x509 -in certs/server_ca.pem -noout -subject -issuer)"
if [ ! -f certs/ota_pub.pem ]; then
  [ -f ota_private.pem ] || openssl ecparam -name prime256v1 -genkey -noout -out ota_private.pem
  openssl ec -in ota_private.pem -pubout -out certs/ota_pub.pem 2>/dev/null
  echo "Generated ota_private.pem (MOVE IT OFFLINE and back it up) and certs/ota_pub.pem"
fi
