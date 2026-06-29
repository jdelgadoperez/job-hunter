#!/usr/bin/env bash
# Clone (or refresh) a GitHub repo's wiki into a scratch dir and print the path + page list.
# The wiki is a separate git repo at <repo-url>.wiki.git.
#
# Usage: clone-wiki.sh [repo-dir] [dest-dir]
#   repo-dir  defaults to the current directory; must be inside a git repo with a GitHub `origin`.
#   dest-dir  defaults to a temp dir; reused (git pull) if it already holds the wiki clone.
set -euo pipefail

repo_dir="${1:-$PWD}"
dest_dir="${2:-}"

origin_url="$(git -C "$repo_dir" remote get-url origin 2>/dev/null || true)"
if [[ -z "$origin_url" ]]; then
  echo "ERROR: no 'origin' remote found in $repo_dir" >&2
  exit 1
fi

# Derive owner/repo slug for naming + the wiki clone URL.
slug="$(printf '%s' "$origin_url" \
  | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')"
wiki_url="$(printf '%s' "$origin_url" | sed -E 's#\.git$##').wiki.git"

if [[ -z "$dest_dir" ]]; then
  dest_dir="${TMPDIR:-/tmp}/doc-currency-audit/$(printf '%s' "$slug" | tr '/' '-')-wiki"
fi

# Confirm the wiki actually exists (has_wiki + at least one page) before cloning.
if command -v gh >/dev/null 2>&1; then
  has_wiki="$(gh api "repos/$slug" --jq '.has_wiki' 2>/dev/null || echo "unknown")"
  if [[ "$has_wiki" == "false" ]]; then
    echo "NO_WIKI: repos/$slug has_wiki=false" >&2
    exit 2
  fi
fi

if [[ -d "$dest_dir/.git" ]]; then
  git -C "$dest_dir" pull --quiet || true
else
  mkdir -p "$(dirname "$dest_dir")"
  if ! git clone --quiet "$wiki_url" "$dest_dir" 2>/dev/null; then
    echo "NO_WIKI: clone of $wiki_url failed (wiki may be uninitialized)" >&2
    exit 2
  fi
fi

echo "WIKI_DIR=$dest_dir"
echo "WIKI_REMOTE=$wiki_url"
echo "--- pages ---"
find "$dest_dir" -maxdepth 1 -name '*.md' -type f -exec basename {} \; | sort
