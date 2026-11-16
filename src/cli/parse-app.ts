import { parseArgs } from "node:util";
import {
  APPLICATION_STATUSES,
  type ApplicationPatch,
  type ApplicationStatus,
} from "@app/applications/model";
import { isIsoDate } from "@app/applications/store";
import { describeParseError } from "./parse-error";

/** `job-hunter app <sub> …` — application tracking (the former `jt` CLI). */
export type AppCommand =
  | {
      sub: "add";
      company: string;
      role: string;
      url?: string;
      source?: string;
      salaryRange?: string;
      recruiter?: string;
      date?: string;
      postingId?: string;
      json: boolean;
    }
  | { sub: "list"; status?: ApplicationStatus; archived: boolean; json: boolean }
  | { sub: "view"; selector: string; archived: boolean; json: boolean }
  | { sub: "status"; selector: string; status: ApplicationStatus; date?: string }
  | { sub: "note"; selector: string; text: string; date?: string }
  | {
      sub: "edit";
      selector: string;
      patch: ApplicationPatch;
    }
  | { sub: "search"; term: string; json: boolean }
  | { sub: "stats"; archived: boolean; json: boolean }
  | { sub: "archive"; selector?: string }
  | { sub: "unarchive"; selector: string }
  | { sub: "remove"; selector: string }
  | { sub: "import"; path?: string }
  | { sub: "export"; archived: boolean; file?: string }
  | { sub: "docs"; selector: string; json: boolean }
  | { sub: "doc"; selector: string; name: string }
  | { sub: "import-docs"; path: string; into?: string; overwrite: boolean };

const APP_SUBCOMMANDS = [
  "add",
  "list",
  "view",
  "status",
  "note",
  "edit",
  "search",
  "stats",
  "archive",
  "unarchive",
  "remove",
  "import",
  "export",
  "docs",
  "doc",
  "import-docs",
] as const;

type Parsed = { values: Record<string, string | boolean | undefined>; positionals: string[] };

function parse(args: string[], options: Record<string, { type: "string" | "boolean" }>): Parsed {
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
    return { values: values as Parsed["values"], positionals };
  } catch (err) {
    throw new AppParseError(describeParseError(err));
  }
}

export class AppParseError extends Error {}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function checkDate(value: string | undefined): string | undefined {
  if (value !== undefined && !isIsoDate(value)) {
    throw new AppParseError(`invalid --date: ${value} (expected YYYY-MM-DD)`);
  }
  return value;
}

function parseStatus(value: string): ApplicationStatus {
  const lower = value.toLowerCase();
  const match = APPLICATION_STATUSES.find((s) => s === lower);
  if (!match) {
    throw new AppParseError(
      `unknown status: ${value} (expected ${APPLICATION_STATUSES.join(" | ")})`,
    );
  }
  return match;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new AppParseError(what);
  return value;
}

/**
 * Parse the arguments after `app`. Pure (no I/O); throws `AppParseError` with a one-line message
 * on bad input, which `parseCli` turns into a help result.
 */
export function parseAppCommand(rest: string[]): AppCommand {
  const [sub, ...args] = rest;
  switch (sub) {
    case "add": {
      const { values, positionals } = parse(args, {
        url: { type: "string" },
        source: { type: "string" },
        salary: { type: "string" },
        recruiter: { type: "string" },
        date: { type: "string" },
        posting: { type: "string" },
        json: { type: "boolean" },
      });
      const company = need(str(positionals[0]), "app add requires <company> <role>");
      const role = need(str(positionals.slice(1).join(" ")), "app add requires <company> <role>");
      const url = str(values.url);
      const source = str(values.source);
      const salaryRange = str(values.salary);
      const recruiter = str(values.recruiter);
      const date = checkDate(str(values.date));
      const postingId = str(values.posting);
      return {
        sub: "add",
        company,
        role,
        ...(url ? { url } : {}),
        ...(source ? { source } : {}),
        ...(salaryRange ? { salaryRange } : {}),
        ...(recruiter ? { recruiter } : {}),
        ...(date ? { date } : {}),
        ...(postingId ? { postingId } : {}),
        json: Boolean(values.json),
      };
    }
    case "list": {
      const { values, positionals } = parse(args, {
        archived: { type: "boolean" },
        json: { type: "boolean" },
      });
      const status = positionals[0] === undefined ? undefined : parseStatus(positionals[0]);
      return {
        sub: "list",
        ...(status ? { status } : {}),
        archived: Boolean(values.archived),
        json: Boolean(values.json),
      };
    }
    case "view": {
      const { values, positionals } = parse(args, {
        archived: { type: "boolean" },
        json: { type: "boolean" },
      });
      return {
        sub: "view",
        selector: need(str(positionals.join(" ")), "app view requires <company|id>"),
        archived: Boolean(values.archived),
        json: Boolean(values.json),
      };
    }
    case "status": {
      const { values, positionals } = parse(args, { date: { type: "string" } });
      const selector = need(str(positionals[0]), "app status requires <company|id> <status>");
      const status = parseStatus(
        need(positionals[1], `a status is required: ${APPLICATION_STATUSES.join(" | ")}`),
      );
      const date = checkDate(str(values.date));
      return { sub: "status", selector, status, ...(date ? { date } : {}) };
    }
    case "note": {
      const { values, positionals } = parse(args, { date: { type: "string" } });
      const selector = need(str(positionals[0]), "app note requires <company|id> <text>");
      const text = need(
        str(positionals.slice(1).join(" ")),
        "app note requires <company|id> <text>",
      );
      const date = checkDate(str(values.date));
      return { sub: "note", selector, text, ...(date ? { date } : {}) };
    }
    case "edit": {
      const { values, positionals } = parse(args, {
        company: { type: "string" },
        role: { type: "string" },
        url: { type: "string" },
        source: { type: "string" },
        salary: { type: "string" },
        recruiter: { type: "string" },
        date: { type: "string" },
      });
      const selector = need(str(positionals.join(" ")), "app edit requires <company|id>");
      const patch: ApplicationPatch = {};
      // Pass-through (not `str`) so an explicit empty value clears an optional field.
      for (const [flag, key] of [
        ["company", "company"],
        ["role", "role"],
        ["url", "url"],
        ["source", "source"],
        ["salary", "salaryRange"],
        ["recruiter", "recruiter"],
      ] as const) {
        const value = values[flag];
        if (typeof value === "string") patch[key] = value;
      }
      const date = checkDate(str(values.date));
      if (date) patch.dateApplied = date;
      if (Object.keys(patch).length === 0) {
        throw new AppParseError(
          "app edit needs at least one of --company --role --url --source --salary --recruiter --date",
        );
      }
      return { sub: "edit", selector, patch };
    }
    case "search": {
      const { values, positionals } = parse(args, { json: { type: "boolean" } });
      return {
        sub: "search",
        term: need(str(positionals.join(" ")), "app search requires <term>"),
        json: Boolean(values.json),
      };
    }
    case "stats": {
      const { values } = parse(args, { archived: { type: "boolean" }, json: { type: "boolean" } });
      return { sub: "stats", archived: Boolean(values.archived), json: Boolean(values.json) };
    }
    case "archive": {
      const { positionals } = parse(args, {});
      const selector = str(positionals.join(" "));
      return { sub: "archive", ...(selector ? { selector } : {}) };
    }
    case "unarchive":
    case "remove": {
      const { positionals } = parse(args, {});
      return {
        sub,
        selector: need(str(positionals.join(" ")), `app ${sub} requires <company|id>`),
      };
    }
    case "import": {
      const { positionals } = parse(args, {});
      const path = str(positionals[0]);
      return { sub: "import", ...(path ? { path } : {}) };
    }
    case "export": {
      const { values } = parse(args, { archived: { type: "boolean" }, file: { type: "string" } });
      const file = str(values.file);
      return { sub: "export", archived: Boolean(values.archived), ...(file ? { file } : {}) };
    }
    case "docs": {
      const { values, positionals } = parse(args, { json: { type: "boolean" } });
      return {
        sub: "docs",
        selector: need(str(positionals.join(" ")), "app docs requires <company|id>"),
        json: Boolean(values.json),
      };
    }
    case "doc": {
      const { positionals } = parse(args, {});
      const selector = need(str(positionals[0]), "app doc requires <company|id> <name>");
      const name = need(
        str(positionals.slice(1).join(" ")),
        "app doc requires <company|id> <name>",
      );
      return { sub: "doc", selector, name };
    }
    case "import-docs": {
      const { values, positionals } = parse(args, {
        into: { type: "string" },
        overwrite: { type: "boolean" },
      });
      const path = need(str(positionals[0]), "app import-docs requires <folder>");
      const into = str(values.into);
      return {
        sub: "import-docs",
        path,
        ...(into ? { into } : {}),
        overwrite: Boolean(values.overwrite),
      };
    }
    default:
      throw new AppParseError(
        sub
          ? `unknown app subcommand: ${sub}`
          : `app requires a subcommand: ${APP_SUBCOMMANDS.join(" | ")}`,
      );
  }
}

/** Whether the parsed app command asked for JSON output (so diagnostics route to stderr). */
export function appWantsJson(cmd: AppCommand): boolean {
  return "json" in cmd && cmd.json;
}
