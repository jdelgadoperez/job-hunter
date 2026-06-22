#!/usr/bin/env bash
# macOS / Linux installer for job-hunter. Installs dependencies, then runs guided setup.
# Usage:  ./install.sh        (or:  bash install.sh)
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found. Install Node 20+ from https://nodejs.org and re-run." >&2
  exit 1
fi

echo "Installing dependencies…"
npm install

echo "Running setup…"
npm run setup
