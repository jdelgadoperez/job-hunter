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
  grouped commit.
- Keep the PR description focused on **what changed and why** to ease review.
- Update the README, `INSTALL.md`, or `CLAUDE.md` when your change affects user-facing
  behavior or the architecture.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
