import { describe, expect, it } from "vitest";
import { parseCountry } from "./location-filter";

describe("parseCountry", () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    [undefined, undefined],
    ["", undefined],
    ["   ", undefined],
    ["Berlin, Germany", "Germany"],
    ["London, UK", "UK"],
    ["London, United Kingdom", "UK"],
    ["Remote - US", "US"],
    ["Remote (United States)", "US"],
    ["San Francisco, CA", "US"],
    ["New York, NY", "US"],
    ["Toronto, Canada", "Canada"],
    ["Toronto, ON", "Canada"],
    ["Paris, France", "France"],
    ["Anywhere", undefined],
    ["Distributed", undefined],
  ];

  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(parseCountry(input)).toBe(expected);
    });
  }
});
