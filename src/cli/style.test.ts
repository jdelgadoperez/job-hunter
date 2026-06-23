import { styleText } from "node:util";
import { describe, expect, it } from "vitest";
import { colorize, scoreBadge, shouldColor } from "./style";

describe("shouldColor", () => {
  it("is on for a TTY with no opt-outs", () => {
    expect(shouldColor({}, true)).toBe(true);
  });

  it("is off when stdout isn't a TTY (piped/redirected/tests)", () => {
    expect(shouldColor({}, false)).toBe(false);
    expect(shouldColor({}, undefined)).toBe(false);
  });

  it("honors NO_COLOR and a dumb terminal", () => {
    expect(shouldColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldColor({ TERM: "dumb" }, true)).toBe(false);
  });

  it("honors FORCE_COLOR for non-TTY pipes, but NO_COLOR still wins", () => {
    expect(shouldColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(shouldColor({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(shouldColor({ FORCE_COLOR: "1", NO_COLOR: "1" }, true)).toBe(false);
  });
});

describe("colorize", () => {
  it("returns the text untouched when off", () => {
    expect(colorize("red", "hi", false)).toBe("hi");
  });

  it("delegates to styleText when on", () => {
    // styleText itself suppresses color on a non-TTY stream (as in tests), so we assert the
    // delegation rather than raw escape codes — the runtime TTY gate lives in shouldColor.
    expect(colorize("red", "hi", true)).toBe(styleText("red", "hi"));
    expect(colorize("red", "hi", true)).toContain("hi");
  });
});

describe("scoreBadge", () => {
  it("renders the score in brackets regardless of color", () => {
    // Tests run without a TTY, so output is plain — the label content is what matters.
    expect(scoreBadge(92)).toContain("[92]");
    expect(scoreBadge(60)).toContain("[60]");
    expect(scoreBadge(10)).toContain("[10]");
  });
});
