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
    invocation: "scan",
    summary: "Discover, score, and store new matches",
    details:
      "Reads the public job directory plus any tracked companies, scores every posting against your profile, stores the matches, and expires roles that have gone offline.",
    examples: ["job-hunter scan"],
  },
  {
    name: "list",
    invocation: "list [--min-score N]",
    summary: "Show stored matches (default min score 50)",
    details: "Prints stored matches, highest score first.",
    options: [["--min-score N", "Only show matches scoring at least N (default 50)."]],
    examples: ["job-hunter list", "job-hunter list --min-score 70"],
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
