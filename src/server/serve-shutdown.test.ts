import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SignalTarget } from "../cli/signals";
import { registerServerShutdown } from "./serve";

function fakeTarget(): EventEmitter & SignalTarget {
  return new EventEmitter();
}

describe("registerServerShutdown", () => {
  it("on SIGINT closes the server, clears the timer, and sets exitCode 0", () => {
    const target = fakeTarget();
    const server = { close: vi.fn() };
    const timer = setInterval(() => {}, 1_000_000);
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    process.exitCode = 7; // prove the handler sets it to 0

    registerServerShutdown({ server, timer, signals: target });
    target.emit("SIGINT");

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith(timer);
    expect(process.exitCode).toBe(0);

    clearInterval(timer);
    clearSpy.mockRestore();
    process.exitCode = 0;
  });

  it("tolerates an absent timer (scheduler disabled)", () => {
    const target = fakeTarget();
    const server = { close: vi.fn() };

    registerServerShutdown({ server, timer: undefined, signals: target });
    target.emit("SIGTERM");

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
    process.exitCode = 0;
  });
});
