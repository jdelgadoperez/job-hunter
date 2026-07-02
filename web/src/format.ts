// Single shared formatter so every user-facing count renders with thousands separators
// (e.g. 10000 → "10,000"). Constructed once — Intl.NumberFormat is comparatively expensive to
// build, cheap to reuse.
const countFormatter = new Intl.NumberFormat("en-US");

/** Format an integer count for display with grouped thousands. */
export function formatCount(value: number): string {
  return countFormatter.format(value);
}
