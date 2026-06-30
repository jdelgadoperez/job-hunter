import { z } from "zod";

/**
 * Zod schemas for the three ATS JSON feeds. Each is lenient on unknown fields
 * (`.passthrough()`) and strict only on the fields we actually read, so an ATS
 * adding a field never breaks us, but a feed missing `title`/`url` is rejected at
 * the boundary and degrades to `[]` rather than producing a malformed `JobPosting`.
 */

// Greenhouse — https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
const GreenhouseJob = z
  .object({
    title: z.string(),
    absolute_url: z.string(),
    content: z.string().optional(),
    location: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const GreenhouseFeed = z.object({ jobs: z.array(GreenhouseJob) }).passthrough();
export type GreenhouseFeed = z.infer<typeof GreenhouseFeed>;

// Lever — https://api.lever.co/v0/postings/{token}?mode=json (a bare array)
const LeverPosting = z
  .object({
    text: z.string(),
    hostedUrl: z.string(),
    descriptionPlain: z.string().optional(),
    categories: z.object({ location: z.string().optional() }).passthrough().optional(),
    workplaceType: z.string().optional(),
  })
  .passthrough();

export const LeverFeed = z.array(LeverPosting);
export type LeverFeed = z.infer<typeof LeverFeed>;

// Ashby — https://api.ashbyhq.com/posting-api/job-board/{token}
const AshbyJob = z
  .object({
    title: z.string(),
    jobUrl: z.string(),
    descriptionPlain: z.string().optional(),
    location: z.string().optional(),
    isRemote: z.boolean().optional(),
  })
  .passthrough();

export const AshbyFeed = z.object({ jobs: z.array(AshbyJob) }).passthrough();
export type AshbyFeed = z.infer<typeof AshbyFeed>;

// Workday — POST https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
// `externalPath` is the job's path under the site root; `total` drives pagination.
const WorkdayJob = z
  .object({
    title: z.string(),
    externalPath: z.string(),
    locationsText: z.string().optional(),
  })
  .passthrough();

export const WorkdayFeed = z
  .object({
    total: z.number().optional(),
    jobPostings: z.array(WorkdayJob),
  })
  .passthrough();
export type WorkdayFeed = z.infer<typeof WorkdayFeed>;

// Workday job detail — GET https://{host}/wday/cxs/{tenant}/{site}{externalPath}
// Carries the full (HTML) job description the list endpoint omits.
export const WorkdayJobDetail = z
  .object({
    jobPostingInfo: z.object({ jobDescription: z.string().optional() }).passthrough(),
  })
  .passthrough();
export type WorkdayJobDetail = z.infer<typeof WorkdayJobDetail>;

// Rippling list — GET https://ats.rippling.com/api/v2/board/{slug}/jobs?page=&pageSize=
// Like Workday, the list omits the description; `totalPages` drives pagination and each item
// carries its own human-facing `url` and one-or-more `locations`.
const RipplingJob = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    locations: z
      .array(z.object({ name: z.string(), workplaceType: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export const RipplingFeed = z
  .object({
    items: z.array(RipplingJob),
    totalPages: z.number().optional(),
  })
  .passthrough();
export type RipplingFeed = z.infer<typeof RipplingFeed>;

// Rippling job detail — GET https://ats.rippling.com/api/v2/board/{slug}/jobs/{id}
// The full (HTML) description lives under `description.role`.
export const RipplingJobDetail = z
  .object({
    description: z.object({ role: z.string().optional() }).passthrough(),
  })
  .passthrough();
export type RipplingJobDetail = z.infer<typeof RipplingJobDetail>;

// Recruitee — GET https://{slug}.recruitee.com/api/offers/
// The list already carries the full (HTML) description, so this is a simple feed (no detail fetch).
const RecruiteeOffer = z
  .object({
    title: z.string(),
    careers_url: z.string(),
    description: z.string().optional(),
    location: z.string().optional(),
  })
  .passthrough();

export const RecruiteeFeed = z.object({ offers: z.array(RecruiteeOffer) }).passthrough();
export type RecruiteeFeed = z.infer<typeof RecruiteeFeed>;

// SmartRecruiters list — GET https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=&offset=
// The list omits the description; `totalFound` drives offset pagination. Location is a structured
// object whose `fullLocation` is the display string.
const SmartRecruitersPosting = z
  .object({
    id: z.string(),
    name: z.string(),
    location: z.object({ fullLocation: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const SmartRecruitersFeed = z
  .object({
    totalFound: z.number().optional(),
    content: z.array(SmartRecruitersPosting),
  })
  .passthrough();
export type SmartRecruitersFeed = z.infer<typeof SmartRecruitersFeed>;

// SmartRecruiters job detail — GET https://api.smartrecruiters.com/v1/companies/{slug}/postings/{id}
// The full (HTML) text lives under `jobAd.sections.{jobDescription,qualifications}.text`; `postingUrl`
// is the canonical human-facing posting link (absent from the list).
const SmartRecruitersSection = z.object({ text: z.string().optional() }).passthrough();

export const SmartRecruitersDetail = z
  .object({
    postingUrl: z.string().optional(),
    jobAd: z
      .object({
        sections: z
          .object({
            jobDescription: SmartRecruitersSection.optional(),
            qualifications: SmartRecruitersSection.optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type SmartRecruitersDetail = z.infer<typeof SmartRecruitersDetail>;

// BambooHR list — GET https://{slug}.bamboohr.com/careers/list
// The list omits the description; `atsLocation` is a structured location whose parts we join.
const BambooHrAtsLocation = z
  .object({
    city: z.string().nullish(),
    state: z.string().nullish(),
    country: z.string().nullish(),
  })
  .passthrough();

const BambooHrJob = z
  .object({
    id: z.string(),
    jobOpeningName: z.string(),
    atsLocation: BambooHrAtsLocation.optional(),
  })
  .passthrough();

export const BambooHrFeed = z.object({ result: z.array(BambooHrJob) }).passthrough();
export type BambooHrFeed = z.infer<typeof BambooHrFeed>;

// BambooHR job detail — GET https://{slug}.bamboohr.com/careers/{id}/detail
// Carries the full (HTML) `description` and the canonical `jobOpeningShareUrl`.
export const BambooHrDetail = z
  .object({
    result: z
      .object({
        jobOpening: z
          .object({
            description: z.string().optional(),
            jobOpeningShareUrl: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
export type BambooHrDetail = z.infer<typeof BambooHrDetail>;

// UKG / UltiPro list — POST https://recruiting{N}.ultipro.com/{tenant}/JobBoard/{guid}/JobBoardView/LoadSearchResults
// `opportunitySearch.{Top,Skip}` drives pagination. The list carries a `BriefDescription` (a real
// summary, not a snippet), so this is a single-call feed connector — the full description would
// require rendering the SPA detail page, which we skip. `Locations[].LocalizedDescription` is the
// display location.
const UkgLocation = z
  .object({
    LocalizedDescription: z.string().nullish(),
    Address: z.object({ City: z.string().nullish() }).passthrough().optional(),
  })
  .passthrough();

const UkgOpportunity = z
  .object({
    Id: z.string(),
    Title: z.string(),
    BriefDescription: z.string().nullish(),
    Locations: z.array(UkgLocation).optional(),
  })
  .passthrough();

export const UkgFeed = z
  .object({
    totalCount: z.number().optional(),
    opportunities: z.array(UkgOpportunity),
  })
  .passthrough();
export type UkgFeed = z.infer<typeof UkgFeed>;

// Breezy list — GET https://{slug}.breezy.hr/json
// The list omits the description; each item carries its own `url` (the position page, whose embedded
// JSON-LD JobPosting holds the description, fetched over plain HTTP). `location.name` is the display
// location.
const BreezyJob = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    location: z.object({ name: z.string().nullish() }).passthrough().optional(),
  })
  .passthrough();

export const BreezyFeed = z.array(BreezyJob);
export type BreezyFeed = z.infer<typeof BreezyFeed>;

// Workable — GET https://apply.workable.com/api/v3/accounts/{token}/jobs (cursor-paginated via nextPage)
// The list carries a description; `location` is a structured object; `url` may be absent (synthesize
// from `shortcode`). `nextPage` is an opaque next-page URL/cursor when more results remain.
const WorkableJob = z
  .object({
    title: z.string(),
    shortcode: z.string(),
    url: z.string().optional(),
    description: z.string().optional(),
    location: z
      .object({
        city: z.string().nullish(),
        region: z.string().nullish(),
        country: z.string().nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const WorkableFeed = z
  .object({
    results: z.array(WorkableJob),
    nextPage: z.string().nullish(),
  })
  .passthrough();
export type WorkableFeed = z.infer<typeof WorkableFeed>;
