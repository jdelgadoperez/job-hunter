// Single shared formatter so every user-facing count renders with thousands separators
// (e.g. 10000 → "10,000"). Constructed once — Intl.NumberFormat is comparatively expensive to
// build, cheap to reuse.
const countFormatter = new Intl.NumberFormat("en-US");

/** Format an integer count for display with grouped thousands. */
export function formatCount(value: number): string {
  return countFormatter.format(value);
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

// Descending thresholds: pick the largest unit whose value is >= 1. Seconds under a minute read as
// "just now" rather than a noisy "43 seconds ago".
const RELATIVE_TIME_UNITS: ReadonlyArray<{ seconds: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { seconds: 86_400, unit: "day" },
  { seconds: 3_600, unit: "hour" },
  { seconds: 60, unit: "minute" },
];

/** A human relative time like "2 hours ago" for an ISO timestamp. Returns null for a missing or
 *  unparseable value so callers can omit the label rather than render "Invalid Date". */
export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const elapsedSeconds = Math.round((Date.now() - then) / 1000);
  if (elapsedSeconds < 60) return "just now";
  for (const { seconds, unit } of RELATIVE_TIME_UNITS) {
    if (elapsedSeconds >= seconds) {
      return relativeTimeFormatter.format(-Math.floor(elapsedSeconds / seconds), unit);
    }
  }
  return "just now";
}

/** An absolute, locale-aware timestamp for tooltip/title text (the precise time behind the relative
 *  label). Returns null for a missing or unparseable value. */
export function formatAbsoluteTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}
