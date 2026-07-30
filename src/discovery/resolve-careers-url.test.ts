import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import type { AtsConnector, ConnectorResult } from "./connectors/types";
import { resolveAts } from "./resolve-ats";
import {
  candidateSlugs,
  resolveCareersUrl,
  SLUG_CONNECTORS,
  type SlugConnector,
} from "./resolve-careers-url";

describe("candidateSlugs", () => {
  it("derives the concatenated and hyphenated forms, most-specific first", () => {
    expect(candidateSlugs("Khan Academy")).toEqual(["khanacademy", "khan-academy"]);
  });

  it("adds a first-word candidate only when the first word is long enough", () => {
    // "spotify" (7) qualifies as a last-resort candidate; "khan" (4) did not, above.
    expect(candidateSlugs("Spotify Music")).toEqual(["spotifymusic", "spotify-music", "spotify"]);
  });

  it("strips a leading article and trailing legal noise", () => {
    expect(candidateSlugs("the LEGO Group")).toEqual(["legogroup", "lego-group"]);
    expect(candidateSlugs("Acme, Inc.")).toEqual(["acme"]);
  });

  it("expands an ampersand and drops other punctuation", () => {
    expect(candidateSlugs("AT&T")).toEqual(["atandt", "at-and-t"]);
  });

  it("de-duplicates when the variants collapse to the same slug", () => {
    expect(candidateSlugs("Uber")).toEqual(["uber"]);
  });

  it("returns nothing for a name with no usable slug", () => {
    expect(candidateSlugs("™")).toEqual([]);
    // A slug below the length floor is dropped rather than probed.
    expect(candidateSlugs("A")).toEqual([]);
  });
});

/** A posting is mostly irrelevant here — only `title`/`url` are read for the sample. */
function posting(title: string, url: string): JobPosting {
  return {
    id: title,
    company: "x",
    title,
    url,
    source: "test",
    description: "",
    fetchedAt: new Date(),
  };
}

/** A fake connector that reports a live board for an allow-list of slugs, else a 404-style failure. */
function fakeConnector(source: string, liveSlugs: Record<string, JobPosting[]>): AtsConnector {
  return {
    source,
    async fetchPostings(boardToken: string): Promise<ConnectorResult> {
      const postings = liveSlugs[boardToken];
      return postings ? { ok: true, postings } : { ok: false, warning: "unexpected status 404" };
    },
  };
}

function slugConn(connector: AtsConnector): SlugConnector {
  return { connector, boardUrl: (s) => `https://${connector.source}.example/${s}` };
}

// The resolver injects its own fetcher into the connectors; the fakes ignore it, so any stub works.
const noopFetcher: Fetcher = {
  async fetch() {
    return { statusCode: 404, finalUrl: "", bodyText: "" };
  },
};

describe("resolveCareersUrl", () => {
  it("resolves the most-specific slug and reports the board", async () => {
    const gh = slugConn(fakeConnector("greenhouse", { khanacademy: [posting("SWE", "u1")] }));
    const resolved = await resolveCareersUrl("Khan Academy", noopFetcher, { connectors: [gh] });
    expect(resolved).toEqual({
      platform: "greenhouse",
      boardToken: "khanacademy",
      boardUrl: "https://greenhouse.example/khanacademy",
      postingCount: 1,
      sample: { title: "SWE", url: "u1" },
      candidateRank: 0,
    });
  });

  it("prefers the first connector in order when several could match a slug", async () => {
    const gh = slugConn(fakeConnector("greenhouse", { uber: [posting("A", "a")] }));
    const lever = slugConn(fakeConnector("lever", { uber: [posting("B", "b")] }));
    const resolved = await resolveCareersUrl("Uber", noopFetcher, { connectors: [gh, lever] });
    expect(resolved?.platform).toBe("greenhouse");
  });

  it("falls through to a looser slug when the specific ones miss", async () => {
    const gh = slugConn(fakeConnector("greenhouse", { spotify: [posting("A", "a")] }));
    const resolved = await resolveCareersUrl("Spotify Music", noopFetcher, { connectors: [gh] });
    expect(resolved?.boardToken).toBe("spotify");
    expect(resolved?.candidateRank).toBe(2); // spotifymusic, spotify-music, then spotify
  });

  it("returns null when no candidate resolves to a live board", async () => {
    const gh = slugConn(fakeConnector("greenhouse", {}));
    expect(await resolveCareersUrl("Nowhere Corp", noopFetcher, { connectors: [gh] })).toBeNull();
  });

  it("treats an ok-but-empty board as not a match", async () => {
    const gh: AtsConnector = {
      source: "greenhouse",
      async fetchPostings() {
        return { ok: true, postings: [] };
      },
    };
    expect(await resolveCareersUrl("Uber", noopFetcher, { connectors: [slugConn(gh)] })).toBeNull();
  });

  it("returns null without probing when the name yields no slug", async () => {
    let probed = false;
    const gh: AtsConnector = {
      source: "greenhouse",
      async fetchPostings() {
        probed = true;
        return { ok: false, warning: "x" };
      },
    };
    expect(await resolveCareersUrl("™", noopFetcher, { connectors: [slugConn(gh)] })).toBeNull();
    expect(probed).toBe(false);
  });

  it("never throws when a connector throws, moving on to the next", async () => {
    const boom: AtsConnector = {
      source: "boom",
      async fetchPostings() {
        throw new Error("network exploded");
      },
    };
    const gh = slugConn(fakeConnector("greenhouse", { uber: [posting("A", "a")] }));
    const resolved = await resolveCareersUrl("Uber", noopFetcher, {
      connectors: [slugConn(boom), gh],
    });
    expect(resolved?.platform).toBe("greenhouse");
  });

  it("respects maxSlugs, not probing looser candidates past the cap", async () => {
    const gh = slugConn(fakeConnector("greenhouse", { spotify: [posting("A", "a")] }));
    // Only the rank-0 slug ("spotifymusic") is probed; the winning "spotify" is rank 2.
    const resolved = await resolveCareersUrl("Spotify Music", noopFetcher, {
      connectors: [gh],
      maxSlugs: 1,
    });
    expect(resolved).toBeNull();
  });
});

describe("SLUG_CONNECTORS canonical URLs", () => {
  it("every board URL round-trips through resolveAts to the same connector and token", () => {
    for (const { connector, boardUrl } of SLUG_CONNECTORS) {
      const resolved = resolveAts(boardUrl("acme"));
      expect(resolved?.connector.source).toBe(connector.source);
      expect(resolved?.boardToken).toBe("acme");
    }
  });
});
