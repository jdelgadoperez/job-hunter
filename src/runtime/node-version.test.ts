import { describe, expect, it } from "vitest";
import { checkNodeVersion, NODE_VERSION_FLOOR } from "./node-version";

describe("checkNodeVersion", () => {
  it("returns null when the running major meets the floor", () => {
    expect(checkNodeVersion(`${NODE_VERSION_FLOOR}.4.0`)).toBeNull();
    expect(checkNodeVersion(`${NODE_VERSION_FLOOR + 2}.0.0`)).toBeNull();
  });

  it("returns a message naming the floor when the running major is below it", () => {
    const message = checkNodeVersion(`${NODE_VERSION_FLOOR - 1}.9.0`);
    expect(message).not.toBeNull();
    expect(message).toContain(String(NODE_VERSION_FLOOR));
  });

  it("returns null for an unparseable version rather than warning spuriously", () => {
    expect(checkNodeVersion("not-a-version")).toBeNull();
  });
});
