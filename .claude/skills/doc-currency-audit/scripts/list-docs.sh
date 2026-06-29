#!/usr/bin/env bash
# List the repo's user-facing documentation: top-level README/INSTALL/usage-style files,
# plus everything under docs/. Excludes design/plan/spec scratch (those are dev history,
# not user docs the audit needs to keep current). Prints "path<TAB>lines" for each.
#
# Usage: list-docs.sh [repo-dir]
set -euo pipefail

repo_dir="${1:-$PWD}"
cd "$repo_dir"

emit() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  printf '%s\t%s\n' "$f" "$(wc -l < "$f" | tr -d ' ')"
}

# Top-level user-facing docs.
for f in README.md INSTALL.md INSTALLATION.md CONTRIBUTING.md; do
  emit "$f"
done

# docs/ tree, but skip dev-only scratch (plans, specs, handoff, exploration notes).
if [[ -d docs ]]; then
  find docs -name '*.md' -type f \
    ! -path '*/superpowers/*' \
    ! -path '*/plans/*' \
    ! -path '*/specs/*' \
    ! -name 'handoff-*' \
    ! -name '*-exploration.md' \
    | sort | while read -r f; do emit "$f"; done
fi
