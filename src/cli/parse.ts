import { parseArgs } from "node:util";

/** Default minimum match score for `list` when `--min-score` is omitted. */
export const DEFAULT_MIN_SCORE = 50;

export type Command =
  | { kind: "scan" }
  | { kind: "serve"; port?: number; open: boolean; refreshHours?: number }
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

    case "serve": {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: "string" },
          "no-open": { type: "boolean" },
          "refresh-hours": { type: "string" },
        },
        allowPositionals: true,
      });
      const cmd: Extract<Command, { kind: "serve" }> = { kind: "serve", open: !values["no-open"] };

      if (values.port !== undefined) {
        const port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { kind: "help", error: `invalid --port: ${values.port}` };
        }
        cmd.port = port;
      }
      if (values["refresh-hours"] !== undefined) {
        const refreshHours = Number(values["refresh-hours"]);
        if (!Number.isFinite(refreshHours) || refreshHours < 0) {
          return { kind: "help", error: `invalid --refresh-hours: ${values["refresh-hours"]}` };
        }
        cmd.refreshHours = refreshHours;
      }
      return cmd;
    }

    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: { "min-score": { type: "string" } },
        allowPositionals: true,
      });
      const raw = values["min-score"];
      const minScore = raw === undefined ? DEFAULT_MIN_SCORE : Number(raw);
      return { kind: "list", minScore: Number.isFinite(minScore) ? minScore : DEFAULT_MIN_SCORE };
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
  job-hunter serve [--port N] [--no-open] [--refresh-hours N]  Start the local web dashboard
  job-hunter list [--min-score N]      Show stored matches (default min score 50)
  job-hunter profile <resume-file>     Build your skill profile from a resume
  job-hunter track add <url> [--name]  Track a company by careers URL
  job-hunter track list                List tracked companies
  job-hunter track remove <url>        Stop tracking a company`;
