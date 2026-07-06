import { describe, expect, it, vi } from "vitest";
import { screenNavigation } from "./playwright-renderer";
import { BlockedUrlError } from "./ssrf-guard";

describe("screenNavigation", () => {
  it("lets a non-navigation sub-resource request through without checking it", async () => {
    const assertAllowed = vi.fn(async () => {});
    const decision = await screenNavigation("https://cdn.example/app.js", false, assertAllowed);
    expect(decision).toBe("continue");
    // Sub-resources are not re-validated — no SSRF check, no per-asset DNS lookup.
    expect(assertAllowed).not.toHaveBeenCalled();
  });

  it("continues a main-frame navigation to an allowed URL", async () => {
    const assertAllowed = vi.fn(async () => {});
    const decision = await screenNavigation("https://boards.example/jobs", true, assertAllowed);
    expect(decision).toBe("continue");
    expect(assertAllowed).toHaveBeenCalledWith("https://boards.example/jobs");
  });

  it("aborts a main-frame navigation that redirects to a blocked internal address", async () => {
    const assertAllowed = vi.fn(async () => {
      throw new BlockedUrlError("host resolves to a blocked address: 169.254.169.254");
    });
    const decision = await screenNavigation(
      "http://169.254.169.254/latest/meta-data",
      true,
      assertAllowed,
    );
    expect(decision).toBe("abort");
  });

  it("rethrows a non-SSRF error rather than silently allowing the navigation", async () => {
    const assertAllowed = vi.fn(async () => {
      throw new Error("unexpected");
    });
    await expect(
      screenNavigation("https://boards.example/jobs", true, assertAllowed),
    ).rejects.toThrow("unexpected");
  });
});
