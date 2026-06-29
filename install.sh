#!/usr/bin/env bash
# macOS / Linux installer for job-hunter. Installs dependencies, then runs guided setup.
# Usage:  ./install.sh        (or:  bash install.sh)
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found. Install Node 24 (see .nvmrc) from https://nodejs.org and re-run." >&2
  exit 1
fi

# The CLI uses APIs that require Node 22+ (array-format util.styleText); .nvmrc pins 24.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "job-hunter needs Node 22 or newer (found $(node -v)). Install Node 24 (see .nvmrc) from https://nodejs.org and re-run." >&2
  exit 1
fi
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Note: Node 24 is recommended (see .nvmrc) — you're on $(node -v). Continuing…"
fi

echo "Installing dependencies…"
npm install

echo "Running setup…"
npm run setup

echo
read -r -p "Keep the dashboard running in the background (start at login)? [y/N] " reply
case "$reply" in
  [yY]*) ./service-install.sh ;;
  *) echo "Skipped. You can enable it later with ./service-install.sh" ;;
esac
