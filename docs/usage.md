# job-hunter — Usage Guide

This guide covers day-to-day use of the command-line tool. For install instructions, see the
[README](../README.md).

## Concepts

- **Profile** — your skills, extracted from your resume. Scoring compares postings to this.
- **Directory** — the public [stillhiring.today](https://stillhiring.today) Airtable of companies.
  job-hunter reads it through a real browser (Playwright), exactly as the website does.
- **Tracked companies** — companies you add yourself by careers-page URL, scanned alongside the
  directory.
- **Match** — a posting plus its score (0–100), matched/missing skills, and a short rationale.

## Commands

Invoke with `npm run cli -- <command>`. (The `--` is how npm forwards flags to the tool.)

### `scan`
Discovers companies (the public directory + any you track), fetches each one's open roles, scores
them against your profile, and stores ranked matches. The only prerequisite is a profile (`npm run
setup` or `job-hunter profile <resume>`); the directory is a fixed community resource. Companies
that fail to load become warnings; the scan still finishes and stores everything else.

```bash
npm run cli -- scan
```

### `list`
Shows stored matches, highest score first.

```bash
npm run cli -- list                  # all matches
npm run cli -- list --min-score 70   # only strong matches
```

### `profile`
(Re)builds your skill profile from a resume file (`.pdf`, `.docx`, `.md`, or `.txt`).

```bash
npm run cli -- profile ./resume.pdf
```

### `track`
Manage companies you want scanned in addition to the directory.

```bash
npm run cli -- track add https://boards.greenhouse.io/acme --name "Acme"
npm run cli -- track list
npm run cli -- track remove https://boards.greenhouse.io/acme
```

Greenhouse, Lever, and Ashby careers URLs are read through their public APIs; any other careers
page is rendered in a browser and parsed for embedded job-posting data.

## How scoring works

Each posting gets a 0–100 score, the skills it shares with your profile, the skills it wants that
you're missing, and (with LLM scoring) a one-paragraph rationale.

- **With an Anthropic API key** (set during setup or via the `ANTHROPIC_API_KEY` environment
  variable): postings are scored by Claude for semantic fit. The default model is
  `claude-sonnet-4-6`.
- **Without a key:** a free, offline keyword/heuristic scorer is used. If an LLM call fails for any
  reason, job-hunter automatically falls back to the heuristic and notes it as a warning — a scan
  never crashes over scoring.

## Configuration

Settings live in your local database and can be set during `npm run setup`. The relevant keys:

| Setting | Meaning | Default |
|---|---|---|
| `anthropicApiKey` | Anthropic API key for LLM scoring | unset → heuristic scoring |
| `scorerModel` | Model used for scoring | `claude-sonnet-4-6` |
| `scorerProvider` | LLM provider | `anthropic` |

The `ANTHROPIC_API_KEY` environment variable is honored as a fallback if the setting isn't stored.

The company directory is the community-maintained stillhiring.today table and isn't a setting. For
development you can point at a different shared view with the `AIRTABLE_SHARE_URL` environment
variable.

## Refreshing the company directory snapshot

The repository ships with a captured snapshot of the directory's structure used by the test suite.
To refresh it from the live site (e.g. if the directory's columns change), run:

```bash
WRITE_FIXTURE=1 npm run smoke:airtable
```

This is normally unnecessary — `scan` always reads the directory live; the snapshot only backs the
automated tests.

## Where your data lives

One SQLite file:

- macOS / Linux: `~/.job-hunter/jobhunter.db`
- Windows: `%APPDATA%\job-hunter\jobhunter.db`

Set `JOB_HUNTER_HOME` to relocate it. Delete the file to start fresh.

## Troubleshooting

- **"No profile yet"** — run `npm run cli -- profile <resume>` (or re-run `npm run setup`).
- **Chromium errors / a careers page won't load** — ensure the browser is installed:
  `npx playwright install chromium`. A single company failing is reported as a warning and doesn't
  stop the scan.
- **Scores look shallow / no rationale** — you're on heuristic scoring; add an Anthropic API key
  (re-run setup) for semantic scoring with rationales.
- **Reset everything** — delete the database file listed above and re-run setup.

## Privacy & scope

Everything runs on your machine. The tool reads **public** company directory and careers pages and,
if you enable LLM scoring, sends posting text + your profile to Anthropic's API. It deliberately
does **not** scrape sites like LinkedIn or Indeed (their terms prohibit it and it risks your
accounts).
