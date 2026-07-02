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
    // Full US state names → US
    ["Austin, Texas", "US"],
    ["Los Angeles, California", "US"],
    ["New York, New York", "US"],
    ["Seattle, Washington", "US"],
    // Full Canadian province names → Canada
    ["Vancouver, British Columbia", "Canada"],
    ["Toronto, Ontario", "Canada"],
    // New country aliases
    ["Bangalore, India", "India"],
    ["Dublin, Ireland", "Ireland"],
    ["Singapore, Singapore", "Singapore"],
    ["São Paulo, Brazil - Remote", "Brazil"],
    ["Barcelona, Spain", "Spain"],
    ["Mexico City, Mexico", "Mexico"],
    ["Amsterdam, Netherlands", "Netherlands"],
    ["Tokyo, Japan", "Japan"],
    ["Dubai, United Arab Emirates - Remote", "United Arab Emirates"],
    ["Ankara, Türkiye - Remote", "Türkiye"],
    ["Zurich, Switzerland", "Switzerland"],
    ["Bogotá, Colombia", "Colombia"],
    ["Sydney, Australia", "Australia"],
    // Bare cities and ambiguous strings STILL unknown (never guess)
    ["San Francisco", undefined],
    ["London", undefined],
    ["Barcelona", undefined],
    ["2 Locations", undefined],
    ["Home based - Worldwide", undefined],
    // Signal embedded as a whole word in a multi-word token
    ["Remote US", "US"],
    ["Remote U.S.", "US"],
    ["US West", "US"],
    ["Remote - US East", "US"],
    ["Remote - US Central", "US"],
    ["Remote Canada", "Canada"],
    // Semicolon splits multi-location; last country wins (end-first)
    ["APAC - Australia; Singapore", "Singapore"],
    // Whole-word only: a token containing "business" must NOT match "us"
    ["Business Development, Remote", undefined],
    // Word-like 2-letter state codes must NOT match inside a phrase (never guess)
    ["London or Paris", undefined],
    ["Work in Berlin", undefined],
    ["La Paz", undefined],
    ["Hybrid or Remote", undefined],
    ["Remote in Europe", undefined],
  ];

  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(parseCountry(input)).toBe(expected);
    });
  }
});
