import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { exitQuietlyOnEpipe } from "./main";

describe("exitQuietlyOnEpipe", () => {
  it("exits 0 on EPIPE and rethrows other stream errors", () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
    const exit = vi.fn();
    exitQuietlyOnEpipe(stream, exit);
    stream.emit("error", Object.assign(new Error("pipe"), { code: "EPIPE" }));
    expect(exit).toHaveBeenCalledWith(0);
    expect(() => stream.emit("error", Object.assign(new Error("io"), { code: "EIO" }))).toThrow(
      "io",
    );
  });
});
