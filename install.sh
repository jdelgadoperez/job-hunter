#!/usr/bin/env bash
# macOS / Linux installer for job-hunter. Installs dependencies, then runs guided setup.
# Usage:  ./install.sh        (or:  bash install.sh)
set -euo pipefail

cd "$(dirname "$0")"

NODE_DOWNLOAD_URL="https://nodejs.org"
# Where we install fnm if the user has no version manager yet (per-user, no root).
FNM_INSTALL_DIR="$HOME/.local/share/fnm"

# The CLI uses APIs that require Node 22+ (array-format util.styleText); .nvmrc pins 24.
NODE_MIN_MAJOR=22

# nvm is a shell function, not an executable on PATH — source it so we can call it from here.
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  command -v nvm >/dev/null 2>&1
}

# Install the latest Node LTS with fnm (assumes fnm is on PATH). Also makes it active here.
fnm_install_lts() {
  echo "Installing the latest Node LTS via fnm…"
  fnm install --lts || return 1
  eval "$(fnm env)"   # make fnm's shims active in this shell so `node` resolves below
  fnm use lts-latest
}

# Install the latest Node LTS without root, via a version manager. Uses whichever the user
# already has (fnm, or nvm if that's what they have); if neither, bootstraps fnm — the lighter,
# cross-platform option. Returns non-zero if it couldn't.
install_node_lts() {
  # Prefer a version manager that's already installed.
  if command -v fnm >/dev/null 2>&1; then
    fnm_install_lts
    return
  fi
  if load_nvm; then
    echo "Installing the latest Node LTS via nvm…"
    nvm install --lts && nvm use --lts
    return
  fi

  # Neither is installed. Fetching and running a remote install script is meaningful, so only do
  # it after an explicit yes — and never unprompted in a non-interactive run (CI, curl | bash).
  if [ ! -t 0 ]; then
    return 1
  fi
  read -r -p "No Node version manager found. Install fnm now to set up Node LTS? [y/N] " reply
  case "$reply" in
    [yY]*) ;;
    *) return 1 ;;
  esac
  echo "Installing fnm…"
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$FNM_INSTALL_DIR" || return 1
  export PATH="$FNM_INSTALL_DIR:$PATH"   # make fnm callable in this run; the installer set up future shells
  command -v fnm >/dev/null 2>&1 || return 1
  fnm_install_lts
}

# True (0) when a usable Node is missing or older than we support.
need_node() {
  command -v node >/dev/null 2>&1 || return 0
  [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MIN_MAJOR" ]
}

if need_node; then
  if command -v node >/dev/null 2>&1; then
    echo "job-hunter needs Node $NODE_MIN_MAJOR or newer (found $(node -v))."
  else
    echo "Node.js is required but was not found."
  fi
  if install_node_lts && ! need_node; then
    echo "Using $(node -v)."
  else
    echo "Couldn't set up a compatible Node automatically." >&2
    echo "Install Node 24 (see .nvmrc) from $NODE_DOWNLOAD_URL and re-run ./install.sh" >&2
    exit 1
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Note: Node 24 is recommended (see .nvmrc) — you're on $(node -v). Continuing…"
fi

echo "Installing dependencies…"
npm install

echo "Running setup…"
npm run setup

# Only prompt when stdin is a terminal — a piped install (e.g. curl | bash) has no TTY, and `read`
# would either hang or read nothing. In that case skip the offers; both can be enabled later.
if [ -t 0 ]; then
  echo
  read -r -p "Add a 'job-hunter' command to your PATH (so you can skip 'npm run cli --')? [y/N] " reply
  case "$reply" in
    [yY]*) ./command-install.sh ;;
    *) echo "Skipped. You can add it later with ./command-install.sh" ;;
  esac

  echo
  read -r -p "Keep the dashboard running in the background (start at login)? [y/N] " reply
  case "$reply" in
    [yY]*) ./service-install.sh ;;
    *) echo "Skipped. You can enable it later with ./service-install.sh" ;;
  esac
else
  echo "To add a 'job-hunter' command to your PATH, run ./command-install.sh"
  echo "To keep the dashboard running in the background, run ./service-install.sh"
fi
