/** The command that installs the browser scans use to render careers pages. */
export const BROWSER_INSTALL_COMMAND = "npx playwright install chromium chromium-headless-shell";

/** Playwright's error when its browser binary is missing — typically after Playwright updated. */
const MISSING_BROWSER = /Executable doesn't exist|browserType\.launch:.*(not found|doesn't exist)/i;

/** Box-drawing characters Playwright uses to frame its install banner. */
const BOX_DRAWING = /[─-╿]+/g;

const MAX_SUMMARY = 160;

export type FailureSummary = {
  /** One readable line for a list row. */
  summary: string;
  /** True when the failure is the scan browser not being installed. */
  missingBrowser: boolean;
};

/**
 * A scan failure message as one readable line. Raw messages can be multi-line tool output — a
 * Playwright install banner drawn in box characters, a stack of paths — which overflows a card.
 * The full text stays available to callers (for a tooltip); this is only what a row shows.
 */
export function summarizeFailure(message: string): FailureSummary {
  if (MISSING_BROWSER.test(message)) {
    return { summary: "The scan browser isn't installed.", missingBrowser: true };
  }
  const firstLine =
    message
      .replace(BOX_DRAWING, " ")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => line.length > 0) ?? message.trim();
  const summary =
    firstLine.length > MAX_SUMMARY
      ? `${firstLine.slice(0, MAX_SUMMARY - 1).trimEnd()}…`
      : firstLine;
  return { summary, missingBrowser: false };
}
