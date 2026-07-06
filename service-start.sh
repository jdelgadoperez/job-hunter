#!/usr/bin/env bash
# Start the job-hunter dashboard service now (macOS). Usage: ./service-start.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"
if [ ! -f "$PLIST" ]; then
  echo "Not installed. Run ./service-install.sh first." >&2
  exit 1
fi
# stop does `bootout` (unload), so start must `bootstrap` (load) again — kickstart alone only works
# on an already-loaded agent. bootstrap is a no-op error if already loaded, so ignore that case.
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Started. Open http://localhost:48373"
