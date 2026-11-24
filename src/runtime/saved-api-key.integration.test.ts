import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "@app/storage/repository";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAnthropicApiKey } from "./saved-api-key";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jh-key-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbWithKey(value: string | undefined): string {
  const dbPath = join(tempDir(), "jobhunter.db");
  const repo = new Repository(dbPath);
  if (value !== undefined) repo.setSetting("anthropicApiKey", value);
  repo.close();
  return dbPath;
}

describe("resolveAnthropicApiKey", () => {
  it("prefers ANTHROPIC_API_KEY over a saved key", () => {
    const dbPath = dbWithKey("sk-saved");
    expect(resolveAnthropicApiKey({ env: { ANTHROPIC_API_KEY: " sk-env " }, dbPath })).toEqual({
      apiKey: "sk-env",
      source: "env",
    });
  });

  it("falls back to the key saved in Settings", () => {
    const dbPath = dbWithKey(" sk-saved ");
    expect(resolveAnthropicApiKey({ env: {}, dbPath })).toEqual({
      apiKey: "sk-saved",
      source: "saved",
    });
  });

  it("finds the database through JOB_HUNTER_HOME when no path is given", () => {
    const dbPath = dbWithKey("sk-home");
    const home = join(dbPath, "..");
    expect(resolveAnthropicApiKey({ env: { JOB_HUNTER_HOME: home } })?.apiKey).toBe("sk-home");
  });

  it("returns undefined when neither source has a key, without creating a database", () => {
    expect(resolveAnthropicApiKey({ env: {}, dbPath: dbWithKey(undefined) })).toBeUndefined();
    const missing = join(tempDir(), "absent.db");
    expect(resolveAnthropicApiKey({ env: {}, dbPath: missing })).toBeUndefined();
  });

  it("treats an unreadable database as no saved key", () => {
    const notADb = join(tempDir(), "jobhunter.db");
    writeFileSync(notADb, "not sqlite");
    expect(resolveAnthropicApiKey({ env: {}, dbPath: notADb })).toBeUndefined();
  });
});
