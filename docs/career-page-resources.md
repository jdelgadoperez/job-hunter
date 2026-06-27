# Career-page & ATS resources — where leads can come from

job-hunter discovers open roles by collecting **company leads** — a company name plus its careers
URL — and resolving each one to an ATS connector (or a browser fallback). Today there is exactly one
directory source plus your own tracked companies. This doc catalogues **other resources you could
add** to widen the funnel, and explains how each fits the existing architecture.

It's a reference, not a roadmap — nothing here is wired up yet. The goal is to make the tradeoffs
explicit so adding a source is a small, well-understood change.

## How a lead enters the pipeline today

Discovery is a two-step seam (`src/discovery/`):

1. **Sources** produce `CompanyLead`s — `{ company, careersUrl, categories }` (see
   `src/discovery/sources/types.ts`). The only production source is `airtable.ts`, which reads the
   community **stillhiring.today** directory (a public Airtable shared view). User-tracked companies
   are merged in by `discover.ts` (`collectLeads`), de-duplicated by normalized careers URL.
2. **Connectors** resolve each lead's careers URL to a known ATS and fetch its postings
   (`resolve-ats.ts` → `connectors/`), falling back to a headless browser render, and skipping hosts
   we don't scrape (`unscrapable.ts`).

So **adding a resource = adding a new Source** that returns `CompanyLead[]`, merged alongside
Airtable in `collectLeads`. Anything a source emits flows through the *existing* ATS resolver and
fingerprint detection for free — a new source only has to produce `{ company, careersUrl }`, not
understand ATS platforms.

Connectors currently implemented: Greenhouse, Lever, Ashby, Workday, Rippling, Recruitee,
SmartRecruiters, BambooHR, UKG, Breezy (`connectors/registry.ts`), plus a JSON-LD/`schema.org`
JobPosting fallback and host-fingerprint detection (`detect-ats-fingerprint.ts`).

---

## 1. ATS-native public APIs

These platforms expose **public, unauthenticated** JSON endpoints keyed by a board token. We already
*resolve and fetch* most of them per-company; the untapped value is **enumerating which companies
use them** so they become leads in the first place. Useful when you have a board token (or company
slug) but no directory listing it.

| Platform | Public endpoint (per board) | Connector exists? |
| --- | --- | --- |
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs` | yes |
| Lever | `https://api.lever.co/v0/postings/{company}?mode=json` | yes |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{token}` | yes |
| SmartRecruiters | `https://api.smartrecruiters.com/v1/companies/{company}/postings` | yes |
| Recruitee | `https://{company}.recruitee.com/api/offers/` | yes |
| BambooHR | `https://{company}.bamboohr.com/careers/list` | yes |
| Breezy | `https://{company}.breezy.hr/json` | yes |
| Workable | `https://apply.workable.com/api/v3/accounts/{token}/jobs` | **no — candidate connector** |

**Fit:** these aren't directory sources on their own (they need a token); pair them with an
enumeration technique (§4) or a curated token list (§3). Workable is the one notable platform with no
connector yet — a clean addition modeled on the existing ones.

---

## 2. Aggregator APIs — the best drop-in sources

These publish **company + careers/listing URL** as structured JSON, which maps almost directly to
`CompanyLead`. All are free and ToS-friendly (unlike scraping LinkedIn/Indeed/Glassdoor, which are
anti-bot and against ToS — keep those on the `unscrapable` list). Each is a new file under
`src/discovery/sources/` returning `CompanyLead[]`.

| Source | Endpoint | Notes |
| --- | --- | --- |
| **The Muse** | `https://api-v2.themuse.com/jobs` | Free API key; companies + listings, paginated, category/level filters. |
| **Remotive** | `https://remotive.com/api/remote-jobs` | Free, no auth; remote roles with company name + URL. |
| **RemoteOK** | `https://remoteok.com/api` | Free JSON; first element is metadata. Attribution required. |
| **Arbeitnow** | `https://www.arbeitnow.com/api/job-board-api` | Free, no auth; EU-heavy. |
| **Jobicy** | `https://jobicy.com/api/v2/remote-jobs` | Free remote-jobs API. |
| **Himalayas** | `https://himalayas.app/jobs/api` | Free remote-jobs API. |
| **Hacker News "Who is Hiring"** | Algolia HN API (`https://hn.algolia.com/api/v1/...`) | Monthly threads; comments are dense with direct careers/ATS links — needs link extraction. |
| **Adzuna** | `https://api.adzuna.com/v1/api/jobs/...` | Free tier, needs app id/key. |
| **USAJobs** | `https://data.usajobs.gov/api/search` | US federal; free, needs a key + email header. |

**Recommendation:** start with **The Muse + Remotive + HN Who-is-Hiring**. The first two are
clean structured feeds; HN is noisier but yields lots of direct ATS board links that your resolver
will pick up automatically. A useful pattern: have these sources emit a careers URL and let
`resolve-ats` + `detect-ats-fingerprint` decide whether it's a known ATS — the source stays dumb.

---

## 3. Directories of companies-by-ATS (analogous to stillhiring.today)

Curated lists you transform into leads — the same shape as the current Airtable source, so the
existing `SharedViewReader` seam already handles any Airtable-backed one.

- **Y Combinator / Work at a Startup** (`workatastartup.com`) — startups whose job pages are mostly
  Ashby/Greenhouse/Lever; high hit-rate against existing connectors.
- **layoffs.fyi** maintains a companion *hiring* list; **trueup.io** and **Wellfound (AngelList)** are
  similar company directories.
- **GitHub curated lists** — several "awesome jobs" / YC-board repos publish maintained
  Greenhouse/Lever/Ashby token lists you can pair with §1 endpoints.
- **Other community Notion/Airtable "still hiring" boards** — same shape as the current source;
  an Airtable share drops straight into the Playwright reader (`AIRTABLE_SHARE_URL` already overrides
  the share for dev/testing).

**Fit:** lowest-effort *content* additions; some are just a different `shareUrl` or a static token
list, not new code.

---

## 4. Programmatic enumeration (no fixed list)

Discover boards at scale instead of from a directory. Higher effort and more care needed around rate
limits and ToS, but uncovers companies no curated list has.

- **Search APIs** (Brave Search API, SerpAPI, Bing Web Search) with ATS dorks:
  `site:boards.greenhouse.io`, `site:jobs.lever.co`, `site:jobs.ashbyhq.com`,
  `site:apply.workable.com`, `site:*.myworkdayjobs.com` → each result host is a board token for §1.
- **Common Crawl index** — query the URL index for hostnames matching ATS domains to harvest board
  tokens in bulk, free.
- **Certificate Transparency** (`crt.sh`) — enumerate subdomains for subdomain-keyed platforms
  (`*.recruitee.com`, `*.bamboohr.com`, `*.breezy.hr`).

**Fit:** these feed §1 — they produce tokens/hosts, which a thin source turns into careers URLs and
hands to the existing resolver. Gate them behind opt-in config and conservative rate limits.

---

## Choosing what to add

| If you want… | Add |
| --- | --- |
| Most coverage for least code | An aggregator source from §2 (The Muse / Remotive) |
| More companies on connectors you already have | A curated token list (§3) + §1 endpoints |
| A new platform you can fully parse | A Workable connector (§1) |
| Breadth beyond any curated list | A search/Common-Crawl enumerator (§4) feeding §1 |

Whatever the source, the contract is the same: return `CompanyLead[]` and merge it in
`discover.ts`'s `collectLeads`. Keep sources "dumb" about ATS specifics — emit a careers URL and let
`resolve-ats` / `detect-ats-fingerprint` classify it. Add anti-bot/ToS-hostile hosts to
`unscrapable.ts` rather than special-casing them in a source.

### Caveats

- **Respect ToS and robots.** The aggregator APIs in §2 are sanctioned; scraping LinkedIn, Indeed,
  Glassdoor, or ZipRecruiter is not — those belong on the `unscrapable` list.
- **Rate-limit and cache.** Several free APIs throttle aggressively; honor their limits and the
  existing inter-request delay/concurrency cap in `discover.ts`.
- **Attribution.** Some sources (RemoteOK, The Muse) require attribution or an API key tied to terms.
- **De-duplication is handled** by `collectLeads` (normalized careers URL), so overlapping sources
  are safe to combine.
