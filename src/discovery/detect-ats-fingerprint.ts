import { resolveAts } from "./resolve-ats";

/**
 * Which signal in the probed page revealed the ATS, in decreasing strength:
 * - `finalUrl`  — the careers URL redirected to a known ATS host (e.g. a custom domain that 301s to
 *   `boards.greenhouse.io`). The strongest signal: the live host *is* the ATS.
 * - `embed`     — the page stayed on the custom domain but embeds a known ATS host (script/iframe/
 *   fetch to `boards.greenhouse.io`, `*.myworkdayjobs.com`, …). Resolving it needs an embed-follow step.
 * - `json-ld`   — no host fingerprint, but the page emits a `schema.org/JobPosting`. Weakest: tells us
 *   the page is scrapable for jobs, but not which (if any) ATS backs it.
 */
export type FingerprintSignal = "finalUrl" | "embed" | "json-ld";

export type FingerprintMatch = {
  /** Platform slug (e.g. `greenhouse`, `workday`, `workable`, or `json-ld` for the bare fallback). */
  platform: string;
  /**
   * The `source` of an existing connector when one backs this platform, else `null`. A non-null
   * value means "we already have a fast connector — this domain just needs an embed-follow resolve
   * step"; `null` means a new platform (or a bare JSON-LD page) with no connector yet.
   */
  connectorSource: string | null;
  signal: FingerprintSignal;
};

/**
 * Host fingerprints we look for in the page body, in priority order. Connector-backed platforms come
 * first so a page embedding a known-and-connected ATS is reported as "just needs a resolve step"
 * rather than as a bespoke platform. `hosts` are matched as case-insensitive substrings of the HTML —
 * enough to catch a host appearing in a `src`, a `fetch(...)`, or inline config without parsing the DOM.
 */
type HostFingerprint = { platform: string; connectorSource: string | null; hosts: string[] };

const HOST_FINGERPRINTS: HostFingerprint[] = [
  // Connector-backed platforms — a hit here means an existing fast connector already covers it.
  { platform: "greenhouse", connectorSource: "greenhouse", hosts: ["greenhouse.io"] },
  { platform: "lever", connectorSource: "lever", hosts: ["lever.co"] },
  { platform: "ashby", connectorSource: "ashby", hosts: ["ashbyhq.com"] },
  { platform: "workday", connectorSource: "workday", hosts: ["myworkdayjobs.com"] },
  { platform: "ukg", connectorSource: "ukg", hosts: ["ultipro.com"] },
  { platform: "recruitee", connectorSource: "recruitee", hosts: ["recruitee.com"] },
  { platform: "bamboohr", connectorSource: "bamboohr", hosts: ["bamboohr.com"] },
  { platform: "breezy", connectorSource: "breezy", hosts: ["breezy.hr"] },
  { platform: "rippling", connectorSource: "rippling", hosts: ["ats.rippling.com"] },
  {
    platform: "smartrecruiters",
    connectorSource: "smartrecruiters",
    hosts: ["smartrecruiters.com"],
  },

  // Known platforms we do NOT yet have a connector for — sizing the "new platform" bucket.
  { platform: "workable", connectorSource: null, hosts: ["workable.com"] },
  { platform: "icims", connectorSource: null, hosts: ["icims.com"] },
  { platform: "jobvite", connectorSource: null, hosts: ["jobvite.com"] },
  { platform: "taleo", connectorSource: null, hosts: ["taleo.net"] },
  { platform: "successfactors", connectorSource: null, hosts: ["successfactors.com", "sapsf.com"] },
  { platform: "jazzhr", connectorSource: null, hosts: ["applytojob.com", "jazz.co"] },
  { platform: "teamtailor", connectorSource: null, hosts: ["teamtailor.com"] },
  { platform: "personio", connectorSource: null, hosts: ["jobs.personio.com", "personio.de"] },
  { platform: "paylocity", connectorSource: null, hosts: ["recruiting.paylocity.com"] },
  { platform: "pinpoint", connectorSource: null, hosts: ["pinpointhq.com"] },
];

const JSON_LD_JOBPOSTING = /"@type"\s*:\s*"JobPosting"/i;

/**
 * Detect which ATS (if any) backs a probed careers page, given the final URL after redirects and the
 * fetched HTML. Pure and side-effect-free — the opt-in `analyze:custom-domains` diagnostic feeds it
 * live-fetched pages to size how many vanity domains proxy an ATS we already connect to.
 *
 * Returns the strongest match found, or `null` when nothing recognizable is present.
 */
export function detectAtsFingerprint(finalUrl: string, html: string): FingerprintMatch | null {
  // Strongest: the live host itself is a known ATS (a custom domain that redirected onto it).
  const resolved = resolveAts(finalUrl);
  if (resolved) {
    return {
      platform: resolved.connector.source,
      connectorSource: resolved.connector.source,
      signal: "finalUrl",
    };
  }

  // Next: a known ATS host embedded in the page (connector-backed entries are listed first).
  const haystack = html.toLowerCase();
  for (const fingerprint of HOST_FINGERPRINTS) {
    if (fingerprint.hosts.some((host) => haystack.includes(host))) {
      return {
        platform: fingerprint.platform,
        connectorSource: fingerprint.connectorSource,
        signal: "embed",
      };
    }
  }

  // Weakest: the page emits a schema.org JobPosting but no host fingerprint — scrapable, ATS unknown.
  if (JSON_LD_JOBPOSTING.test(html)) {
    return { platform: "json-ld", connectorSource: null, signal: "json-ld" };
  }

  return null;
}
