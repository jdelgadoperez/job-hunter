import { type ParseArgsConfig, parseArgs } from "node:util";
import { DEFAULT_MIN_HEURISTIC, DEFAULT_SCORE_LIMIT } from "@app/matching/score-defaults";
import { COMMAND_NAMES } from "./help";
import { isServiceAction, SERVICE_ACTIONS, type ServiceAction } from "./service";

/** Default minimum match score for `list` when `--min-score` is omitted. */
export const DEFAULT_MIN_SCORE = 50;
// The `score` defaults live in `@app/matching/score-defaults` so the server shares them; re-exported
// here for the CLI's existing importers.
export { DEFAULT_MIN_HEURISTIC, DEFAULT_SCORE_LIMIT };

export type Command =
  | { kind: "scan"; retryFailed: boolean; all: boolean; freshnessHours?: number }
  | { kind: "serve"; port?: number; open: boolean; refreshHours?: number }
  | { kind: "track-add"; url: string; name?: string }
  | { kind: "track-list" }
  | { kind: "track-remove"; url: string }
  | { kind: "profile"; resumePath: string }
  | {
      kind: "list";
      minScore: number;
      remoteOnly: boolean;
      country?: string;
      includeApplied: boolean;
      onlyApplied: boolean;
    }
  | {
      kind: "score";
      minHeuristic: number;
      limit: number;
      remoteOnly?: boolean;
      rescore: boolean;
      dryRun: boolean;
    }
  | { kind: "config-remote"; on: boolean }
  | { kind: "service"; action: ServiceAction }
  | { kind: "version" }
  | { kind: "help"; error?: string; topic?: string };

type SafeParseResult<T extends ParseArgsConfig> =
  | { ok: true; value: ReturnType<typeof parseArgs<T>> }
  | { ok: false; error: string };

/**
 * `node:util`'s `parseArgs` throws a raw `TypeError` (e.g. `ERR_PARSE_ARGS_UNKNOWN_OPTION`) on an
 * unrecognized flag or a dash-leading positional. The CLI never wants that to escape `parseCli` as
 * an uncaught exception — every call site funnels through here so a bad flag becomes a normal
 * `{ kind: "help", error }` result instead of crashing the process. Generic over `T` (mirroring
 * `parseArgs`'s own signature) so callers keep the narrowed `values`/`positionals` types their
 * `options` config implies.
 */
function safeParse<T extends ParseArgsConfig>(config: T): SafeParseResult<T> {
  try {
    return { ok: true, value: parseArgs(config) };
  } catch (err) {
    return { ok: false, error: describeParseError(err) };
  }
}

/**
 * Node's `parseArgs` error message is two sentences: the first names the offending flag (e.g.
 * `Unknown option '--bogus-flag'.`), the second is a "place it at the end after --" escape-hatch
 * hint that's irrelevant to (and confusing for) the common case of a simple typo'd flag. Keep only
 * the first sentence so the error stays a single short clause, consistent with this file's other
 * hand-written errors (`invalid --port: ${value}`, `unknown command: ${command}`).
 */
function describeParseError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const [firstSentence] = err.message.split(". ");
  return firstSentence ?? err.message;
}

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
    case "scan": {
      const parsed = safeParse({
        args: rest,
        options: {
          "retry-failed": { type: "boolean" },
          all: { type: "boolean", short: "a" },
          "freshness-hours": { type: "string" },
        },
        allowPositionals: true,
      });
      if (!parsed.ok) return { kind: "help", error: parsed.error };
      const { values } = parsed.value;
      const freshnessRaw = values["freshness-hours"];
      let freshnessHours: number | undefined;
      if (freshnessRaw !== undefined) {
        const n = Number(freshnessRaw);
        if (!Number.isInteger(n) || n < 0) {
          return { kind: "help", error: `invalid --freshness-hours: ${freshnessRaw}` };
        }
        freshnessHours = n;
      }
      return {
        kind: "scan",
        retryFailed: Boolean(values["retry-failed"]),
        all: Boolean(values.all),
        ...(freshnessHours !== undefined ? { freshnessHours } : {}),
      };
    }

    case "serve": {
      const parsed = safeParse({
        args: rest,
        options: {
          port: { type: "string", short: "p" },
          "no-open": { type: "boolean" },
          "refresh-hours": { type: "string" },
        },
        allowPositionals: true,
      });
      if (!parsed.ok) return { kind: "help", error: parsed.error };
      const { values } = parsed.value;
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
      const parsed = safeParse({
        args: rest,
        options: {
          "min-score": { type: "string" },
          "remote-only": { type: "boolean" },
          country: { type: "string" },
          "include-applied": { type: "boolean" },
          "only-applied": { type: "boolean" },
        },
        allowPositionals: true,
      });
      if (!parsed.ok) return { kind: "help", error: parsed.error };
      const { values } = parsed.value;
      const raw = values["min-score"];
      const minScore = raw === undefined ? DEFAULT_MIN_SCORE : Number(raw);
      return {
        kind: "list",
        minScore: Number.isFinite(minScore) ? minScore : DEFAULT_MIN_SCORE,
        remoteOnly: Boolean(values["remote-only"]),
        ...(values.country ? { country: values.country } : {}),
        includeApplied: Boolean(values["include-applied"]),
        onlyApplied: Boolean(values["only-applied"]),
      };
    }

    case "profile": {
      const parsed = safeParse({ args: rest, allowPositionals: true });
      if (!parsed.ok) return { kind: "help", error: parsed.error };
      const { positionals } = parsed.value;
      const resumePath = positionals[0];
      if (!resumePath) return { kind: "help", error: "profile requires a resume file path" };
      return { kind: "profile", resumePath };
    }

    case "track": {
      const [sub, ...trackRest] = rest;
      if (sub === "list") return { kind: "track-list" };
      if (sub === "add") {
        const parsed = safeParse({
          args: trackRest,
          options: { name: { type: "string", short: "n" } },
          allowPositionals: true,
        });
        if (!parsed.ok) return { kind: "help", error: parsed.error };
        const { positionals, values } = parsed.value;
        const url = positionals[0];
        if (!url) return { kind: "help", error: "track add requires a careers URL" };
        return { kind: "track-add", url, ...(values.name ? { name: values.name } : {}) };
      }
      if (sub === "remove") {
        const parsed = safeParse({ args: trackRest, allowPositionals: true });
        if (!parsed.ok) return { kind: "help", error: parsed.error };
        const { positionals } = parsed.value;
        const url = positionals[0];
        if (!url) return { kind: "help", error: "track remove requires a careers URL" };
        return { kind: "track-remove", url };
      }
      return { kind: "help", error: `unknown track subcommand: ${sub ?? "(none)"}` };
    }

    case "score": {
      const parsed = safeParse({
        args: rest,
        options: {
          "min-heuristic": { type: "string" },
          limit: { type: "string", short: "l" },
          remote: { type: "boolean" },
          "no-remote": { type: "boolean" },
          rescore: { type: "boolean" },
          "dry-run": { type: "boolean" },
        },
        allowPositionals: true,
      });
      if (!parsed.ok) return { kind: "help", error: parsed.error };
      const { values } = parsed.value;
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
        const parsed = safeParse({ args: configRest, allowPositionals: true });
        if (!parsed.ok) return { kind: "help", error: parsed.error };
        const { positionals } = parsed.value;
        const value = positionals[0];
        if (value === "on") return { kind: "config-remote", on: true };
        if (value === "off") return { kind: "config-remote", on: false };
        return { kind: "help", error: `config remote expects on|off, got: ${value ?? "(none)"}` };
      }
      return { kind: "help", error: `unknown config subcommand: ${sub ?? "(none)"}` };
    }

    case "service": {
      const [action] = rest;
      if (action === undefined) {
        return {
          kind: "help",
          error: `service requires an action: ${SERVICE_ACTIONS.join(" | ")}`,
        };
      }
      if (!isServiceAction(action)) {
        return { kind: "help", error: `unknown service action: ${action}` };
      }
      return { kind: "service", action };
    }

    default:
      return command ? { kind: "help", error: `unknown command: ${command}` } : { kind: "help" };
  }
}
