#!/bin/sh
# Uploads a signed firmware image to your server (owner login required), then you roll it out from Admin -> System -> Firmware.
# Usage: tools/upload-firmware.sh https://pool.example.com 1.0.1 .pio/build/esp32dev/firmware.bin   (run tools/sign-firmware.sh first)
set -e
SERVER=${1:?server url}; VERSION=${2:?version}; BIN=${3:?firmware.bin}
printf "Owner username: "; read -r USERNAME; printf "Owner password: "; stty -echo; read -r PASSWORD; stty echo; echo
TOKEN=$(curl -fsS -X POST "$SERVER/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" | sed 's/.*"accessToken":"\([^"]*\)".*/\1/')
SIG=$(cat "$BIN.sig.b64")
python3 - "$VERSION" "$SIG" "$BIN" > /tmp/fw-upload.json <<'PY'
import sys, json, base64
v, sig, path = sys.argv[1:4]
print(json.dumps({"version": v, "signature": sig, "dataBase64": base64.b64encode(open(path, "rb").read()).decode()}))
PY
curl -fsS -X POST "$SERVER/api/firmware" -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: fw-$VERSION" -H 'Content-Type: application/json' --data-binary @/tmp/fw-upload.json; echo
rm -f /tmp/fw-upload.json
