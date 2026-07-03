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
    invocation: "scan [--retry-failed] [--all] [--freshness-hours N]",
    summary: "Discover and store new postings (free heuristic scoring)",
    details:
      "Reads the public job directory plus any tracked companies, stores postings with a free heuristic score, and expires roles that have gone offline. Run `score` afterward for LLM scoring. Defaults to an incremental scan that skips companies scanned recently.",
    options: [
      [
        "--retry-failed",
        "Rescan only companies that have failed to fetch on several consecutive scans (the 'needs attention' list), instead of the full directory. Note: when a remote feed is configured, the feed is scoped to these needs-attention companies once the shared worker emits company ids.",
      ],
      [
        "--all",
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
      "score [--min-heuristic N] [--limit N] [--remote|--no-remote] [--rescore] [--dry-run]",
    summary: "LLM-score the best postings from the last scan",
    details:
      "Ranks stored postings by their heuristic score, batch-triages titles with the LLM, then deep-scores the survivors. Bounded by --min-heuristic (floor) and --limit (cap). Use --dry-run to preview the plan and estimated cost without spending.",
    options: [
      [
        "--min-heuristic N",
        "Only consider postings scoring at least N heuristically (default 30).",
      ],
      ["--limit N", "Deep-score at most N postings (default 100)."],
      ["--remote / --no-remote", "Override the saved remote-only filter for this run."],
      ["--rescore", "Re-score postings already LLM-scored in a prior run."],
      ["--dry-run", "Print the plan + estimated cost and exit without calling the LLM."],
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
      "list [--min-score N] [--remote-only] [--country CC] [--only-applied] [--include-applied]",
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
    ],
    examples: ["job-hunter list", "job-hunter list --min-score 70 --remote-only"],
  },
  {
    name: "serve",
    invocation: "serve [--port N] [--no-open] [--refresh-hours N]",
    summary: "Start the local web dashboard (recommended)",
    details: "Starts the local web dashboard — the recommended way to use the tool.",
    options: [
      ["--port N", "Port to listen on (default 4317)."],
      ["--no-open", "Don't open a browser window automatically."],
      ["--refresh-hours N", "Re-scan every N hours in the background (default 6, 0 disables)."],
    ],
    examples: ["job-hunter serve", "job-hunter serve --port 8080 --no-open"],
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
      ["add <url> [--name <name>]", "Track a company by its careers-page URL."],
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
