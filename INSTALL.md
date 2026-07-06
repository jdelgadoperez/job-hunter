# Installing job-hunter

The **recommended** way to install is the one-step script — it installs dependencies and runs
guided setup so you end up ready to scan. Everything it does is plain and re-runnable; the manual
steps are listed at the end if you'd rather do it by hand.

## Prerequisites

- **Node.js 22 or newer** (24 recommended; see `.nvmrc`) ([nodejs.org](https://nodejs.org)) — the only thing you must install first.
- macOS (Intel or Apple Silicon), Windows 11+, or Linux.
- *Optional:* an [Anthropic API key](https://console.anthropic.com) for high-quality LLM scoring.
  Without one, job-hunter uses a free, offline keyword scorer.

## Recommended: the installer

Clone or download this repository, then from its folder run:

**macOS / Linux**
```bash
./install.sh
```

**Windows 11+ (PowerShell)**
```powershell
./install.ps1
```

The installer runs `npm install` and then `npm run setup`.

## What the installer does

`npm run setup` performs the post-install legwork (it's safe to re-run at any time):

1. **Installs Chromium for Playwright** (`npx playwright install chromium chromium-headless-shell`). A real browser is used
   to read the public company directory and render careers pages that don't expose a JSON API.
2. **Warms up the browser** — launches and closes Chromium once, so its one-time first-run setup
   happens now instead of slowing your first scan. If the browser can't launch, setup says so with
   guidance (rather than letting a later scan stall).
3. **Builds the web dashboard** (`npm run build:web`) so `job-hunter serve` has static assets to serve.
4. **Seeds the skill dictionary** into your local SQLite database (a broad ~340-term default the
   resume parser recognizes; you can edit it later in the dashboard's Skills tab).
5. **Guided config** (interactive) — prompts for:
   - your **Anthropic API key** (optional; blank = free heuristic scoring),
   - the path to your **resume** (`.pdf` / `.docx` / `.md` / `.txt`; blank to skip),

   then saves them so `scan` works immediately. The job directory itself is the
   community-maintained stillhiring.today table, so there's nothing to configure there.

Setup never hard-fails: network/browser steps degrade to warnings, and skipping the API key just
means heuristic scoring. You can (re)build your profile later with `npm run cli -- profile <resume>`.

### Non-interactive install

When stdin isn't a TTY (CI, scripts) or you pass `--yes`, setup doesn't prompt — it reads from
environment variables and defaults:

```bash
ANTHROPIC_API_KEY=sk-... RESUME=/path/to/resume.pdf npm run setup -- --yes
```

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | the Anthropic API key (also honored at scan time as a fallback) |
| `RESUME` | path to the resume to build your profile from |
| `JOB_HUNTER_HOME` | override where the SQLite database and state live |

## Manual install

If you'd rather not use the script:

```bash
npm install
npm run setup            # or run the individual steps below
```

The individual steps `setup` automates:

```bash
npx playwright install chromium chromium-headless-shell   # browser for the directory read + page rendering
npm run build:web                 # build the dashboard
npm run cli -- profile ./resume.pdf   # build your skill profile (seeds skills on first DB use)
```

On Linux, if Chromium fails to launch you may also need its system libraries:

```bash
npx playwright install-deps chromium
```

## Updating

To pull the latest version later, run the updater from the repo folder:

**macOS / Linux**
```bash
./update.sh
```

**Windows 11+ (PowerShell)**
```powershell
./update.ps1
```

It runs `git pull`, refreshes dependencies, and re-runs setup non-interactively (rebuilds the
dashboard, refreshes the browser and skill dictionary). Your saved settings, profile, tracked
companies, and matches are preserved, and the database migrates automatically on next start. The
dashboard also shows an **"update available"** banner when newer commits exist upstream.

## After installing

```bash
npm run serve            # open the web dashboard (http://localhost:48373)
# — or use the CLI —
npm run cli -- scan
npm run cli -- list --min-score 70
```

### Keep the dashboard always running (optional)

To have the dashboard start automatically at every login — no terminal needed —
install it as a per-user background service (no admin required). Same commands on
macOS and Windows:

```bash
./service-install.sh     # macOS/Linux   (or  ./service-install.ps1  on Windows)
```

Manage it with `service-start`, `service-stop`, `service-status`, and
`service-uninstall` (the `.ps1` form on Windows). `./update.sh` / `./update.ps1`
restart the service automatically so updates go live with no extra steps. See the
[README](README.md#keep-the-dashboard-always-running-optional) for the full table
and log locations.

See the **[user guide](https://github.com/jdelgadoperez/job-hunter/wiki)** for the full walkthrough and **[README](README.md)** for an
overview.

## Troubleshooting

- **A scan stalls on "Reading the company directory…"** — the browser likely isn't launching.
  Re-run `npx playwright install chromium chromium-headless-shell` (and `npx playwright install-deps chromium` on Linux).
  Watch the `job-hunter serve` terminal for `[scan] …` lines to see exactly where it's stuck.
- **"No profile yet"** — run `npm run cli -- profile <resume>` (or re-run `npm run setup`).
- **Where your data lives** — a single SQLite file: `~/.job-hunter/jobhunter.db` (macOS/Linux) or
  `%APPDATA%\job-hunter\jobhunter.db` (Windows). Override with `JOB_HUNTER_HOME`.
