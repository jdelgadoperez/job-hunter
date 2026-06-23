import { describe, expect, it } from "vitest";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });

  it("rejects with a labeled error when the promise is too slow", async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50));
    await expect(withTimeout(slow, 5, "Airtable read")).rejects.toThrow(
      "Airtable read timed out after 5ms",
    );
  });

  it("propagates the underlying rejection when it loses the race cleanly", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "x")).rejects.toThrow("boom");
  });
});
