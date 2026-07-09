# Contributing to job-hunter

Thanks for your interest in improving job-hunter. This is a local-first job-search
engine — a CLI plus a local web dashboard over a shared SQLite database. See
[`README.md`](README.md) for the user-facing guide and [`CLAUDE.md`](CLAUDE.md) for a
tour of the architecture.

## Getting set up

Requires **Node 24** (22+ works; see [`.nvmrc`](.nvmrc)).

```bash
npm install
npm run cli -- --help   # try the CLI
npm run dev:web         # dashboard with hot reload
```

See [`INSTALL.md`](INSTALL.md) for the full install and first-run walkthrough.

## Before you open a pull request

Run the same checks CI runs, in this order:

```bash
npm run lint          # Biome (lint + format) — use `npm run lint:fix` to auto-fix
npm run typecheck     # server + CLI
npm run typecheck:web # web dashboard
npm test              # full unit suite (offline)
npm run test:web      # web dashboard tests
npm run build:web     # dashboard build
```

CI runs `lint → typecheck → typecheck:web → test:coverage → test:web → build:web`. The
coverage gate lives in `vitest.config.ts` (statements 93 / branches 85 / functions 90 /
lines 93) — keep new code green rather than lowering the floor.

## Conventions

- **TypeScript-strict, ESM.** No `!` non-null assertions; avoid type assertions outside
  tests. Prefer clear names over abbreviations.
- **Tests are colocated** (`*.test.ts` next to source) and **offline by design** —
  dependencies are injected and fed fixtures under `__fixtures__/`. Anything
  network- or browser-bound is excluded from the coverage gate and covered only by the
  opt-in `smoke:*` scripts.
- **Failures degrade, never crash.** Discovery and scoring collect `Warning`s and return
  partial results — a single failed company or LLM call must not abort a scan. Preserve
  this when touching the scan pipeline.
- **Formatting** is Biome: 2-space indent, 100-col width, double quotes. Run
  `npm run lint:fix` before committing.

## Commits and pull requests

- Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  (`feat:`, `fix:`, `chore:`, `docs:`, …). Prefer smaller, themed commits over one large
  grouped commit. This format is **enforced**, not just encouraged:
  - A Husky `commit-msg` hook runs [commitlint](https://commitlint.js.org) on every commit
    (installed automatically by `npm install` via the `prepare` script).
  - A CI check lints your **PR title** — because PRs are squash-merged, the title becomes the
    commit on `main`, so it must be a valid Conventional Commit too.
- Keep the PR description focused on **what changed and why** to ease review.
- Update the README, `INSTALL.md`, or `CLAUDE.md` when your change affects user-facing
  behavior or the architecture. This is **enforced**: the `Docs & Wiki` CI check fails a PR
  that touches product source (`src/`, `web/src/`) without also touching a doc surface
  (`README`/`INSTALL`/`CONTRIBUTING`/`CLAUDE` or `docs/**`). If a change genuinely needs no docs
  (a pure refactor, internal plumbing), add the `skip-docs` label or put `[skip docs]` in the PR
  title to bypass it.
- The same check validates the **wiki**. The [user guide wiki](https://github.com/jdelgadoperez/job-hunter/wiki)
  is a *separate* git repo, so it can't be edited in a PR — but CI clones it and fails if any
  `.../wiki/<Page>` link in the repo no longer resolves to a real wiki page or heading. If you
  rename or remove a wiki page, fix the links here (or run `npm run check:wiki-links -- <wiki-dir>`
  locally against a checkout of the wiki repo). Keeping the wiki *content* current is a manual
  review — see the `doc-currency-audit` skill.

## Releases and dependencies

- **Releases are automated** by [release-please](https://github.com/googleapis/release-please).
  You don't bump `package.json` or edit `CHANGELOG.md` by hand — merged Conventional Commits drive
  the next version (`feat:` → minor, `fix:` → patch). The bot opens a "release" PR; merging it tags
  and publishes the GitHub Release. This is the reason the commit format is enforced above.
- **Dependencies are updated by Dependabot** (weekly, for npm packages and GitHub Actions). Its PRs
  use `chore(deps):` / `chore(deps-dev):` prefixes and don't trigger a release on their own.
- **GitHub Actions are pinned to commit SHAs** in `.github/workflows/`, with the version in a
  trailing `# vX.Y.Z` comment. This is a deliberate supply-chain safeguard — don't "simplify" a
  pinned SHA back to a floating tag (`@v4`). Dependabot advances the SHA and the comment together.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
