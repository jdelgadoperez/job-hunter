# Getting started

This walks you from a fresh install to your first ranked list of jobs. It takes about ten minutes,
most of which is the first search running.

## 1. Install the prerequisites

<!-- SCREENSHOT: terminal after a successful install -->

You need [Node.js](https://nodejs.org) (version 22 or newer; version 24 is recommended). That is
the only thing to install manually — everything else is handled for you.

Once you have Node.js, run the one-step installer from the repo folder:

**macOS or Linux:**
```bash
./install.sh
```

**Windows 11+ (PowerShell):**
```powershell
./install.ps1
```

The installer runs `npm install`, downloads the browser the tool uses to read company career pages
(Chromium), builds the web dashboard, and seeds the skill dictionary. It is safe to run more than
once.

## 2. Add your resume

The installer will ask for your resume during setup. If you skipped that step, or want to update
your resume later, run:

```bash
npm run cli -- profile ./resume.pdf
```

Your resume can be a `.pdf`, `.docx`, `.md`, or `.txt` file. This extracts your skills and stores
them locally — your file never leaves your machine.

Setup also asks whether to add an Anthropic API key. With a key, your matches are scored by Claude
for a much better fit; without one, a free offline scorer is used. You can add a key later — see the
[FAQ](./faq.md#scoring).

## 3. Run your first search

```bash
npm run cli -- scan
```

<!-- SCREENSHOT: a scan running in the terminal -->

This reads the company directory, fetches each company's open roles, and scores them against your
resume. A company that fails to load is skipped with a warning — the search still finishes.

## 4. See your matches

The quickest way is the dashboard:

```bash
npm run cli -- serve
```

<!-- SCREENSHOT: the dashboard Matches tab with results -->

Open the address it prints (usually <http://localhost:4317>). Or list them right in the terminal:

```bash
npm run cli -- list
```

The list defaults to matches scoring 50 or higher, highest score first.

## What's next

- Your list empty or shorter than expected? → [Understanding your matches](./understanding-matches.md)
- Want a tour of the dashboard? → [Using the dashboard](./using-the-dashboard.md)
