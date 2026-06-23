<p align="center">
  <img src="assets/header.jpg" alt="job-hunter" width="100%" height="120" style="object-fit:cover;border-radius:6px">
</p>

# job-hunter

A local-first job-search engine. It discovers open roles from the
[stillhiring.today](https://stillhiring.today) company directory plus any companies you choose to
track, scores each posting against your resume (using Claude, with a free offline fallback), and
saves ranked matches to a local database — all on your own machine.

Today it runs as a command-line tool (`job-hunter scan`) and a local web server (`job-hunter
serve`) that exposes the same data over an HTTP API. A full browser dashboard is on the roadmap
(see [Roadmap](#roadmap)).

> **Privacy:** everything runs locally. Your resume and matches live in a SQLite file on your
> machine; nothing is uploaded anywhere except the job postings you scan and (if you enable LLM
> scoring) the prompts sent to Anthropic's API.

---

## Requirements

- **Node.js 20 or newer** ([nodejs.org](https://nodejs.org)) — the only thing you must install first.
- macOS (Intel or Apple Silicon) or Windows 11+. (Linux works too.)
- *Optional:* an [Anthropic API key](https://console.anthropic.com) for high-quality LLM scoring.
  Without one, job-hunter still works using a free, offline keyword-based scorer.

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
**resume** so you're ready to scan. It's safe to re-run, never blocks, and degrades to free
heuristic scoring if you skip the key.

**Updating:** run `./update.sh` (or `./update.ps1`) to pull the latest version — it preserves your
data and migrates the database automatically, and the dashboard shows an "update available" banner
when you're behind.

👉 **See [INSTALL.md](INSTALL.md)** for the full breakdown — every step the installer performs,
updating, non-interactive/env-var usage, the manual (do-it-by-hand) path, and troubleshooting.

## Usage

Run commands with `npm run cli -- <command>` (the `--` passes flags through):

```bash
npm run cli -- scan                       # discover, score, and store matches (live status)
npm run cli -- serve                       # start the web dashboard (--port N, --no-open, --refresh-hours N)
npm run cli -- list --min-score 70        # show matches scoring 70+
npm run cli -- profile ./resume.pdf       # (re)build your skill profile
npm run cli -- track add https://boards.greenhouse.io/acme --name "Acme"
npm run cli -- track list
npm run cli -- track remove https://boards.greenhouse.io/acme
```

### Web dashboard

`job-hunter serve` (or `npm run serve`) starts a local [Hono](https://hono.dev) server — by
default on <http://localhost:4317> — and opens a React dashboard in your browser:

- **Overview** — upload your resume and run a scan. Scans run as a **background job** with live
  status — an elapsed timer plus a rolling list of the companies being visited (reading directory →
  per-company → scoring) — so you can switch tabs or close the page and it keeps going. The server
  also **auto-refreshes** on a schedule (default every 6h; tune with `--refresh-hours N`, or
  `--refresh-hours 0` to disable).
- **Matches** — ranked postings filtered by a minimum-score slider (default **50**), with the LLM
  rationale and matched/missing skills. **Save** or **dismiss** any match (dismissed ones hide by
  default; toggles reveal expired/dismissed). Scans are **incremental**: postings that vanish from
  their board across consecutive scans are auto-expired and drop off the list, and the **Last scan**
  panel lists the directory delta (companies that appeared / are no longer listed).
- **Skills** — edit the skills on your profile (search the dictionary or add new ones) and manage
  the skill **dictionary** the resume parser recognizes (a broad ~340-term default ships out of the
  box)
- **Companies** — add/remove the companies you track by careers-page URL (scanned alongside the
  public directory)
- **Settings** — Anthropic API key (write-only — never sent back to the browser) and scorer model
  (the company directory is fixed, so it isn't configurable)

The dashboard is a static build (Vite + React + Tailwind + TanStack Query) that the server serves
itself; it's produced by `npm run build:web` (which `npm run setup` runs for you). Everything it
shows comes from the same local HTTP API:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/matches?minScore=` | ranked matches |
| `GET\|POST /api/companies` · `DELETE /api/companies?url=` | tracked companies (add/remove) |
| `GET /api/profile` · `PUT /api/profile/skills` | profile, and direct edits to its skill list |
| `GET\|POST /api/skills` · `DELETE /api/skills/:name` | the skill dictionary |
| `GET\|PUT /api/settings` | settings (the API key is write-only) |
| `POST /api/profile` | upload a resume (`.txt`/`.md`/`.pdf`/`.docx`) or post `{ "resumeText": … }` |
| `POST /api/scan` · `GET /api/scan/status` | start a background scan, then poll its live status |

A typical first run:

```bash
./install.sh                       # or install.ps1 on Windows
npm run serve                      # upload your resume and scan from the dashboard
# — or use the CLI —
npm run cli -- scan
npm run cli -- list --min-score 70
```

See **[docs/usage.md](docs/usage.md)** for the full guide (how scoring works, tracking companies,
refreshing the directory, where your data lives, and troubleshooting).

## Where your data lives

A single SQLite database under your home directory:

- macOS / Linux: `~/.job-hunter/jobhunter.db`
- Windows: `%APPDATA%\job-hunter\jobhunter.db`

Override the location with the `JOB_HUNTER_HOME` environment variable.

## Roadmap

- **Plan 5** ✅ — a local web server (Hono) exposing the data over an API (`job-hunter serve`).
- **Plan 6** ✅ — a browser dashboard (Vite + React + Tailwind + TanStack Query) with resume
  upload, one-click scanning, and match browsing, served as static assets by the Plan 5 server.

Possible next steps: richer match filtering (freshness, skills), inline company add/remove from the
dashboard, and packaging `serve` as a one-command launcher.

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
npm run smoke:scorer      # exercise the live LLM scorer (needs ANTHROPIC_API_KEY)
npm run smoke:scan        # a full live scan against a throwaway database
```

The architecture and design decisions are documented in `docs/superpowers/`.
