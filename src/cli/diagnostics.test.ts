import { describe, expect, it, vi } from "vitest";
import { createDiagnostics, debugEnabledFromEnv } from "./diagnostics";

describe("debugEnabledFromEnv", () => {
  it("enables for job-hunter, namespaced, and wildcard DEBUG values", () => {
    expect(debugEnabledFromEnv({ DEBUG: "job-hunter" })).toBe(true);
    expect(debugEnabledFromEnv({ DEBUG: "job-hunter:scan" })).toBe(true);
    expect(debugEnabledFromEnv({ DEBUG: "*" })).toBe(true);
  });

  it("stays disabled when DEBUG is absent or unrelated", () => {
    expect(debugEnabledFromEnv({})).toBe(false);
    expect(debugEnabledFromEnv({ DEBUG: "other-app" })).toBe(false);
  });

  it("honors a comma-separated DEBUG list", () => {
    expect(debugEnabledFromEnv({ DEBUG: "other,job-hunter:scan" })).toBe(true);
    expect(debugEnabledFromEnv({ DEBUG: "foo,bar" })).toBe(false);
  });
});

describe("createDiagnostics", () => {
  it("diag() always writes to the sink", () => {
    const write = vi.fn();
    const d = createDiagnostics({ verbose: false, json: false }, write);
    d.diag("progress");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain("progress");
  });

  it("debug() writes only when verbose is on", () => {
    const off = vi.fn();
    createDiagnostics({ verbose: false, json: false }, off).debug("scan", "hi");
    expect(off).not.toHaveBeenCalled();

    const on = vi.fn();
    createDiagnostics({ verbose: true, json: false }, on).debug("scan", "hi");
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toContain("scan");
    expect(on.mock.calls[0]?.[0]).toContain("hi");
  });

  it("debug() is enabled by a matching DEBUG env var even without --verbose", () => {
    vi.stubEnv("DEBUG", "job-hunter:scan");
    const write = vi.fn();
    createDiagnostics({ verbose: false, json: false }, write).debug("scan", "hi");
    expect(write).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
