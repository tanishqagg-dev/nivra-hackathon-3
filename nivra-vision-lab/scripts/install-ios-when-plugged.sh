#!/bin/sh
# Waits for the NIVRA iPhone on the cable, installs the newest NIVRA build once, then asks the Mac to connect again.
LOG=/tmp/nivra-ios-install.log
INSTALL="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)/mobile/scripts/install-ios-connected.py"
echo "$(date '+%H:%M:%S') waiting for an iPhone on the cable" >> "$LOG"
until xcrun devicectl list devices 2>/dev/null | grep -i "iphone" | grep -iv "unavailable\|simulated" | grep -qi "physical"; do sleep 5; done
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  echo "$(date '+%H:%M:%S') installing (attempt $attempt)" >> "$LOG"
  if python3 "$INSTALL" >> "$LOG" 2>&1 && ! tail -3 "$LOG" | grep -qi "unlock\|unavailable\|failed"; then
    echo "$(date '+%H:%M:%S') installed" >> "$LOG"
    curl -s -X PUT -H 'Content-Type: application/json' -d '{"enabled":true}' http://127.0.0.1:18765/usb/auto >/dev/null
    exit 0
  fi
  sleep 10
done
echo "$(date '+%H:%M:%S') gave up; run the install script by hand" >> "$LOG"
