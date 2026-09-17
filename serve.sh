#!/usr/bin/env bash
# Serve the calculator on this machine and on the local network, so that
# phones on the same Wi-Fi can open it too.
#
#   ./serve.sh          # port 8000
#   ./serve.sh 9000     # some other port
set -euo pipefail

PORT="${1:-8000}"
cd "$(dirname "$0")"

LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.' | head -n1 || true)"

echo
echo "  UNN Mechanical Engineering — GPA Calculator"
echo "  ==========================================="
echo
echo "  On this computer:   http://localhost:${PORT}/"
if [ -n "${LAN_IP}" ]; then
  echo "  On a phone/tablet:  http://${LAN_IP}:${PORT}/"
  echo "                      (the phone must be on the same Wi-Fi network)"
  if command -v qrencode >/dev/null 2>&1; then
    echo
    qrencode -t ANSIUTF8 "http://${LAN_IP}:${PORT}/"
  else
    echo "                      (install 'qrencode' to print a scannable QR code here)"
  fi
else
  echo "  No local network address detected; localhost only."
fi
echo
echo "  Press Ctrl+C to stop."
echo

exec python3 -m http.server "${PORT}" --bind 0.0.0.0
