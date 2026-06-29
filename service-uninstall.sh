#!/usr/bin/env bash
# Remove the job-hunter dashboard background service (macOS). Usage: ./service-uninstall.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"

if [ ! -f "$PLIST" ]; then
  echo "Nothing to remove."
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Background service removed. (The dashboard is no longer running.)"
