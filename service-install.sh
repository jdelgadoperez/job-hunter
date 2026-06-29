#!/usr/bin/env bash
# Install the job-hunter dashboard as a per-user background service (macOS).
# Starts at login, restarts on crash. No admin required. Usage: ./service-install.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"

require_node

REPO="$(repo_dir)"
if [ ! -f "$REPO/web/dist/index.html" ]; then
  echo "The dashboard isn't built yet. Run ./install.sh first, then re-run this." >&2
  exit 1
fi

if [ -f "$PLIST" ]; then
  echo "Already installed. Run ./service-uninstall.sh first to reinstall." >&2
  exit 1
fi

NODE="$(node_bin)"
ENTRY="$(serve_entry)"
LOG="$(log_file)"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--import</string>
    <string>tsx</string>
    <string>$ENTRY</string>
    <string>serve</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Dashboard will start automatically at login. Open http://localhost:4317"
