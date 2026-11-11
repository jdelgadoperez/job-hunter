export const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  remote INTEGER,
  country TEXT,
  company_id TEXT,
  posted_at TEXT,
  fetched_at TEXT NOT NULL,
  -- Incremental-scan bookkeeping: the scan that last saw this posting, and when it was judged gone.
  last_seen_scan INTEGER,
  expired_at TEXT
);

CREATE TABLE IF NOT EXISTS match_results (
  posting_id TEXT PRIMARY KEY REFERENCES postings(id),
  score INTEGER NOT NULL,
  matched_skills TEXT NOT NULL,
  missing_skills TEXT NOT NULL,
  rationale TEXT
);

CREATE TABLE IF NOT EXISTS user_actions (
  posting_id TEXT PRIMARY KEY REFERENCES postings(id),
  action TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  category TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS tracked_companies (
  careers_url TEXT PRIMARY KEY,
  name TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failed_leads (
  careers_url TEXT PRIMARY KEY,
  company TEXT,
  company_id TEXT,
  message TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 1,
  last_failed_scan INTEGER NOT NULL
);

-- One row per scan run. Sequential id drives posting expiry; the diff columns hold the
-- directory delta (companies that appeared/disappeared vs. the previous snapshot) as JSON.
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  postings_seen INTEGER,
  companies_seen INTEGER,
  new_companies TEXT,
  removed_companies TEXT,
  kind TEXT NOT NULL DEFAULT 'full'
);

-- Snapshot of every company seen in the directory (or tracked), so successive scans can diff it.
CREATE TABLE IF NOT EXISTS companies (
  careers_url TEXT PRIMARY KEY,
  id TEXT,
  name TEXT,
  first_seen_scan INTEGER NOT NULL,
  last_seen_scan INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Applications you have submitted (the former jt tracker). Company/role/url are copied rather than
-- joined from postings: postings expire, and many applications never had a posting here at all.
-- posting_id optionally links back to the match the application came from.
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  date_applied TEXT NOT NULL,
  url TEXT,
  source TEXT,
  salary_range TEXT,
  recruiter TEXT,
  posting_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS application_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Indexes for the hot read/scan paths. Created in `migrate()` *after* the column ALTERs, because
// they reference columns (expired_at, last_seen_scan) that legacy databases gain only during
// migration — declaring them in SCHEMA would fail on those DBs since SCHEMA runs before migrate().
//   expired_at:     the `WHERE expired_at IS NULL` predicate in nearly every posting query.
//   score:          the `WHERE score >= ? ORDER BY score DESC` of listScoredPostings.
//   last_seen_scan: `listLivePostingsNotSeen` / `expireStalePostings`, which scan by last-seen scan.
//   last_seen_at:   `listFreshCompanyUrls`, which range-scans by last-seen timestamp on every
//                   incremental scan.
export const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_postings_expired_at ON postings(expired_at);
CREATE INDEX IF NOT EXISTS idx_postings_last_seen_scan ON postings(last_seen_scan);
CREATE INDEX IF NOT EXISTS idx_match_results_score ON match_results(score);
CREATE INDEX IF NOT EXISTS idx_companies_id ON companies(id);
CREATE INDEX IF NOT EXISTS idx_postings_company_id ON postings(company_id);
CREATE INDEX IF NOT EXISTS idx_companies_last_seen_at ON companies(last_seen_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_posting_id ON applications(posting_id)
  WHERE posting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_application_notes_app ON application_notes(application_id);
`;
