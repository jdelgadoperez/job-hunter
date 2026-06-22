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

Clone or download this repository, then run the one-step installer from its folder:

**macOS / Linux**
```bash
./install.sh
```

**Windows 11+ (PowerShell)**
```powershell
./install.ps1
```

That installs dependencies and runs guided setup. (If you prefer to do it by hand:
`npm install && npm run setup`.)

### What setup does

`npm run setup`:
1. installs Chromium (used to read the public Airtable directory and render careers pages),
2. captures a fresh copy of the company directory,
3. seeds a skills dictionary into your local database,
4. asks for your **Anthropic API key** (optional), the **Airtable directory URL** (a sensible
   default is provided), and your **resume file** — then saves them so you're ready to scan.

Setup is safe to re-run, and it won't block: if you skip the API key you get free heuristic
scoring, and you can build your profile later with `npm run cli profile <resume>`.

## Usage

Run commands with `npm run cli -- <command>` (the `--` passes flags through):

```bash
npm run cli -- scan                       # discover, score, and store matches
npm run cli -- serve                       # start the local web dashboard (--port N, --no-open)
npm run cli -- list --min-score 70        # show matches scoring 70+
npm run cli -- profile ./resume.pdf       # (re)build your skill profile
npm run cli -- track add https://boards.greenhouse.io/acme --name "Acme"
npm run cli -- track list
npm run cli -- track remove https://boards.greenhouse.io/acme
```

### Web dashboard

`job-hunter serve` (or `npm run serve`) starts a local [Hono](https://hono.dev) server — by
default on <http://localhost:4317> — and opens a React dashboard in your browser:

- **Overview** — upload your resume and run a scan with live progress (streamed over
  Server-Sent Events)
- **Matches** — ranked postings filtered by a minimum-score slider, with the LLM rationale and
  matched/missing skills
- **Companies** — the companies you track
- **Settings** — Anthropic API key (write-only — never sent back to the browser), scorer model,
  and Airtable share URL

The dashboard is a static build (Vite + React + Tailwind + TanStack Query) that the server serves
itself; it's produced by `npm run build:web` (which `npm run setup` runs for you). Everything it
shows comes from the same local HTTP API:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/matches?minScore=` | ranked matches |
| `GET /api/companies` | tracked companies |
| `GET /api/profile` · `GET\|PUT /api/settings` | profile and settings (key is write-only) |
| `POST /api/profile` | upload a resume (`.txt`/`.md`/`.pdf`/`.docx`) or post `{ "resumeText": … }` |
| `POST /api/scan` | run a scan, streaming progress over SSE |

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
