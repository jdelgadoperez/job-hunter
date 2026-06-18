import { describe, expect, it } from "vitest";
import { makePostingId } from "./posting-id";

const base = { company: "Acme", title: "Engineer", url: "https://example.com/1" };

describe("makePostingId", () => {
  it("is stable for the same inputs", () => {
    expect(makePostingId(base)).toBe(makePostingId({ ...base }));
  });

  it("differs when any field changes", () => {
    expect(makePostingId(base)).not.toBe(makePostingId({ ...base, title: "Manager" }));
    expect(makePostingId(base)).not.toBe(makePostingId({ ...base, url: "https://example.com/2" }));
  });

  it("is a 16-char lowercase hex string", () => {
    expect(makePostingId(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});
