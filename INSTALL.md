# Installing job-hunter

The **recommended** way to install is the one-step script — it installs dependencies and runs
guided setup so you end up ready to scan. Everything it does is plain and re-runnable; the manual
steps are listed at the end if you'd rather do it by hand.

## Prerequisites

- **Node.js 22 or newer** (24 recommended; see `.nvmrc`) ([nodejs.org](https://nodejs.org)). If it's missing or too old, the installer offers to set up the latest LTS for you — using a version manager you already have ([fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm)) on macOS/Linux, or `winget` on Windows — so you can also install it beforehand yourself.
- macOS (Intel or Apple Silicon), Windows 11+, or Linux.
- *Optional:* an [Anthropic API key](https://console.anthropic.com) for high-quality Claude scoring.
  Without one, job-hunter uses the free offline scorer (keyword matching).

> **Windows — don't install the C++ build tools.** If you install Node from nodejs.org by hand,
> leave *"Automatically install the necessary tools for Native Module compilation"* **unchecked**.
> job-hunter's only native dependency (`better-sqlite3`) ships a prebuilt Windows x64 binary, so
> `npm install` compiles nothing. Checking that box makes Node download Chocolatey, Python, and
> several GB of Visual Studio C++ Build Tools you won't use.

## Recommended: the installer

Clone or download this repository, then from its folder run:

**macOS / Linux**
```bash
./install.sh
```

**Windows 11+ (PowerShell)**
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

> By default Windows blocks unsigned local scripts, so a plain `./install.ps1` fails with *"running
> scripts is disabled on this system."* The `-ExecutionPolicy Bypass` above runs the installer for
> that one invocation without changing anything system-wide. To allow local scripts permanently (so
> `update.ps1` and the others just work), run once:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`. See the
> [troubleshooting entry](#windows-running-scripts-is-disabled-on-this-system) for details.

If Node.js is missing or older than 22, the installer first offers to install the latest LTS. On
macOS/Linux it uses whichever version manager you already have — **fnm** or **nvm** — and offers to
install **fnm** (the lighter option) if you have neither; on Windows it uses `winget`. Decline and
it points you at [nodejs.org](https://nodejs.org) instead. It then runs `npm install` and
`npm run setup`.

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
   - your **Anthropic API key** (optional; blank = the free offline scorer),
   - the path to your **resume** (`.pdf` / `.docx` / `.md` / `.txt`; blank to skip),

   then saves them so `scan` works immediately. The job directory itself is the
   community-maintained stillhiring.today table, so there's nothing to configure there.

Setup never hard-fails: network/browser steps degrade to warnings, and skipping the API key just
means the free offline scorer. You can (re)build your profile later with
`npm run cli -- profile <resume>`.

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

### Add a `job-hunter` command (optional)

So you can run `job-hunter <command>` from anywhere instead of `npm run cli -- <command>`, install a
per-user command on your PATH (no admin required). The installer offers this during setup, but if you
declined (or installed non-interactively), run the standalone script any time — it's re-runnable:

**macOS / Linux**
```bash
./command-install.sh
```

**Windows 11+ (PowerShell)**
```powershell
powershell -ExecutionPolicy Bypass -File .\command-install.ps1
```

It symlinks a small wrapper into `~/.local/bin` (macOS/Linux) or writes a shim to
`%USERPROFILE%\.local\bin` and adds it to your user PATH (Windows). If that directory isn't on your
PATH yet, the script adds it — **open a new terminal** afterward so the change takes effect, then run
`job-hunter <command>`. The wrapper runs the checked-out source, so it tracks `git pull` with no
rebuild. Remove it with `./command-uninstall.sh` (or `.ps1`); `npm run cli -- …` keeps working either
way.

> On Windows the shim itself runs with `-ExecutionPolicy Bypass`, so the `job-hunter` command works
> regardless of your execution policy once installed — you only need the `-ExecutionPolicy Bypass`
> prefix above to run `command-install.ps1` itself. (See the
> [execution-policy troubleshooting entry](#windows-running-scripts-is-disabled-on-this-system).)

### Keep the dashboard always running (optional)

To have the dashboard start automatically at every login — no terminal needed —
install it as a per-user background service (no admin required). The same command
works on macOS and Windows:

```bash
job-hunter service install
```

Manage it with `job-hunter service start`, `stop`, `restart`, `status`, and `uninstall`.
`./update.sh` / `./update.ps1` restart the service automatically so updates go
live with no extra steps. See
[Using the Dashboard → Keep the dashboard always running](https://github.com/jdelgadoperez/job-hunter/wiki/Using-the-Dashboard#keep-the-dashboard-always-running)
for the full command table and log locations.

See the **[user guide](https://github.com/jdelgadoperez/job-hunter/wiki)** for the full walkthrough and **[README](README.md)** for an
overview.

## Troubleshooting

- **A scan stalls on "Reading the company directory…"** — the browser likely isn't launching.
  Re-run `npx playwright install chromium chromium-headless-shell` (and `npx playwright install-deps chromium` on Linux).
  Watch the `job-hunter serve` terminal for `[scan] …` lines to see exactly where it's stuck.
- **"No profile yet"** — run `npm run cli -- profile <resume>` (or re-run `npm run setup`).
- **Where your data lives** — a single SQLite file: `~/.job-hunter/jobhunter.db` (macOS/Linux) or
  `%APPDATA%\job-hunter\jobhunter.db` (Windows). Override with `JOB_HUNTER_HOME`.
- **The Node installer (or a `choco` window) started installing Python and Visual Studio Build
  Tools** — that's Node's optional *"tools for Native Module compilation"* step, **not** job-hunter.
  You don't need it: `better-sqlite3` (our only native dependency) installs a prebuilt binary on
  Windows x64, so nothing is compiled. Cancel it and re-run `./install.ps1`. The C++ build tools are
  only a fallback for the rare case where that prebuilt binary can't be downloaded (see the next
  entry).
- **`npm install` failed to build `better-sqlite3` / couldn't fetch its prebuilt binary** — the
  prebuilt download (from GitHub Releases) was likely blocked, e.g. by a corporate proxy. Retry on a
  normal network or run `npm rebuild better-sqlite3`. Only if that keeps failing do you need C++
  build tools — and then just the standalone
  [VS Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
  with the "Desktop development with C++" workload, not the full Visual Studio.
- **The CLI crashed with an error** — it prints a link to file a bug report. You can also open one
  directly at [github.com/jdelgadoperez/job-hunter/issues/new](https://github.com/jdelgadoperez/job-hunter/issues/new);
  the bug-report template asks for `job-hunter --version`, your OS, and your Node version.

### Windows: "running scripts is disabled on this system"

Windows PowerShell's default execution policy (`Restricted`) blocks unsigned local scripts, so
`./install.ps1` fails before it runs a single line:

```
File ...\install.ps1 cannot be loaded because running scripts is disabled on this system.
```

Two ways past it:

- **One run, nothing changed system-wide** (recommended):
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  ```
- **Allow local scripts permanently** (so `update.ps1`, `command-install.ps1`, and the service
  scripts run without the prefix), once per user, no admin needed:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
  ```
  `RemoteSigned` runs local scripts you cloned while still requiring a signature on scripts
  downloaded from the internet. If you got the repo as a **ZIP** from GitHub rather than via
  `git clone`, the extracted `.ps1` files may be marked "downloaded from the internet" and blocked
  even under `RemoteSigned` — clear that mark once with:
  ```powershell
  Get-ChildItem -Recurse -Filter *.ps1 | Unblock-File
  ```
