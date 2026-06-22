import { describe, expect, it } from "vitest";
import { ScanJobManager } from "./scan-job";
import type { ScanRunner } from "./types";

/** A runner whose completion the test controls, to observe the `running` state deterministically. */
function deferredRunner(): {
  runner: ScanRunner;
  resolve: (count: number) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (count: number) => void;
  let reject!: (e: Error) => void;
  const gate = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const runner: ScanRunner = async () => ({ count: await gate, warnings: [] });
  return { runner, resolve, reject };
}

describe("ScanJobManager", () => {
  it("starts idle", () => {
    expect(new ScanJobManager().getStatus().state).toBe("idle");
    expect(new ScanJobManager().isRunning()).toBe(false);
  });

  it("transitions idle → running → done with the final count", async () => {
    const jobs = new ScanJobManager();
    const { runner, resolve } = deferredRunner();

    expect(jobs.start(runner)).toBe(true);
    expect(jobs.getStatus().state).toBe("running");
    expect(jobs.getStatus().startedAt).not.toBeNull();

    resolve(7);
    await new Promise((r) => setTimeout(r, 0));

    const status = jobs.getStatus();
    expect(status.state).toBe("done");
    expect(status.count).toBe(7);
    expect(status.message).toContain("Scanned and scored 7");
    expect(status.finishedAt).not.toBeNull();
  });

  it("transitions to error when the runner rejects", async () => {
    const jobs = new ScanJobManager();
    const { runner, reject } = deferredRunner();
    jobs.start(runner);

    reject(new Error("boom"));
    await new Promise((r) => setTimeout(r, 0));

    const status = jobs.getStatus();
    expect(status.state).toBe("error");
    expect(status.error).toBe("boom");
  });

  it("is single-flight: start() returns false while running", async () => {
    const jobs = new ScanJobManager();
    const { runner, resolve } = deferredRunner();

    expect(jobs.start(runner)).toBe(true);
    expect(jobs.start(deferredRunner().runner)).toBe(false);

    resolve(0);
    await new Promise((r) => setTimeout(r, 0));
    // Once settled, a new scan can start again.
    expect(jobs.start(deferredRunner().runner)).toBe(true);
  });

  it("maps progress events into the status snapshot", async () => {
    const jobs = new ScanJobManager();
    const runner: ScanRunner = async (onProgress) => {
      onProgress({ kind: "directory" });
      onProgress({ kind: "leads", total: 10 });
      onProgress({ kind: "company", name: "Acme", index: 4, total: 10 });
      return { count: 2, warnings: [] };
    };
    jobs.start(runner);
    await new Promise((r) => setTimeout(r, 0));

    const status = jobs.getStatus();
    // The last progress event before completion was the company visit.
    expect(status.current).toBe(4);
    expect(status.total).toBe(10);
  });

  it("returns copies so callers can't mutate internal state", () => {
    const jobs = new ScanJobManager();
    jobs.getStatus().warnings.push({ source: "x", message: "y" });
    expect(jobs.getStatus().warnings).toHaveLength(0);
  });
});
