#!/usr/bin/env bash
# Put a `job-hunter` command on your PATH (macOS/Linux) so you can run `job-hunter <command>` from
# anywhere instead of `npm run cli -- <command>`. No admin required. Usage: ./command-install.sh
#
# Symlinks bin/job-hunter into ~/.local/bin (the standard per-user bin dir). Re-runnable: it
# refreshes the link if it already points elsewhere.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found. Install Node 24 (see .nvmrc) from https://nodejs.org and re-run." >&2
  exit 1
fi

REPO="$(pwd)"
WRAPPER="$REPO/bin/job-hunter"
if [ ! -f "$WRAPPER" ]; then
  echo "Can't find bin/job-hunter in $REPO. Run ./install.sh first." >&2
  exit 1
fi
chmod +x "$WRAPPER"

BIN_DIR="$HOME/.local/bin"
LINK="$BIN_DIR/job-hunter"
mkdir -p "$BIN_DIR"

# Refuse to clobber a real file that isn't our symlink (e.g. some other `job-hunter` on PATH).
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "$LINK already exists and isn't a job-hunter symlink. Move it aside and re-run." >&2
  exit 1
fi

ln -sf "$WRAPPER" "$LINK"
echo "Linked: $LINK -> $WRAPPER"

# ~/.local/bin isn't always on PATH. If it isn't, tell the user exactly how to add it rather than
# silently linking a command they can't run.
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "You can now run: job-hunter <command>   (e.g. job-hunter serve)"
    ;;
  *)
    echo
    echo "$BIN_DIR is not on your PATH yet. Add it by appending this line to your shell profile"
    echo "(~/.zshrc, ~/.bashrc, or ~/.profile), then open a new terminal:"
    echo
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo
    echo "After that, run: job-hunter <command>"
    ;;
esac
