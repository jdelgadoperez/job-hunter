import { describe, expect, it } from "vitest";
import { classifyListenError } from "./listen-error";

const PORT = 48373;

describe("classifyListenError", () => {
  it("classifies EADDRINUSE as port-in-use with the port in the message", () => {
    const err = Object.assign(new Error("bind failed"), { code: "EADDRINUSE" });
    const verdict = classifyListenError(err, PORT);
    expect(verdict.kind).toBe("port-in-use");
    expect(verdict.message).toContain(String(PORT));
  });

  it("classifies an unknown error code as other, preserving the message", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const verdict = classifyListenError(err, PORT);
    expect(verdict.kind).toBe("other");
    expect(verdict.message).toContain("permission denied");
  });

  it("handles a non-Error value without throwing", () => {
    const verdict = classifyListenError("boom", PORT);
    expect(verdict.kind).toBe("other");
    expect(verdict.message.length).toBeGreaterThan(0);
  });
});
