#!/usr/bin/env bash
# Update job-hunter to the latest version. Pulls the newest code, refreshes dependencies, and
# re-runs setup non-interactively (rebuilds the dashboard, refreshes the browser + skill dictionary;
# your saved settings, profile, and matches are preserved, and the database migrates on next start).
# Usage:  ./update.sh        (or:  bash update.sh)
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required to update but was not found." >&2
  exit 1
fi

echo "Pulling the latest version…"
git pull --ff-only

echo "Refreshing dependencies…"
npm install

echo "Re-running setup…"
npm run setup -- --yes

echo "✓ Update complete. If 'npm run serve' is running, restart it to pick up the changes."
