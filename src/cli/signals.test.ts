import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { onShutdown, type SignalTarget } from "./signals";

/** An EventEmitter typed as the SignalTarget seam — the same shape production passes `process` for. */
function fakeTarget(): EventEmitter & SignalTarget {
  return new EventEmitter();
}

describe("onShutdown", () => {
  it("runs the handler once per process, ignoring a second signal (idempotent)", () => {
    const target = fakeTarget();
    const handler = vi.fn();
    onShutdown(handler, target);

    target.emit("SIGINT");
    target.emit("SIGINT");
    target.emit("SIGTERM");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("registers both SIGINT and SIGTERM (SIGTERM alone triggers it)", () => {
    const target = fakeTarget();
    const handler = vi.fn();
    onShutdown(handler, target);

    target.emit("SIGTERM");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("SIGTERM");
  });

  it("dispose() removes both listeners so later signals do nothing", () => {
    const target = fakeTarget();
    const handler = vi.fn();
    const dispose = onShutdown(handler, target);

    dispose();
    target.emit("SIGINT");
    target.emit("SIGTERM");

    expect(handler).not.toHaveBeenCalled();
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});
