import { describe, expect, it } from "vitest";
import { resolveRemoteOnly } from "./resolve-remote";
import type { SettingsReader } from "./resolve-settings";
import { REMOTE_ONLY_SETTING } from "./settings-keys";

function settings(value?: string): SettingsReader {
  return { getSetting: (key) => (key === REMOTE_ONLY_SETTING ? value : undefined) };
}

describe("resolveRemoteOnly", () => {
  it("returns the stored setting when no override is given", () => {
    expect(resolveRemoteOnly(settings("true"))).toBe(true);
    expect(resolveRemoteOnly(settings("false"))).toBe(false);
    expect(resolveRemoteOnly(settings(undefined))).toBe(false);
  });

  it("lets an explicit override win over the stored setting", () => {
    expect(resolveRemoteOnly(settings("true"), false)).toBe(false);
    expect(resolveRemoteOnly(settings("false"), true)).toBe(true);
  });
});
