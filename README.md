<p align="center">
  <img src="assets/header.jpg" alt="job-hunter" width="100%" style="object-fit:cover;border-radius:6px">
</p>

# job-hunter

A local-first job-search engine. It discovers open roles from the
[stillhiring.today](https://stillhiring.today) company directory, free remote-job feeds, and any
companies you choose to track; ranks every posting against your resume with a **free offline scorer**
(keyword matching — no API key, no cost); and can then **deep-score** the best matches with **Claude
scoring** for a semantic read of the full job description. Ranked matches save to a local database —
all on your own machine.

A search has two steps. **Step 1 — Scan (free):** discover open roles and rank them with the free
offline scorer. **Step 2 — Deep-score (optional, paid):** Claude re-scores your strongest matches
against the full job description and adds a short rationale. Skip step 2 and you stay entirely free.
The primary interface is a local **web dashboard** (`job-hunter serve`) — a React app with light and
dark themes — where you upload your resume, run scans, deep-score with Claude, and browse ranked
matches. A full **command-line tool** drives the same pipeline for scripting and automation. Both
work against the same local database.

> **Privacy:** everything runs locally by default. Your resume and matches live in a SQLite file on
> your machine; nothing is uploaded except the job postings you scan and (if you run `score`) the
> prompts sent to Anthropic's API. An **optional** hosted feed (off unless you configure it) only
> exchanges public job-posting data — your resume and scores never leave your machine.

---

## Requirements

- **Node.js 22 or newer** (24 recommended; see `.nvmrc`) ([nodejs.org](https://nodejs.org)) — the only thing you must install first.
- macOS (Intel or Apple Silicon) or Windows 11+. (Linux works too.)
- *Optional:* an [Anthropic API key](https://console.anthropic.com) for high-quality Claude scoring.
  Without one, job-hunter still works using the free offline scorer (keyword matching).

## Install

The **recommended** way is the one-step installer — run it from the repo folder:

**macOS / Linux**
```bash
./install.sh
```

**Windows 11+ (PowerShell)**
```powershell
./install.ps1
```

It runs `npm install` then guided setup, which: installs Chromium and warms it up, builds the web
dashboard, seeds the skill dictionary, and asks for your **Anthropic API key** (optional) and
**resume** so you're ready to scan. It also offers to add a `job-hunter` command to your PATH (so you
can run `job-hunter <command>` instead of `npm run cli -- <command>`) and to keep the dashboard
running in the background. It's safe to re-run, never blocks, and degrades to the free offline scorer
if you skip the key.

**Updating:** run `./update.sh` (or `./update.ps1`) to pull the latest version — it preserves your
data and migrates the database automatically, and the dashboard shows an "update available" banner
when you're behind.

👉 **See [INSTALL.md](INSTALL.md)** for the full breakdown — every step the installer performs,
updating, non-interactive/env-var usage, the manual (do-it-by-hand) path, and troubleshooting.

## Usage

**The dashboard is the primary way to use job-hunter.** Run `npm run cli -- serve` and open the
local web app to upload your resume, run scans, deep-score with Claude (with a cost preview and live
progress), and browse ranked matches — all point-and-click. The CLI below drives the same pipeline
for scripting, automation, and power users; anything you can do on the dashboard you can also do from
the terminal.

Run CLI commands with `npm run cli -- <command>` (the `--` passes flags through). If you added the
`job-hunter` command to your PATH during setup (or later with `./command-install.sh`), you can drop
the `npm run cli --` prefix and just run `job-hunter <command>` from anywhere — e.g. `job-hunter scan`.
The examples below use the `npm run cli --` form so they work without the shortcut installed.

```bash
npm run cli -- scan                       # discover + free offline score, store matches (live status)
npm run cli -- scan --all                 # rescan every company, ignoring the freshness window
npm run cli -- scan --freshness-hours 6   # only re-visit companies not scanned in the last 6h (0 = re-visit all)
npm run cli -- score --dry-run            # preview the deep-score plan + estimated cost (no spend)
npm run cli -- score --limit 50           # deep-score up to 50 of the best postings not yet scored
npm run cli -- list --min-score 70        # show matches scoring 70+
npm run cli -- list --remote-only         # only remote matches
npm run cli -- list --country US          # only matches in a country (parsed from the posting location)
npm run cli -- list --only-applied        # only roles you've marked applied (include-applied reveals them inline)
npm run cli -- serve                       # start the web dashboard (--port N, --no-open, --refresh-hours N)
npm run cli -- profile ./resume.pdf       # (re)build your skill profile
npm run cli -- track add https://boards.greenhouse.io/acme --name "Acme"
npm run cli -- track list
npm run cli -- track remove https://boards.greenhouse.io/acme
npm run cli -- config remote on           # prefer remote: rank non-remote roles lower (persisted; --remote/--no-remote overrides per run)
npm run cli -- --help                      # full command reference (also `<command> --help`)
npm run cli -- --version
```

**Two-step scanning.** `scan` is free — it discovers postings and ranks them with the free offline
scorer. By default a scan is **incremental**: it re-visits only the companies it hasn't checked
recently — anything scanned within the freshness window (the `scanFreshnessHours` setting, default
**24h**) is skipped — so routine scans stay fast. Companies you track yourself are always scanned.
Force a full re-visit with `scan --all`, or override the window for one run with
`scan --freshness-hours N` (`0` re-visits every company). `score` then spends Claude budget only on
the best of those: it ranks by the offline score, respects `--min-heuristic`, skips postings already
Claude-scored (unless `--rescore`), then caps the remainder at `--limit` — so raising `--limit` adds
more postings to the run, and re-running works down a large backlog. It batch-triages titles,
deep-scores the survivors, and aborts cleanly if it hits your provider usage limit. `score --dry-run`
prints the plan and estimated cost without spending anything.

**Deep-score from the dashboard or the CLI.** The dashboard's "3 · Deep-score with Claude" panel is
the easiest way in — Preview for a cost estimate, a Limit input, Remote-only and Re-score toggles,
and a live progress bar. The `score` command does the same from the terminal. Both share the same
budget-aware pipeline, skip already-scored postings by default, and report live progress as postings
score.

**Remote preference (changed behavior).** With `config remote on`, non-remote postings are no longer
dropped from scoring — they're kept but **ranked lower** (a penalized offline score) and skip the
paid Claude deep-score, so they still appear at the bottom of your matches at no cost. To fully *hide*
non-remote roles, use the **Remote only** toggle in the dashboard Matches view (or `list --remote-only`
on the CLI). "Remote" is read from the ATS feed's structured flag when available and falls back to the
posting's location text otherwise; an unknown location counts as remote so nothing is silently hidden.

### Web dashboard

`job-hunter serve` (or `npm run serve`) starts a local [Hono](https://hono.dev) server — by
default on <http://localhost:48373>, bound to loopback so it isn't reachable from other machines —
and opens a React dashboard in your browser. It has five tabs:

- **Home** — upload your resume, run a scan (incremental by default; **Rescan all** to re-visit
  everything), and deep-score the best matches with Claude — both with live progress.
- **Matches** — your ranked roles, best-first, with a minimum-score slider (default **50**),
  remote/country filters, matched & missing skills, Claude rationales, and save / dismiss /
  mark-applied actions.
- **Skills** — edit the skills on your profile and the skill dictionary the resume parser recognizes.
- **Companies** — add or remove the companies you track by careers-page URL.
- **Settings** — your Anthropic API key, scorer model, home country, scan-freshness window, and
  optional extra feed sources. Secret keys are write-only.

For the full walkthrough of every tab, see the
**[Using the Dashboard](https://github.com/jdelgadoperez/job-hunter/wiki/Using-the-Dashboard)** guide.

### Keep the dashboard always running (optional)

To have the dashboard start automatically at every login — no terminal needed — install it as a
per-user background service (no admin required). One command, same on macOS and Windows:

```bash
job-hunter service install
```

Then manage it with `job-hunter service start` / `stop` / `status` / `uninstall`. The full command
table, how it works (launchd / Task Scheduler), and log locations are in the
**[Using the Dashboard → Keep the dashboard always running](https://github.com/jdelgadoperez/job-hunter/wiki/Using-the-Dashboard#keep-the-dashboard-always-running)**
guide.

The dashboard is a static build (Vite + React + Tailwind + TanStack Query) that the server serves
itself; it's produced by `npm run build:web` (which `npm run setup` runs for you). Everything it
shows comes from the same local HTTP API:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/matches?minScore=` | ranked matches |
| `PUT\|DELETE /api/matches/:id/action` | save / dismiss / mark-applied a match (or clear the action) |
| `GET\|POST /api/companies` · `DELETE /api/companies?url=` | tracked companies (add/remove) |
| `GET /api/companies/manual-review` | directory companies on hosts we don't auto-scan (LinkedIn/Indeed/…) |
| `GET /api/profile` · `PUT /api/profile/skills` | profile, and direct edits to its skill list |
| `GET\|POST /api/skills` · `DELETE /api/skills/:name` | the skill dictionary |
| `GET\|PUT /api/settings` | settings (secret keys are write-only) |
| `POST /api/profile` | upload a resume (`.txt`/`.md`/`.pdf`/`.docx`) or post `{ "resumeText": … }` |
| `POST /api/scan` · `GET /api/scan/status` | start a background scan, then poll its live status |
| `GET /api/scans/latest` | the most recent scan's summary (directory delta, counts) |

A typical first run:

```bash
./install.sh                       # or install.ps1 on Windows
npm run serve                      # upload your resume and scan from the dashboard
# — or use the CLI —
npm run cli -- scan
npm run cli -- list --min-score 70
```

See the **[user guide](https://github.com/jdelgadoperez/job-hunter/wiki)** for the full walkthrough (getting started, how scoring works,
refreshing the directory, where your data lives, and troubleshooting).

## Where your data lives

A single SQLite database under your home directory:

- macOS / Linux: `~/.job-hunter/jobhunter.db`
- Windows: `%APPDATA%\job-hunter\jobhunter.db`

Override the location with the `JOB_HUNTER_HOME` environment variable.

## Status & roadmap

**Shipped:** the web dashboard (resume upload, one-click background scans and in-dashboard
deep-scoring — both with live progress — ranked match browsing with save/dismiss, in-app
skill/dictionary and company editing, and light/dark themes) and a full CLI covering the same
pipeline (`scan`, `score`, `config`, `list`, `profile`, `track`, with colored output and per-command
help) — plus incremental scans with directory diffing and posting expiry, per-posting liveness
re-checks, and smooth in-place updates. Scanning is split into a free `scan` and a budget-aware
`score` (offline-score gate → batch Claude triage → concurrent deep score). Discovery fans out over
multiple lead sources (stillhiring.today, Remotive, and the key-gated The Muse) and resolves 11 ATS
platforms (Greenhouse, Lever, Ashby, Workday, Rippling, Recruitee, SmartRecruiters, BambooHR, UKG,
Breezy, Workable) with a JSON-LD / browser fallback. The lead-source architecture — and how to add a
new one — is documented in [`docs/career-page-resources.md`](docs/career-page-resources.md); Claude
scoring's prompt-cache behavior (and the cache stats shown in `score` output) in
[`docs/prompt-caching.md`](docs/prompt-caching.md).

**Hosted feed (optional, experimental):** a shared sourcing backend (Supabase Postgres + a scheduled
worker) can run the crawl once for everyone and serve a deduplicated posting feed; a client with a
`feedUrl`/`feedKey` configured pulls the feed **and** still crawls its own tracked companies, scoring
locally. See [`docs/sourcing-backend-exploration.md`](docs/sourcing-backend-exploration.md) and
[`docs/backend/`](docs/backend/). A scheduled GitHub Action
([`.github/workflows/scan-worker.yml`](.github/workflows/scan-worker.yml)) runs the crawl on a 6h
cron; it stays dormant until a `DATABASE_URL` Actions secret is configured.

**Possible next steps:** operating/monitoring the hosted worker (it's scheduled but unproven live);
cloud company submission
([planned](docs/superpowers/plans/2026-06-27-cloud-company-submission.md)); richer match filtering
(freshness, skills); more lead sources (Adzuna, USAJobs, HN "Who is Hiring"); and packaging `serve`
as a one-command launcher.

## Development

```bash
npm test            # run the test suite
npm run typecheck   # type-check the server + CLI
npm run typecheck:web  # type-check the web dashboard
npm run lint        # Biome lint + format check
npm run lint:fix    # auto-fix
npm run dev:web     # web dashboard with hot reload (proxies /api to a running `serve`)
npm run build:web   # build the dashboard to web/dist
```

Opt-in, network-bound checks (excluded from CI):

```bash
npm run smoke:airtable    # read the live Airtable share (WRITE_FIXTURE=1 to refresh the fixture)
npm run smoke:scorer      # exercise the live Claude scorer (needs ANTHROPIC_API_KEY)
npm run smoke:scan        # a full live scan against a throwaway database
npm run smoke:postgres    # exercise the hosted Postgres store (needs DATABASE_URL)
```

The hosted scanner worker runs via `npm run scan:worker` (needs `DATABASE_URL`); see
[`docs/backend/worker-runbook.md`](docs/backend/worker-runbook.md). The architecture and design
decisions are documented in `docs/superpowers/`.
