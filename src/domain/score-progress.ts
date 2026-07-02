/** Structured progress emitted as a deep-score runs, so the CLI/terminal and web UI can show live
 * status. Mirrors `scan-progress.ts`: a typed event stream + one shared formatter. */
export type ScoreProgressEvent =
  | { kind: "planning" }
  | { kind: "triaging"; total: number }
  | { kind: "triaged"; kept: number; total: number }
  | { kind: "scoring"; index: number; total: number; title: string }
  | { kind: "done"; deepScored: number };

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** A human-readable one-liner for a deep-score progress event, shared by the terminal logger and UI. */
export function formatScoreProgress(event: ScoreProgressEvent): string {
  switch (event.kind) {
    case "planning":
      return "Planning the deep-score run…";
    case "triaging":
      return `Triaging ${plural(event.total, "title")}…`;
    case "triaged":
      return `Kept ${event.kept} of ${plural(event.total, "title")} after triage`;
    case "scoring":
      return `[${event.index}/${event.total}] ${event.title}`;
    case "done":
      return `Deep-scored ${plural(event.deepScored, "posting")}`;
    default: {
      // Exhaustiveness guard: a new ScoreProgressEvent variant becomes a compile error here rather
      // than silently returning undefined for an unhandled kind.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
