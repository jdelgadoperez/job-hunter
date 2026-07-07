#!/usr/bin/env bash
# Restart the job-hunter dashboard service now (macOS). Usage: ./service-restart.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"
if [ ! -f "$PLIST" ]; then
  echo "Not installed. Run ./service-install.sh first." >&2
  exit 1
fi
# Mirror stop (bootout) then start (bootstrap + kickstart): with KeepAlive=true a plain kickstart
# restarts in place, but bootout first guarantees a clean reload of any changed plist/environment.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Restarted. Open http://localhost:48373"
