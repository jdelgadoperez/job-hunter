# shellcheck shell=bash
# scripts/service/common.sh
# Shared helpers for the job-hunter dashboard service scripts (macOS). Sourced, not executed.

# LABEL and PLIST are consumed by the scripts that source this file.
# shellcheck disable=SC2034
LABEL="com.job-hunter.dashboard"
# shellcheck disable=SC2034
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required but was not found. Install Node 24 (see .nvmrc) from https://nodejs.org and re-run." >&2
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 22 ]; then
    echo "job-hunter needs Node 22 or newer (found $(node -v)). Install Node 24 (see .nvmrc) from https://nodejs.org and re-run." >&2
    exit 1
  fi
}

repo_dir() {
  # This file lives at <repo>/scripts/service/common.sh
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

data_dir() {
  if [ -n "${JOB_HUNTER_HOME:-}" ]; then
    printf '%s' "$JOB_HUNTER_HOME"
  else
    printf '%s' "$HOME/.job-hunter"
  fi
}

log_file() {
  local dir
  dir="$(data_dir)/logs"
  mkdir -p "$dir"
  printf '%s' "$dir/dashboard.log"
}

node_bin() { command -v node; }

serve_entry() { printf '%s' "$(repo_dir)/src/cli/main.ts"; }
