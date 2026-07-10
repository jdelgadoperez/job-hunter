# Node.js CLI Apps Best Practices — Audit Checklist

Source: https://github.com/lirantal/nodejs-cli-apps-best-practices (raw README, `main` branch)

> Note: the repo's marketing copy claims "41 best practices," but the current README content
> enumerates 33 numbered items across 10 substantive categories (plus two appendix sections
> of reference tables/links, not actionable practices). All 33 are captured below.

---

## 1. Command Line Experience

### 1.1 Respect POSIX args
- **Category:** Command Line Experience
- **Recommends:** Use POSIX-compliant argument syntax — `[]` for optional / `<>` for required operands, short-form single-letter aliases (`-h`) for long-form flags (`--help`), single-dash grouping (`-abc` = `-a -b -c`). For small/medium CLIs, start with `node:util`'s `parseArgs()` before adding a dependency; reach for `commander`/`yargs`/`Optique` when you need subcommands, generated help, or shell completion.
- **Why it matters:** Power users expect Unix-standard conventions; deviating causes friction and confusion.
- **How to verify:** Run the CLI's `--help`; confirm long flags have short aliases where sensible, optional vs. required args are notated consistently, and grouped short flags (`-abc`) work if applicable. Check the arg-parsing implementation (`parseArgs`, `commander`, `yargs`, etc.) rather than hand-rolled `process.argv` splitting.

### 1.2 Build empathic CLIs
- **Category:** Command Line Experience
- **Recommends:** Put workflows in place (e.g., interactive prompts) that help the user recover from missing/invalid input rather than just erroring out — but only when the invocation is actually interactive (see 3.5); in CI/non-interactive contexts, fail fast with an actionable message.
- **Why it matters:** Lack of actionable assistance causes frustration and abandoned interactions.
- **How to verify:** Invoke a command missing a required argument in an interactive terminal — confirm it prompts instead of just erroring. Run the same command with stdin/stdout piped or `CI=true` set — confirm it fails fast with a clear message instead of hanging on a prompt.

### 1.3 Stateful data
- **Category:** Command Line Experience
- **Recommends:** Persist user settings/state (tokens, preferences) between invocations using a config helper that follows the XDG Base Directory Specification (e.g., `configstore`, `conf`).
- **Why it matters:** Forcing users to re-supply the same info every invocation is annoying.
- **How to verify:** Check whether the CLI writes config/state files, and confirm the location respects `XDG_CONFIG_HOME`/`XDG_DATA_HOME` (or platform equivalents) rather than hardcoding a path.

### 1.4 Provide a colorful experience
- **Category:** Command Line Experience
- **Recommends:** Use color to highlight output, but degrade gracefully (auto-detect unsupported terminals) and support manual opt-in/opt-out via CLI flag, env var, and/or config. Prefer `styleText()` from `node:util` on modern Node; use `chalk`/`kleur`/`picocolors` for older Node or richer theming.
- **Why it matters:** Colorless-but-text-heavy output loses information; but colored output can garble unsupported terminals, CI logs, or IDE consoles.
- **How to verify:** Run with `NO_COLOR=1` and confirm color codes are suppressed. Run with `FORCE_COLOR=1` piped to a file and confirm color is forced if that's the documented behavior. Pipe output to a file/non-TTY and confirm no raw ANSI escape codes leak into non-interactive output by default.

### 1.5 Rich interactions
- **Category:** Command Line Experience
- **Recommends:** Use richer prompt types (dropdowns, radio, autocomplete, hidden password input) instead of only free text, plus progress bars/spinners for async work (`@inquirer/prompts`, `ora`, `ink`, `prompts`). Don't force interaction for values the CLI can infer itself.
- **Why it matters:** Free-text prompts are cumbersome for closed-option data; unnecessary prompts slow down users who don't need them.
- **How to verify:** Trigger a prompt that has a fixed set of valid answers — confirm it's a select/dropdown, not free text. Confirm long-running async operations show a spinner/progress indicator. Confirm no prompt appears for a value the CLI could auto-detect or default.

### 1.6 Hyperlinks everywhere
- **Category:** Command Line Experience
- **Recommends:** Emit properly formatted, clickable terminal hyperlinks for URLs and file:line:column references (e.g., via `open` package for opening links), not raw shortened/non-interactive text.
- **Why it matters:** Broken/non-interactive links (e.g., `git.io/abc`) force manual copy-paste.
- **How to verify:** In a hyperlink-capable terminal (iTerm2, modern VS Code terminal), check that output URLs and file references are OSC-8 hyperlinks (clickable), not plain text requiring copy/paste.

### 1.7 Zero configuration
- **Category:** Command Line Experience
- **Recommends:** Auto-detect config/args where reliably possible (e.g., standard env vars like `TMPDIR`, `NO_COLOR`, `DEBUG`, `HTTP_PROXY`) rather than forcing interactive setup, prompting for confirmation only when necessary.
- **Why it matters:** A "works out of the box" experience reduces friction; unnecessary interactivity blocks automation and annoys users.
- **How to verify:** Run the CLI fresh with no config file and no flags — confirm it does something sensible by default rather than erroring or demanding setup. Confirm it recognizes standard POSIX env vars where applicable.

### 1.8 Respect POSIX signals
- **Category:** Command Line Experience
- **Recommends:** Handle POSIX signals (especially `SIGINT`/Ctrl+C) properly so the process terminates or cleans up correctly, including when orchestrated non-interactively (e.g., inside Docker).
- **Why it matters:** Failing to handle signals breaks interop with shells, orchestrators, and users hitting Ctrl+C; especially bad in containerized/automated contexts.
- **How to verify:** Start a long-running command and send `SIGINT` (Ctrl+C) — confirm it exits promptly and cleans up (temp files, connections) rather than hanging or ignoring the signal. Test the same inside a Docker container sending `docker stop`.

### 1.9 Provide helpful help
- **Category:** Command Line Experience
- **Recommends:** Support `-h`/`--help`; show help automatically when a command can't run meaningfully without args; give each subcommand its own contextual help (e.g., `my-cli deploy --help`); include usage, options (required vs optional), and concrete examples; print a clear message on conflicting/invalid args pointing to help; consider man pages for mature CLIs.
- **Why it matters:** Undiscoverable behavior forces users to read source or search external docs for things that should be surfaced at the command line.
- **How to verify:** Run `cli --help` and `cli -h` — confirm both work and show usage + options + examples. Run a subcommand with `--help` (e.g., `cli deploy --help`) — confirm subcommand-specific help, not the global help. Run the bare command with no args — confirm it shows help if it can't run meaningfully without them. Pass a conflicting/invalid flag combo — confirm the error names the conflict and points to help.

---

## 2. Distribution

### 2.1 Prefer a small dependency footprint
- **Category:** Distribution
- **Recommends:** Minimize production dependencies (including transitive), favor smaller alternatives, but avoid reinventing the wheel excessively. Use tools like Bundlephobia to check cost.
- **Why it matters:** Large dependency trees slow `npm install`, which is especially painful for `npx`-invoked CLIs that always fetch fresh from the registry.
- **How to verify:** Run `npm ls --prod --all | wc -l` or check Bundlephobia/`npm view <pkg> dependencies` for the package. Time a fresh `npx <cli>` install. Compare against reasonable alternatives for heavy deps.

### 2.2 Use the shrinkwrap, Luke
- **Category:** Distribution
- **Recommends:** Use `npm-shrinkwrap.json` (or an equivalent committed lockfile) to pin dependency versions — direct and transitive — that propagate to end users on install, accepting the tradeoff that you now own timely security updates. Alternative: bundle deps via `@vercel/ncc` with deps declared as `devDependencies`.
- **Why it matters:** Unpinned transitive dependencies can introduce breaking or malicious changes outside your control on user installs.
- **How to verify:** Check for `npm-shrinkwrap.json` in the published package (`npm pack --dry-run` or inspect the tarball) vs. only `package-lock.json` (which doesn't propagate to consumers). Confirm a maintenance process exists for keeping shrinkwrapped deps patched for security.

### 2.3 Cleanup configuration files
- **Category:** Distribution
- **Recommends:** Provide an explicit uninstall path (e.g., `--uninstall` flag or interactive prompt) that removes persisted config files, since npm ≥7 dropped uninstall hooks. Optionally prompt to keep config for reinstall convenience.
- **Why it matters:** Otherwise uninstalling the CLI leaves orphaned config/data files and potentially identifiable data on the user's filesystem.
- **How to verify:** Check whether the CLI writes persistent state (per 1.3) and, if so, whether an explicit `--uninstall` command or documented cleanup step exists and actually removes those files.

---

## 3. Interoperability

### 3.1 Accept input as STDIN
- **Category:** Interoperability
- **Recommends:** For data-processing CLIs, support piped STDIN input (e.g., via `node:readline`) as an alternative to `--file` flags, enabling standard Unix pipelines (`curl ... | my-cli`).
- **Why it matters:** Without STDIN support, other CLI tools can't feed data directly into yours, breaking common one-liners.
- **How to verify:** Run `echo "test data" | my-cli` (or `cat file.json | my-cli`) and confirm it processes the piped input rather than requiring a `--file` flag.

### 3.2 Enable structured output
- **Category:** Interoperability
- **Recommends:** Provide a flag (commonly `--json`) to emit machine-parseable structured output instead of/alongside human-formatted text.
- **Why it matters:** Without it, users resort to fragile regex parsing of human-oriented output.
- **How to verify:** Run `my-cli <command> --json` and confirm the output is valid, parseable JSON (`| jq .` succeeds) with no extraneous human-formatted text mixed in.

### 3.3 Cross-platform etiquette
- **Category:** Interoperability
- **Recommends:** Avoid Windows-breaking patterns: don't spawn shebang scripts directly (`spawn('node', [cliExecPath])` not `spawn(cliExecPath, [])`); quote `package.json` scripts with escaped double quotes, not single quotes; use `path.join()` instead of manual `${dir}/...` string concatenation; avoid `;` command chaining in shell strings — use `&&`/`||`.
- **Why it matters:** Functionally correct code can still break on Windows due to shell/path/spawn semantics differences, even with no logic bugs.
- **How to verify:** Grep the codebase for manual path concatenation (`` `${__dirname}/... ` ``) vs. `path.join`/`path.resolve`. Check `package.json` scripts for single-quoted glob args. Check `child_process.spawn`/`exec` calls for shebang-script direct invocation or `;`-chained commands. If feasible, run the CLI/tests on Windows or in a Windows CI job.

### 3.4 Support configuration precedence
- **Category:** Interoperability
- **Recommends:** Resolve configuration in a fixed precedence order: CLI args > shell/env vars > project-scope config file > user-scope config file (e.g., `~/.config/<app>/config` per XDG) > system-scope config (e.g., `/etc/<app>`). Consider `cosmiconfig` for config file discovery.
- **Why it matters:** Without a documented, predictable precedence, users can't reliably override settings.
- **How to verify:** Set a value via env var, project config, and CLI flag simultaneously (differing values) — confirm the CLI flag wins, then env var, then project config, matching documented precedence.

### 3.5 Gate interactive behavior
- **Category:** Interoperability
- **Recommends:** Only prompt when connected to an interactive TTY (`process.stdin.isTTY && process.stdout.isTTY`), not in CI (check `CI` env var) or when piped; provide an explicit `--no-input`-style opt-out; fail fast with an actionable message (naming the flag/env var/config to use) when a required value is missing and prompting isn't safe.
- **Why it matters:** Otherwise the CLI can hang indefinitely in CI/cron/pipelines, or misinterpret piped STDIN data as a typed prompt answer.
- **How to verify:** Run a command requiring input with `CI=true` set and no TTY (e.g., via `| cat` or in a CI runner) — confirm it fails fast with an actionable error rather than hanging waiting for a prompt. Confirm a `--no-input`/`--non-interactive` flag exists and is honored.

### 3.6 Distinguish STDOUT from STDERR
- **Category:** Interoperability
- **Recommends:** Send primary command output (the actual data/result) to STDOUT (`process.stdout.write`/`console.log`); send diagnostics — progress, warnings, debug logs, prompts, errors — to STDERR (`process.stderr.write`/`console.error`). Critical when combined with `--json` output (3.2) so `my-cli --json | jq` stays valid.
- **Why it matters:** Mixing diagnostics into STDOUT corrupts piped/parsed output for downstream consumers (JSON parsers, scripts).
- **How to verify:** Run `my-cli --json 2>/dev/null | jq .` and confirm it parses cleanly (no diagnostic text leaked into STDOUT). Run with `--verbose` and confirm progress/debug messages appear on STDERR (`my-cli --verbose 1>/dev/null` should still show them).

### 3.7 Provide shell completion
- **Category:** Interoperability
- **Recommends:** For CLIs with subcommands/many flags/dynamic values, offer opt-in shell completion (e.g., `my-cli completion bash > ...`) generated from the same command/flag definitions used for parsing and help, supporting Bash/Zsh/Fish/PowerShell as documented. Completion candidate output goes to STDOUT, diagnostics to STDERR. Never mutate shell rc files (`.bashrc`, `.zshrc`) automatically from install scripts — require an explicit, documented, reversible setup step.
- **Why it matters:** Without completion, users must memorize flags or repeatedly check `--help`; auto-mutating shell profiles is invasive and hard to reverse.
- **How to verify:** Check for a `completion`/`autocomplete` subcommand or documented setup steps. Confirm it doesn't write to `.bashrc`/`.zshrc`/PowerShell profiles automatically during `npm install`. Source the generated completion script and confirm tab-completion works for subcommands/flags.

---

## 4. Accessibility

### 4.1 Containerize the CLI
- **Category:** Accessibility
- **Recommends:** Publish a Docker image (e.g., to Docker Hub) so users without a Node.js toolchain (`npm`/`npx`) can still run the CLI, especially relevant for general-audience tools or CI/build environments lacking Node.
- **Why it matters:** Requiring `npm`/`npx` excludes users and environments without a Node.js toolchain installed.
- **How to verify:** Check for a published Dockerfile/image on Docker Hub (or GHCR, etc.) and confirm `docker run <image> --help` works without any local Node install.

### 4.2 Graceful degradation
- **Category:** Accessibility
- **Recommends:** Let users opt out of color/animation/interactive-rich display in unsupported terminals — auto-detect terminal capability at runtime, and/or provide an explicit opt-in flag (e.g., `--json`) to force plain/raw output. Useful for both unsupported terminals and CI.
- **Why it matters:** Rich terminal features (color, ASCII art, animated prompts) can render as garbled or non-functional text on unsupported terminals, deterring users.
- **How to verify:** Run in a minimal/dumb terminal (`TERM=dumb`) or non-TTY context and confirm output degrades to plain readable text, not garbled escape sequences. Confirm `--json` or similar forces raw output regardless of terminal capability.

### 4.3 Node.js versions compatibility
- **Category:** Accessibility
- **Recommends:** Target actively supported/maintained Node.js versions (per the official release schedule); don't hobble the codebase to support EOL versions — if old-version support is genuinely required, use a transpiler (e.g., Babel) or offer a containerized alternative (4.1) instead. If run on an unsupported runtime, detect it and print a friendly, informative error rather than a cryptic crash.
- **Why it matters:** Supporting unmaintained/EOL Node versions increases maintenance burden and forfeits language/runtime improvements; unhandled version mismatches produce confusing crashes.
- **How to verify:** Check `package.json` `engines.node` field is set and matches actively maintained LTS/current versions. Run the CLI under an unsupported Node version and confirm it prints a clear compatibility error rather than an obscure syntax/runtime crash.

### 4.4 Shebang autodetect the Node.js runtime
- **Category:** Accessibility
- **Recommends:** Use `#!/usr/bin/env node` in the CLI entry point (not a hardcoded path like `#!/usr/local/bin/node`), so the runtime is located dynamically per-environment.
- **Why it matters:** Hardcoded interpreter paths are specific to the author's machine and break on other systems where Node lives elsewhere.
- **How to verify:** `head -1` the CLI's bin entry file and confirm it reads `#!/usr/bin/env node`.

---

## 5. Testing

### 5.1 Put no trust in locales
- **Category:** Testing
- **Recommends:** Don't hardcode expected output strings (e.g., `expect(output).to.contain("Examples:")`) in tests if the CLI's argument-parsing library can localize output — the same output could read differently on non-English-locale test machines.
- **Why it matters:** Locale-dependent string assertions cause flaky/failing tests on systems with different default locales.
- **How to verify:** Search the test suite for string-literal assertions against CLI output text; run the test suite with `LANG`/`LC_ALL` set to a non-English locale and confirm no locale-driven output text is being asserted against verbatim (assert on locale-independent signals — exit codes, JSON structure, message codes — instead).

---

## 6. Errors

### 6.1 Trackable errors
- **Category:** Errors
- **Recommends:** Emit error messages with a lookup-able error code (e.g., `Error (E4002): ...`), analogous to HTTP status codes, documented in project docs, ideally extended with structured detail for parsing.
- **Why it matters:** Generic, code-less error messages are hard to search for solutions to and hard to reference in documentation.
- **How to verify:** Trigger a known failure mode and confirm the error message includes a distinct, documented error code, not just free-text prose. Cross-check the code appears in project docs.

### 6.2 Actionable errors
- **Category:** Errors
- **Recommends:** Error messages should state what fix is needed, not just that something failed (e.g., "please provide an API token via environment variables" rather than "invalid config").
- **Why it matters:** Users facing an error with no hint of the required fix may be unable to proceed at all.
- **How to verify:** Trigger several distinct error conditions and check each message tells the user the concrete next step (which flag/env var/file to provide/fix), not just "error occurred."

### 6.3 Provide debug mode
- **Category:** Errors
- **Recommends:** Support extended debug verbosity via env var and/or CLI flag (e.g., the `debug` npm package convention `DEBUG=my-cli:* my-cli ...`), with debug statements placed at points that aid diagnosing program flow, inputs/outputs.
- **Why it matters:** Without debug output, it's harder for users and maintainers to diagnose problems or for maintainers to collect useful bug reports.
- **How to verify:** Run with `DEBUG=*` (or the documented equivalent, `--verbose`/`--debug`) and confirm detailed diagnostic output appears that isn't present in normal runs.

### 6.4 Proper use of exit codes
- **Category:** Errors
- **Recommends:** Terminate with semantically meaningful exit codes: `0` = success, `1` (or other nonzero) = failure, with `process.exit(<code>)` called explicitly on error paths (after cleanup); document any custom codes.
- **Why it matters:** Missing/incorrect exit codes break shell (`$?`) and CI pipeline logic that depends on them to detect success/failure.
- **How to verify:** Run a successful command and check `echo $?` is `0`. Trigger a failure and check `echo $?` is nonzero. If custom exit codes are used, confirm they're documented.

### 6.5 Effortless bug reports
- **Category:** Errors
- **Recommends:** Make filing a bug report low-friction — provide a direct URL to open an issue, prepopulated with relevant data where possible (e.g., via GitHub issue templates).
- **Why it matters:** Without an easy path to file bugs, users get frustrated hunting for how to report and either give up or file low-quality reports.
- **How to verify:** Check for a "report a bug" URL/prompt surfaced on crash/error, and check the repo for GitHub issue templates (`.github/ISSUE_TEMPLATE/`).

---

## 7. Development

### 7.1 Use a bin object
- **Category:** Development
- **Recommends:** Define the executable name/path via the `bin` object in `package.json` (`"bin": { "myCli-is-cool": "./bin/myCli.js" }`), decoupling the invocable command name from the package name and file location.
- **Why it matters:** Using a bare `bin` string couples the executable's name to the package name; an object lets you name it independently and even ship multiple binaries.
- **How to verify:** Inspect `package.json`'s `bin` field — confirm it's an object (or at least intentionally named) mapping command name(s) to entry file path(s), not accidentally derived from the package name.

### 7.2 Use relative paths
- **Category:** Development
- **Recommends:** Use `process.cwd()` for paths relative to where the user invoked the CLI (e.g., user-supplied `--outfile` paths); use `__dirname` for paths relative to the CLI's own source location (e.g., bundled data files).
- **Why it matters:** Confusing the two (or using neither) leads to incorrect file paths and failed file access, especially once installed globally (where `cwd` and install dir differ).
- **How to verify:** Grep for `process.cwd()` and `__dirname`/`import.meta.url` usage — confirm user-input-relative paths use `cwd()` and internal/bundled-asset paths use `__dirname`-relative resolution. Test running the installed (not dev) CLI from an arbitrary directory and confirm file resolution still works.

### 7.3 Use the `files` field
- **Category:** Development
- **Recommends:** Set `package.json`'s `files` field to include only what's needed at runtime (e.g., `"files": ["src", "!src/**/*.spec.js"]`), excluding tests/dev configs from the published tarball.
- **Why it matters:** Without it, the published package bloats with unnecessary files (tests, dev config), increasing install size/time.
- **How to verify:** Run `npm pack --dry-run` (or inspect the published tarball) and confirm no test files, dev configs, or other non-runtime files are included.

---

## 8. Analytics

### 8.1 Strict Opt-in Analytics
- **Category:** Analytics
- **Recommends:** Any usage/telemetry collection must require explicit, informed opt-in — never silent "phone home" by default. Disclose what data is collected, what it's used for, and how/where/how long it's stored (cf. Angular CLI, Next.js telemetry as reference implementations).
- **Why it matters:** Silent data collection without consent violates user privacy expectations and trust, and surprises users with unexpected network behavior.
- **How to verify:** Fresh-install the CLI and run it with network monitoring (or check source for telemetry calls) — confirm no analytics/telemetry payloads are sent before the user has explicitly opted in via a prompt, flag, or documented config. Check for a documented privacy/data-collection policy.

---

## 9. Versioning

### 9.1 Include a `--version` Flag
- **Category:** Versioning
- **Recommends:** Support `--version` (and conventionally `-V` as the short flag) to print the version (and optionally build info) to stdout and exit.
- **Why it matters:** Without it, users can't identify which version they're running, complicating update tracking and bug reports.
- **How to verify:** Run `my-cli --version` and `my-cli -V` — confirm both print a version string and exit cleanly (exit code 0).

### 9.2 Use Semantic Versioning
- **Category:** Versioning
- **Recommends:** Follow SemVer (`MAJOR.MINOR.PATCH`) so version bumps convey the nature/impact of changes.
- **Why it matters:** Non-SemVer versioning leaves users unable to infer whether an update is safe, feature-adding, or breaking.
- **How to verify:** Check `package.json` version and changelog/release history for SemVer compliance — breaking changes bump MAJOR, features bump MINOR, fixes bump PATCH.

### 9.3 Provide Version Information in a 'package.json' file
- **Category:** Versioning
- **Recommends:** Keep the canonical version in `package.json`'s `version` field, using `npm version`/`yarn version` tooling to automate bumps rather than manual edits.
- **Why it matters:** A single source of truth for version reduces drift and human error; automation reduces mistakes in the release process.
- **How to verify:** Confirm `package.json` has a `version` field and check whether releases are tagged via `npm version` (or equivalent automated tooling like changesets/release-please) rather than hand-edited.

### 9.4 Display Version in Error Messages and Help Text
- **Category:** Versioning
- **Recommends:** Surface the running version in error output and/or `--help` text so bug reports and support requests naturally include it.
- **Why it matters:** Without version context in error/help output, debugging and support are harder — users may not think to separately run `--version`.
- **How to verify:** Trigger an error and check whether the version appears in the output (or is referenced/encouraged, e.g., "please include output of `my-cli --version`"). Check `--help` output for a version line.

### 9.5 Backward Compatibility
- **Category:** Versioning
- **Recommends:** Preserve backward compatibility across upgrades where feasible; when removing/changing functionality, document deprecation clearly (print a `DEPRECATED:` message pointing to migration docs) ahead of removal.
- **Why it matters:** Breaking changes without warning frustrate users and hinder adoption/upgrades.
- **How to verify:** Check the changelog for deprecation notices preceding removals (not simultaneous). Run a deprecated feature/flag and confirm it prints a `DEPRECATED:`-style warning with a link/pointer to the replacement, rather than silently changing behavior or erroring outright.

### 9.6 Publish Versioned Releases on npm
- **Category:** Versioning
- **Recommends:** Publish tagged, versioned releases to npm so users can install specific historical versions.
- **Why it matters:** Without versioned publishes, users can't pin to or roll back to a known-good version for compatibility/troubleshooting.
- **How to verify:** Run `npm view <package> versions` and confirm multiple historical versions are published and installable (`npm install <package>@<old-version>`).

### 9.7 Update Your App's Version Documents
- **Category:** Versioning
- **Recommends:** Maintain clear release notes/changelog per version documenting changes, enhancements, and fixes.
- **Why it matters:** Without changelogs, users can't assess whether/why to upgrade, leading to confusion or unnecessary caution.
- **How to verify:** Check for a `CHANGELOG.md` (or GitHub Releases notes) updated alongside each version bump, with entries describing user-facing changes.

---

## 10. Security

### 10.1 Minimize Argument Injection
- **Category:** Security
- **Recommends:** Carefully scope which CLI arguments/flags are exposed and what system operations they can trigger; avoid enabling sensitive operations (arbitrary file read/write, command execution) via loosely-validated user-supplied arguments. Be wary of arguments that get passed through to subprocess commands (e.g., `git`) where crafted flags (e.g., leading `--`/`-`) can be interpreted as options rather than data.
- **Why it matters:** Argument injection lets attackers craft input that gets parsed as unintended flags/commands by an underlying tool the CLI shells out to, leading to unauthorized file access or command execution (real-world CVEs cited: git-interface, git-pull-or-clone, ungit, simple-git, Blamer).
- **How to verify:** Audit all `child_process.exec`/`spawn`/`execFile` calls that incorporate user input — confirm arguments are passed as an array (not a concatenated shell string) and that a `--` separator is used before user-controlled positional values passed to underlying CLIs (e.g., `git`) to prevent flag injection. Test passing a value starting with `-` or `--` where user input is expected and confirm it's treated as literal data, not parsed as a flag by the wrapped command.

---

## Appendices (reference only, not actionable practices)

- **11. CLI Frameworks and Tools** — reference tables of frameworks (`oclif`, `yargs`, `@inquirer/prompts`, `ink`, `pastel`, `blessed`, `prompts`, `vue-termui`, `clack`, `Optique`, etc.) and supporting tools (`VHS`, `@oclif/plugin-autocomplete`, `tabtab`). Not a practice to audit against — useful only as a "does this CLI reinvent something a standard library already solves" cross-check.
- **12. CLI educational resources** — links to clig.dev, primer.style/cli, and a "crafting human-friendly CLIs" workshop. Not actionable practices.

---

## Quick audit checklist (condensed)

| # | Practice | Pass/Fail |
|---|----------|-----------|
| 1.1 | POSIX-style args, short+long flag aliases | |
| 1.2 | Empathic recovery prompts, gated to interactive contexts | |
| 1.3 | Persisted state via XDG-compliant config helper | |
| 1.4 | Color with graceful degradation + `NO_COLOR`/opt-out | |
| 1.5 | Rich prompts (select/autocomplete) + spinners for async | |
| 1.6 | Clickable terminal hyperlinks (URLs, file:line) | |
| 1.7 | Zero-config defaults / standard env var auto-detection | |
| 1.8 | SIGINT/POSIX signal handling, incl. in containers | |
| 1.9 | `-h`/`--help`, subcommand help, examples, conflict errors | |
| 2.1 | Small dependency footprint | |
| 2.2 | `npm-shrinkwrap.json` or equivalent pinned lockfile | |
| 2.3 | Explicit `--uninstall`/cleanup path for config files | |
| 3.1 | STDIN piping support | |
| 3.2 | `--json`/structured output flag | |
| 3.3 | Cross-platform spawn/path/quoting/chaining safety | |
| 3.4 | Documented config precedence (args > env > project > user > system) | |
| 3.5 | TTY/CI-gated prompting + `--no-input` opt-out | |
| 3.6 | STDOUT for data, STDERR for diagnostics | |
| 3.7 | Shell completion command, generated from parser definitions | |
| 4.1 | Docker image published | |
| 4.2 | Terminal-capability degradation / forced plain output | |
| 4.3 | `engines.node` targets maintained versions; friendly error on unsupported runtime | |
| 4.4 | `#!/usr/bin/env node` shebang | |
| 5.1 | No locale-dependent string assertions in tests | |
| 6.1 | Trackable, documented error codes | |
| 6.2 | Actionable error messages (state the fix) | |
| 6.3 | Debug mode via env var/flag | |
| 6.4 | Correct process exit codes (0 success / nonzero failure) | |
| 6.5 | Low-friction bug report path (issue templates, prefilled URL) | |
| 7.1 | `bin` object in `package.json` | |
| 7.2 | Correct `process.cwd()` vs `__dirname` usage | |
| 7.3 | `files` field excludes non-runtime files | |
| 8.1 | Analytics strictly opt-in, disclosed | |
| 9.1 | `--version`/`-V` flag | |
| 9.2 | SemVer versioning | |
| 9.3 | Version tracked in `package.json`, automated bumps | |
| 9.4 | Version surfaced in errors/help | |
| 9.5 | Backward compatibility + deprecation warnings | |
| 9.6 | Versioned releases published to npm | |
| 9.7 | Maintained changelog/release notes | |
| 10.1 | Argument injection hardening (array-form spawn, `--` separator) | |
