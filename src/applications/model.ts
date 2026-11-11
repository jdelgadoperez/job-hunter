/**
 * Application tracking: the jobs you've actually applied to, and what happened next. This is the
 * former standalone `jt` tracker, folded in so a match can become an application in one step.
 *
 * Applications deliberately copy company/role/url instead of depending on a posting row: postings
 * expire, and plenty of applications (referrals, LinkedIn) never had a posting in this database.
 * `postingId` is an optional link back to the match it came from.
 */

/** The application lifecycle. Order is the natural progression, used for display and stats. */
export const APPLICATION_STATUSES = [
  "applied",
  "screened",
  "interviewed",
  "offered",
  "rejected",
  "ghosted",
  "withdrawn",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses that end an application; only these may be archived. */
export const CLOSED_STATUSES: readonly ApplicationStatus[] = ["rejected", "ghosted", "withdrawn"];

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return typeof value === "string" && (APPLICATION_STATUSES as readonly string[]).includes(value);
}

export type ApplicationNote = {
  id: number;
  applicationId: number;
  /** Calendar date (YYYY-MM-DD) the note refers to. */
  date: string;
  content: string;
};

export type Application = {
  id: number;
  company: string;
  role: string;
  status: ApplicationStatus;
  /** Calendar date (YYYY-MM-DD). */
  dateApplied: string;
  url: string | null;
  source: string | null;
  salaryRange: string | null;
  recruiter: string | null;
  /** The match this application came from, when it came from one. */
  postingId: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  notes: ApplicationNote[];
};

/** Fields accepted when creating an application. Omitted dates default to today. */
export type NewApplication = {
  company: string;
  role: string;
  dateApplied?: string;
  status?: ApplicationStatus;
  url?: string | null;
  source?: string | null;
  salaryRange?: string | null;
  recruiter?: string | null;
  postingId?: string | null;
};

/** Editable fields. Status changes go through `setStatus` so they leave a note. */
export type ApplicationPatch = {
  company?: string;
  role?: string;
  dateApplied?: string;
  url?: string | null;
  source?: string | null;
  salaryRange?: string | null;
  recruiter?: string | null;
};

export type ApplicationCounts = Partial<Record<ApplicationStatus, number>>;
