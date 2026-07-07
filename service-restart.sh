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
# Delegate to the proven stop + start scripts rather than re-implementing the launchctl dance.
# bootout is asynchronous, so running them as separate processes lets launchd settle the unload
# before start's bootstrap runs — inlining the calls races and can leave the agent unloaded.
./service-stop.sh
./service-start.sh
