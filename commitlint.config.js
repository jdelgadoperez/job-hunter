/**
 * Enforces Conventional Commits (https://www.conventionalcommits.org) on local commits via the
 * Husky commit-msg hook. Mirrors the PR-title check in .github/workflows/pr-title.yml so both the
 * squash-merge title and individual commits stay in the format release-please parses.
 */
export default {
  extends: ["@commitlint/config-conventional"],
};
