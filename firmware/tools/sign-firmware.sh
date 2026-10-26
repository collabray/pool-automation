#!/bin/sh
# Signs a firmware image for the OTA endpoint. Output: <bin>.sig.b64 (base64 DER ECDSA-P256 signature over the SHA-256 digest) and prints the digest.
# Usage: tools/sign-firmware.sh .pio/build/esp32dev/firmware.bin ota_private.pem
set -e
BIN=${1:?firmware.bin}; KEY=${2:?ota_private.pem}
openssl dgst -sha256 -sign "$KEY" -out "$BIN.sig" "$BIN"
base64 -w0 "$BIN.sig" > "$BIN.sig.b64" 2>/dev/null || base64 "$BIN.sig" | tr -d '\n' > "$BIN.sig.b64"
echo "sha256: $(openssl dgst -sha256 -r "$BIN" | cut -d' ' -f1)"; echo "signature: $BIN.sig.b64"
