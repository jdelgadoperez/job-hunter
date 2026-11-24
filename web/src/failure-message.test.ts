import { describe, expect, it } from "vitest";
import { summarizeFailure } from "./failure-message";

const PLAYWRIGHT_MISSING = `browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell
╔═════════════════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.                    ║
║ Please run the following command to download new browsers:              ║
║                                                                         ║
║     npx playwright install                                              ║
╚═════════════════════════════════════════════════════════════════════════╝`;

describe("summarizeFailure", () => {
  it("names a missing scan browser instead of echoing Playwright's banner", () => {
    expect(summarizeFailure(PLAYWRIGHT_MISSING)).toEqual({
      summary: "The scan browser isn't installed.",
      missingBrowser: true,
    });
  });

  it("keeps the first meaningful line of a multi-line message", () => {
    expect(summarizeFailure("\n  HTTP 503 from board feed  \nat fetch (x.ts:1)")).toEqual({
      summary: "HTTP 503 from board feed",
      missingBrowser: false,
    });
  });

  it("strips box-drawing characters and caps the length", () => {
    expect(summarizeFailure("╔══╗ boxed ║").summary).toBe("boxed");
    const long = summarizeFailure("x".repeat(400)).summary;
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
  });
});
