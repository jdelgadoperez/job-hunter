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

-- One row per scan run. Sequential id drives posting expiry; the diff columns hold the
-- directory delta (companies that appeared/disappeared vs. the previous snapshot) as JSON.
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  postings_seen INTEGER,
  companies_seen INTEGER,
  new_companies TEXT,
  removed_companies TEXT
);

-- Snapshot of every company seen in the directory (or tracked), so successive scans can diff it.
CREATE TABLE IF NOT EXISTS companies (
  careers_url TEXT PRIMARY KEY,
  name TEXT,
  first_seen_scan INTEGER NOT NULL,
  last_seen_scan INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
