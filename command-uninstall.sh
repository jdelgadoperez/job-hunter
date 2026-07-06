#!/usr/bin/env bash
# Remove the `job-hunter` command from your PATH (macOS/Linux). Usage: ./command-uninstall.sh
# Only removes our own symlink in ~/.local/bin; leaves anything else alone.
set -euo pipefail
cd "$(dirname "$0")"

REPO="$(pwd)"
LINK="$HOME/.local/bin/job-hunter"
WRAPPER="$REPO/bin/job-hunter"

if [ ! -L "$LINK" ]; then
  echo "Nothing to remove."
  exit 0
fi

# Only remove the link if it points at THIS repo's wrapper — don't delete a link to some other install.
target="$(readlink "$LINK")"
if [ "$target" != "$WRAPPER" ]; then
  echo "$LINK points to $target, not this repo. Leaving it in place."
  exit 0
fi

rm -f "$LINK"
echo "Removed: $LINK  (the 'job-hunter' command is gone; 'npm run cli -- ...' still works.)"
