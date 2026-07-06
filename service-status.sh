#!/usr/bin/env bash
# Show whether the job-hunter dashboard service is running, plus recent log lines (macOS).
# Usage: ./service-status.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"
if [ ! -f "$PLIST" ]; then
  echo "Not installed."
  exit 0
fi
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "Running. Dashboard at http://localhost:48373"
else
  echo "Installed but not running. Run ./service-start.sh"
fi
LOG="$(log_file)"
if [ -f "$LOG" ]; then
  echo "--- recent log ($LOG) ---"
  tail -n 20 "$LOG"
fi
