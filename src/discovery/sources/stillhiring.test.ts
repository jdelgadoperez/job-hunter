import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SkillProfile } from "@app/domain/types";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { STILLHIRING_URL, discoverCompanies } from "./stillhiring";

async function fixtureBody(): Promise<string> {
  const path = fileURLToPath(new URL("./__fixtures__/stillhiring.json", import.meta.url));
  return readFile(path, "utf8");
}

function profile(categories: string[]): SkillProfile {
  return { skills: [], roleKeywords: [], categories };
}

async function fetcherWithFixture(): Promise<FakeFetcher> {
  return new FakeFetcher({
    [STILLHIRING_URL]: {
      statusCode: 200,
      finalUrl: STILLHIRING_URL,
      bodyText: await fixtureBody(),
    },
  });
}

describe("discoverCompanies", () => {
  it("returns only leads matching the profile categories", async () => {
    const { leads, warnings } = await discoverCompanies(
      profile(["engineering"]),
      await fetcherWithFixture(),
    );
    expect(warnings).toEqual([]);
    expect(leads.map((l) => l.company)).toEqual(["Acme", "Globex"]);
  });

  it("returns all leads when the profile lists no categories", async () => {
    const { leads } = await discoverCompanies(profile([]), await fetcherWithFixture());
    expect(leads.map((l) => l.company)).toEqual(["Acme", "Globex", "Initech"]);
  });

  it("degrades to a warning on a failed fetch", async () => {
    const { leads, warnings } = await discoverCompanies(profile([]), new FakeFetcher({}));
    expect(leads).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe("stillhiring.today");
  });

  it("degrades to a warning on garbage JSON", async () => {
    const fetcher = new FakeFetcher({
      [STILLHIRING_URL]: { statusCode: 200, finalUrl: STILLHIRING_URL, bodyText: "<<not json>>" },
    });
    const { leads, warnings } = await discoverCompanies(profile([]), fetcher);
    expect(leads).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
