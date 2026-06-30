/** Structured progress emitted as a scan runs, so the CLI and web UI can show live status. */
export type ScanProgressEvent =
  | { kind: "directory" }
  | { kind: "leads"; total: number }
  | { kind: "company"; name: string; host?: string; index: number; total: number }
  | { kind: "scoring"; total: number }
  | { kind: "persisting"; total: number }
  | { kind: "recheck"; total: number }
  | { kind: "summary"; count: number };

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** A human-readable one-liner for a progress event, shared by the CLI logger and the UI. */
export function formatProgress(event: ScanProgressEvent): string {
  switch (event.kind) {
    case "directory":
      return "Reading the company directory (this can take ~30s)…";
    case "leads":
      return `Found ${plural(event.total, "company", "companies")} to scan`;
    case "company":
      return `[${event.index}/${event.total}] ${event.name}${event.host ? ` (${event.host})` : ""}`;
    case "scoring":
      return `Scoring ${plural(event.total, "posting")}…`;
    case "persisting":
      return `Saving ${plural(event.total, "posting")}…`;
    case "recheck":
      return `Re-checking ${plural(event.total, "open role")}…`;
    case "summary":
      return `Scanned and scored ${plural(event.count, "posting")}`;
    default: {
      // Exhaustiveness guard: a new ScanProgressEvent variant becomes a compile error here rather
      // than silently returning undefined for an unhandled kind.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
