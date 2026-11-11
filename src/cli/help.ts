import { style } from "./style";

/** A documented command, used to render both the global summary and its detailed `--help` page. */
type CommandHelp = {
  /** The bare command word, e.g. "track" — also the `--help` topic that selects this page. */
  name: string;
  /** Invocation shown in the global command list, e.g. "list [--min-score N]". */
  invocation: string;
  /** One-line summary for the global command list. */
  summary: string;
  /** Longer description shown on the command's own help page. */
  details?: string;
  /** Options / subcommands as [token, description] rows. */
  options?: [string, string][];
  /** Heading for the `options` block; defaults to "OPTIONS". */
  optionsLabel?: string;
  examples?: string[];
};

export const COMMANDS: CommandHelp[] = [
  {
    name: "scan",
    invocation: "scan [--retry-failed] [-a|--all] [--freshness-hours N]",
    summary: "Discover and store new postings (free heuristic scoring)",
    details:
      "Reads the public job directory plus any tracked companies, stores postings with a free heuristic score, and expires roles that have gone offline. Run `score` afterward for LLM scoring. Defaults to an incremental scan that skips companies scanned recently.",
    options: [
      [
        "--retry-failed",
        "Rescan only companies that have failed to fetch on several consecutive scans (the 'needs attention' list), instead of the full directory. Note: when a remote feed is configured, the feed is scoped to these needs-attention companies once the shared worker emits company ids.",
      ],
      [
        "-a, --all",
        "Rescan every company, ignoring the freshness window (default: skip recently-scanned ones).",
      ],
      [
        "--freshness-hours N",
        "Skip companies scanned within the last N hours (default: the scanFreshnessHours setting).",
      ],
    ],
    examples: ["job-hunter scan", "job-hunter scan --retry-failed", "job-hunter scan --all"],
  },
  {
    name: "score",
    invocation:
      "score [--min-heuristic N] [-l|--limit N] [--remote|--no-remote] [--rescore] [--dry-run] [--json]",
    summary: "LLM-score the best postings from the last scan",
    details:
      "Ranks stored postings by their heuristic score, batch-triages titles with the LLM, then deep-scores the survivors. Bounded by --min-heuristic (floor) and --limit (cap). Use --dry-run to preview the plan and estimated cost without spending.",
    options: [
      [
        "--min-heuristic N",
        "Only consider postings scoring at least N heuristically (default 30).",
      ],
      ["-l, --limit N", "Deep-score at most N postings (default 100)."],
      ["--remote / --no-remote", "Override the saved remote-only filter for this run."],
      ["--rescore", "Re-score postings already LLM-scored in a prior run."],
      ["--dry-run", "Print the plan + estimated cost and exit without calling the LLM."],
      ["--json", "Output the score run summary as JSON (machine-readable)."],
    ],
    examples: ["job-hunter score --dry-run", "job-hunter score --limit 50 --remote"],
  },
  {
    name: "config",
    invocation: "config remote <on|off>",
    summary: "Persist the remote-only filter setting",
    details:
      "Saves the remote-only preference applied by `score` (overridable per-run with --remote/--no-remote).",
    optionsLabel: "SUBCOMMANDS",
    options: [["remote <on|off>", "Enable or disable the remote-only filter."]],
    examples: ["job-hunter config remote on"],
  },
  {
    name: "list",
    invocation:
      "list [--min-score N] [--remote-only] [--country CC] [--only-applied] [--include-applied] [--json]",
    summary: "Show stored matches (default min score 50)",
    details:
      "Prints stored matches, highest score first. Expired and dismissed postings are hidden.",
    options: [
      ["--min-score N", "Only show matches scoring at least N (default 50)."],
      ["--remote-only", "Only show roles detected as remote."],
      [
        "--country CC",
        "Only show roles in the given country, plus roles whose country couldn't be determined.",
      ],
      [
        "--only-applied",
        "Show only roles you've marked applied (including ones that have since expired).",
      ],
      ["--include-applied", "Also include applied roles, which are hidden by default."],
      ["--json", "Output matches as a JSON array (machine-readable; diagnostics go to stderr)."],
    ],
    examples: ["job-hunter list", "job-hunter list --min-score 70 --remote-only"],
  },
  {
    name: "app",
    invocation: "app <add|list|view|status|note|…> …",
    summary: "Track the jobs you've applied to",
    details:
      "Tracks applications through their lifecycle (applied → screened → interviewed → offered, or rejected / ghosted / withdrawn) with dated notes. Marking a match applied in the dashboard creates one automatically. <company|id> matches a company name (case-insensitive, partial) or an application id; ambiguous names list the ids to use. Statuses: applied, screened, interviewed, offered, rejected, ghosted, withdrawn.",
    optionsLabel: "SUBCOMMANDS",
    options: [
      [
        "add <company> <role> [--url U] [--source S] [--salary S] [--recruiter R] [--date D] [--posting ID] [--json]",
        "Record an application (--date defaults to today; --posting links a stored match).",
      ],
      ["list [status] [--archived] [--json]", "List active (or archived) applications."],
      ["view <company|id> [--archived] [--json]", "Show one application with its notes."],
      ["status <company|id> <status> [--date D]", "Move to a new status (logged as a note)."],
      ["note <company|id> <text…> [--date D]", "Add a dated note."],
      [
        "edit <company|id> [--company --role --url --source --salary --recruiter --date]",
        "Change fields (an empty value clears an optional field).",
      ],
      ["search <term> [--json]", "Search every field and note, archived included."],
      ["stats [--archived] [--json]", "Counts by status."],
      ["archive [company|id]", "Archive a closed application; with no argument, list candidates."],
      ["unarchive <company|id>", "Restore an archived application."],
      ["remove <company|id>", "Delete an application and its notes."],
      ["docs <company|id> [--json]", "List an application's documents (notes and files)."],
      ["doc <company|id> <name>", "Print a note's markdown (e.g. to pipe into another tool)."],
      [
        "import-docs <folder> [--into <company|id>] [--overwrite]",
        "Attach prep docs: each company folder of a job-hunt checkout (incl. archive/) goes to the application with that company name; --into imports one folder into a chosen application. .md/.txt become editable notes; other files are copied under the data dir's docs/. Safe to re-run.",
      ],
      [
        "import [path]",
        "Import from the old jt tracker's database (default ~/.jobtrack/jobtrack.db or $JOBTRACK_DB). Safe to re-run.",
      ],
    ],
    examples: [
      'job-hunter app add Acme "Senior Engineer" --url https://acme.com/jobs/1',
      "job-hunter app status acme screened",
      'job-hunter app note acme "Recruiter call Tuesday"',
      "job-hunter app list interviewed",
      "job-hunter app import",
      "job-hunter app import-docs ~/code/job-hunt",
      "job-hunter app doc solace prep.md",
    ],
  },
  {
    name: "serve",
    invocation: "serve [-p|--port N] [--no-open] [--refresh-hours N]",
    summary: "Start the local web dashboard (recommended)",
    details: "Starts the local web dashboard — the recommended way to use the tool.",
    options: [
      ["-p, --port N", "Port to listen on (default 48373)."],
      ["--no-open", "Don't open a browser window automatically."],
      ["--refresh-hours N", "Re-scan every N hours in the background (default 6, 0 disables)."],
    ],
    examples: ["job-hunter serve", "job-hunter serve --port 8080 --no-open"],
  },
  {
    name: "service",
    invocation: "service <install|uninstall|start|stop|restart|status>",
    summary: "Keep the dashboard running in the background (at login)",
    details:
      "Runs the dashboard as a per-user background service so it starts at login and survives closing the terminal — no admin rights required. Uses launchd on macOS and Task Scheduler on Windows under the hood. `install` sets it up (and starts it now); `status` shows whether it's running plus recent logs.",
    optionsLabel: "SUBCOMMANDS",
    options: [
      ["install", "Set up the service and start it now (runs at every login)."],
      ["uninstall", "Remove the service (stops keeping the dashboard running)."],
      ["start", "Start the service now."],
      ["stop", "Stop the service now."],
      ["restart", "Restart the service now (stop then start)."],
      ["status", "Show whether the dashboard is running, plus recent log lines."],
    ],
    examples: ["job-hunter service install", "job-hunter service status"],
  },
  {
    name: "profile",
    invocation: "profile <resume-file>",
    summary: "Build your skill profile from a resume",
    details:
      "Parses a resume (.txt, .md, .pdf, or .docx) into the skill profile that scoring is based on.",
    examples: ["job-hunter profile ~/resume.pdf"],
  },
  {
    name: "track",
    invocation: "track <add|list|remove> …",
    summary: "Track companies alongside the directory",
    details: "Manage companies scanned alongside the public directory.",
    optionsLabel: "SUBCOMMANDS",
    options: [
      ["add <url> [-n, --name <name>]", "Track a company by its careers-page URL."],
      ["list", "List tracked companies."],
      ["remove <url>", "Stop tracking a company."],
    ],
    examples: [
      "job-hunter track add https://boards.greenhouse.io/acme --name Acme",
      "job-hunter track list",
    ],
  },
];

/** Command words recognized as `--help` topics (also accepted as `job-hunter help <topic>`). */
export const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));

const INVOCATION_WIDTH = 38;

function row(token: string, description: string): string {
  // ANSI codes don't occupy columns, so styling the (padded) token keeps the layout aligned.
  // A token wider than the column would collide with its description, so wrap it to the next line.
  if (token.length >= INVOCATION_WIDTH) {
    return `  ${style.bold(token)}\n  ${" ".repeat(INVOCATION_WIDTH)}${description}`;
  }
  return `  ${style.bold(token.padEnd(INVOCATION_WIDTH))}${description}`;
}

// A drawn bow loosing an arrow — the "hunt" in job-hunter. Pure 7-bit ASCII so it renders on any
// default terminal, light or dark; color is applied per line in `banner()`.
// biome-ignore format: one row per line keeps the ASCII art legible
const BOW = [
  "|\\",
  "| \\",
  "|  >>------------------>",
  "| /",
  "|/",
];

/** The bow-and-arrow banner: bow limbs dimmed, the arrow in the success accent so it pops. */
function banner(): string {
  return BOW.map((line) => {
    const arrow = line.indexOf(">>");
    if (arrow === -1) return style.dim(line);
    return style.dim(line.slice(0, arrow)) + style.success(line.slice(arrow));
  }).join("\n");
}

/** The global help: banner, title, command list, top-level options, and a per-command help pointer. */
function globalHelp(): string {
  const lines = [
    banner(),
    "",
    style.bold("job-hunter") + style.dim(" — a local-first job-search engine"),
    "",
    style.bold("USAGE"),
    `  ${style.bold("job-hunter <command> [options]")}`,
    "",
    style.bold("COMMANDS"),
    ...COMMANDS.map((c) => row(c.invocation, c.summary)),
    "",
    style.bold("OPTIONS"),
    row("-h, --help", "Show help (use `job-hunter <command> --help` for a command)"),
    row("-v, --version", "Print the installed version"),
    row("--verbose", "Verbose diagnostic logging to stderr (also enabled by DEBUG=job-hunter*)."),
    "",
    style.dim("Run `job-hunter serve` for the web dashboard — the recommended experience."),
  ];
  return lines.join("\n");
}

/** A single command's detailed help page. */
function commandHelp(cmd: CommandHelp): string {
  const lines = [
    style.bold("USAGE"),
    `  ${style.bold(`job-hunter ${cmd.invocation}`)}`,
    "",
    cmd.details ?? cmd.summary,
  ];
  if (cmd.options?.length) {
    lines.push("", style.bold(cmd.optionsLabel ?? "OPTIONS"));
    for (const [token, description] of cmd.options) lines.push(row(token, description));
  }
  if (cmd.examples?.length) {
    lines.push("", style.bold("EXAMPLES"));
    for (const example of cmd.examples) lines.push(`  ${style.dim(example)}`);
  }
  return lines.join("\n");
}

/**
 * Render help text. With no topic (or an unknown one) returns the global overview; with a known
 * command name returns that command's detailed page.
 */
export function renderHelp(topic?: string): string {
  const cmd = topic ? COMMANDS.find((c) => c.name === topic) : undefined;
  return cmd ? commandHelp(cmd) : globalHelp();
}
