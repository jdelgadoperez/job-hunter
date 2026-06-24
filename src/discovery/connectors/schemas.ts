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
