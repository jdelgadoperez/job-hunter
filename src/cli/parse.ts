import { parseArgs } from "node:util";
import { COMMAND_NAMES } from "./help";

/** Default minimum match score for `list` when `--min-score` is omitted. */
export const DEFAULT_MIN_SCORE = 50;
/** Default heuristic-score floor for `score` gating when `--min-heuristic` is omitted. */
export const DEFAULT_MIN_HEURISTIC = 30;
/** Default cap on postings deep-scored by `score` when `--limit` is omitted. */
export const DEFAULT_SCORE_LIMIT = 100;

export type Command =
  | { kind: "scan" }
  | { kind: "serve"; port?: number; open: boolean; refreshHours?: number }
  | { kind: "track-add"; url: string; name?: string }
  | { kind: "track-list" }
  | { kind: "track-remove"; url: string }
  | { kind: "profile"; resumePath: string }
  | { kind: "list"; minScore: number }
  | {
      kind: "score";
      minHeuristic: number;
      limit: number;
      remoteOnly?: boolean;
      rescore: boolean;
      dryRun: boolean;
    }
  | { kind: "config-remote"; on: boolean }
  | { kind: "version" }
  | { kind: "help"; error?: string; topic?: string };

/**
 * Pure argv → `Command` parser (no I/O), so dispatch logic is unit-tested without spawning a
 * process. `argv` is the arguments after `node script` (i.e. `process.argv.slice(2)`).
 */
export function parseCli(argv: string[]): Command {
  const [command, ...rest] = argv;

  // Help/version win wherever they appear, so `job-hunter scan --help` shows scan's help rather
  // than running a scan — the behavior people expect from any CLI. The topic is the first
  // recognized command word, so both `track --help` and `help track` reach track's page.
  if (argv.some((a) => a === "-h" || a === "--help" || a === "help")) {
    const topic = argv.find((a) => COMMAND_NAMES.has(a));
    return topic ? { kind: "help", topic } : { kind: "help" };
  }
  if (argv.some((a) => a === "-v" || a === "--version" || a === "version"))
    return { kind: "version" };

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

    case "score": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "min-heuristic": { type: "string" },
          limit: { type: "string" },
          remote: { type: "boolean" },
          "no-remote": { type: "boolean" },
          rescore: { type: "boolean" },
          "dry-run": { type: "boolean" },
        },
        allowPositionals: true,
      });
      const minRaw = values["min-heuristic"];
      const limitRaw = values.limit;
      const minHeuristic = minRaw === undefined ? DEFAULT_MIN_HEURISTIC : Number(minRaw);
      const limit = limitRaw === undefined ? DEFAULT_SCORE_LIMIT : Number(limitRaw);
      if (!Number.isFinite(minHeuristic) || minHeuristic < 0) {
        return { kind: "help", error: `invalid --min-heuristic: ${minRaw}` };
      }
      if (!Number.isInteger(limit) || limit < 1) {
        return { kind: "help", error: `invalid --limit: ${limitRaw}` };
      }
      const cmd: Extract<Command, { kind: "score" }> = {
        kind: "score",
        minHeuristic,
        limit,
        rescore: Boolean(values.rescore),
        dryRun: Boolean(values["dry-run"]),
      };
      // --remote / --no-remote are explicit overrides; absent means "use the saved setting".
      if (values.remote) cmd.remoteOnly = true;
      else if (values["no-remote"]) cmd.remoteOnly = false;
      return cmd;
    }

    case "config": {
      const [sub, ...configRest] = rest;
      if (sub === "remote") {
        const { positionals } = parseArgs({ args: configRest, allowPositionals: true });
        const value = positionals[0];
        if (value === "on") return { kind: "config-remote", on: true };
        if (value === "off") return { kind: "config-remote", on: false };
        return { kind: "help", error: `config remote expects on|off, got: ${value ?? "(none)"}` };
      }
      return { kind: "help", error: `unknown config subcommand: ${sub ?? "(none)"}` };
    }

    default:
      return command ? { kind: "help", error: `unknown command: ${command}` } : { kind: "help" };
  }
}
