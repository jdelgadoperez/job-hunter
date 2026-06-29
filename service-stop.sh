#!/usr/bin/env bash
# Stop the job-hunter dashboard service (macOS). Usage: ./service-stop.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"
if [ ! -f "$PLIST" ]; then
  echo "Not installed."
  exit 0
fi
# bootout (not a plain signal): with KeepAlive=true the agent would immediately respawn after a
# SIGTERM. bootout unloads it so it stays stopped until the next login or ./service-start.sh.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
echo "Stopped."
