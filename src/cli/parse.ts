import { parseArgs } from "node:util";

export type Command =
  | { kind: "scan" }
  | { kind: "track-add"; url: string; name?: string }
  | { kind: "track-list" }
  | { kind: "track-remove"; url: string }
  | { kind: "profile"; resumePath: string }
  | { kind: "list"; minScore: number }
  | { kind: "help"; error?: string };

/**
 * Pure argv → `Command` parser (no I/O), so dispatch logic is unit-tested without spawning a
 * process. `argv` is the arguments after `node script` (i.e. `process.argv.slice(2)`).
 */
export function parseCli(argv: string[]): Command {
  const [command, ...rest] = argv;

  switch (command) {
    case "scan":
      return { kind: "scan" };

    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: { "min-score": { type: "string" } },
        allowPositionals: true,
      });
      const raw = values["min-score"];
      const minScore = raw === undefined ? 0 : Number(raw);
      return { kind: "list", minScore: Number.isFinite(minScore) ? minScore : 0 };
    }

    case "profile": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const resumePath = positionals[0];
      if (!resumePath) return { kind: "help", error: "profile requires a resume file path" };
      return { kind: "profile", resumePath };
    }

    case "track": {
      const [sub, ...trackRest] = rest;
      if (sub === "list") return { kind: "track-list" };
      if (sub === "add") {
        const { positionals, values } = parseArgs({
          args: trackRest,
          options: { name: { type: "string" } },
          allowPositionals: true,
        });
        const url = positionals[0];
        if (!url) return { kind: "help", error: "track add requires a careers URL" };
        return { kind: "track-add", url, ...(values.name ? { name: values.name } : {}) };
      }
      if (sub === "remove") {
        const { positionals } = parseArgs({ args: trackRest, allowPositionals: true });
        const url = positionals[0];
        if (!url) return { kind: "help", error: "track remove requires a careers URL" };
        return { kind: "track-remove", url };
      }
      return { kind: "help", error: `unknown track subcommand: ${sub ?? "(none)"}` };
    }

    default:
      return command ? { kind: "help", error: `unknown command: ${command}` } : { kind: "help" };
  }
}

export const USAGE = `job-hunter — local job-search engine

Usage:
  job-hunter scan                      Discover, score, and store matches
  job-hunter list [--min-score N]      Show stored matches
  job-hunter profile <resume-file>     Build your skill profile from a resume
  job-hunter track add <url> [--name]  Track a company by careers URL
  job-hunter track list                List tracked companies
  job-hunter track remove <url>        Stop tracking a company`;
