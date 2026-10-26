# PlatformIO pre-build hook: fail early with a clear message when the deployment-specific certificates are missing.
Import("env")
import os, sys
root = env.subst("$PROJECT_DIR")
missing = [f for f in ("certs/server_ca.pem", "certs/ota_pub.pem") if not os.path.exists(os.path.join(root, f))]
if missing:
    sys.stderr.write("\nMISSING: %s\nRun firmware/tools/prepare-certs.sh <your-domain> first (see docs/TABLE-INSTALLATION.md).\n\n" % ", ".join(missing))
    env.Exit(1)
