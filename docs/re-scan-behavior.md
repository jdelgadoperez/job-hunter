# Re-scan behavior — what happens once you have a baseline

The first `scan` populates an empty database. Every scan after that is a **re-scan**: it runs against
a baseline of companies, postings, and scores from prior runs. This guide explains what a re-scan
does differently, how postings move through their lifecycle (new → scored → expired → revived), and
where those changes surface to you in the CLI and the dashboard.

For everyday command usage, see [usage.md](./usage.md). This doc is for understanding the *behavior*
— useful if you're wondering "why did that posting disappear?" or "does a re-scan re-charge my LLM
budget?".

## The short version

- A scan is **always the same pipeline** — there is no separate "first scan" vs. "re-scan" code
  path. The difference is entirely in what the diff against the baseline produces.
- A scan is recorded as an **incremental unit** (a row in the `scans` table). Each posting and
  company remembers the scan that last saw it, which is how the tool computes "new", "gone", and
  "stale".
- **Every live posting is re-scored on every scan.** There is no "already scored, skip it" cache —
  so a re-scan with LLM scoring enabled re-incurs scoring cost for everything currently open.
- Postings that **weren't seen this run** are re-checked for liveness and expired — immediately if
  confirmed gone, otherwise after they've been missing for two or more scans.
- A posting that **reappears after being expired is revived** automatically.

## The scan pipeline

Every scan — first or hundredth — runs these phases in order. `runScan` opens a scan unit, discovers
and scores, then reconciles everything that *wasn't* seen this run.

```mermaid
flowchart TD
    start([scan starts]) --> open["<b>Open scan unit</b><br/>insert a row in <code>scans</code>, get scanId"]
    open --> discover["<b>Discover</b><br/>read directory + tracked companies,<br/>fetch each board, collect postings"]
    discover --> diff["<b>Directory snapshot + diff</b><br/>compare companies vs. baseline<br/>→ new companies, gone companies"]
    diff --> upsert["<b>Upsert + score postings</b><br/>for every discovered posting:<br/>save it, then re-score it"]
    upsert --> recheck["<b>Liveness re-check</b><br/>for live postings NOT seen this run,<br/>re-fetch to confirm gone-or-still-there"]
    recheck --> sweep["<b>Stale-miss sweep</b><br/>expire anything missing 2+ scans"]
    sweep --> close["<b>Close scan unit</b><br/>record totals + the directory diff"]
    close --> done([scan finishes])

    discover -. "a company fails to load" .-> warn[/"collected as a warning,<br/>scan continues"/]
    warn -.-> diff
```

The discover and score phases treat the baseline as irrelevant — they fetch and score whatever is
live right now. The interesting re-scan behavior is in the **diff**, the **liveness re-check**, and
the **stale-miss sweep**, which all compare "this run" against "what the baseline remembered".

## How companies diff against the baseline

Each company is keyed by its careers URL and remembers the first and last scan that saw it. On a
re-scan the tool reports two deltas, relative to the **immediately preceding** scan:

| Delta | Meaning |
|---|---|
| **New companies** | In this run's directory, never recorded before. |
| **Gone companies** | Seen in the *previous* scan, absent from this one. |

"Gone" fires **once**, the first time a company disappears — a company that's been absent for several
scans is not re-reported every run. On the very first scan both deltas are empty (there's no baseline
to diff against).

## How postings are matched across scans

A posting's identity is a stable hash of `company + title + url` (lowercased). The same job discovered
on scan 1 and scan 50 gets the **same ID**, which is what lets the tool recognize a posting it has
seen before instead of treating it as new.

On save:

- **New ID** → inserted, marked seen this scan, not expired.
- **Existing ID** (a re-scan hit) → all fields refreshed, marked seen this scan, and **un-expired**
  if it had previously been expired. This is the revival path.

The prior **score is not preserved** — it's overwritten in the very next step, because scoring always
re-runs (see below).

## Scoring on a re-scan — no cache

Every posting discovered this run is **unconditionally re-scored**. There is no "this was scored last
week, skip it" short-circuit and no score history — the latest score overwrites the previous one.

Practical implication: **with LLM scoring enabled, each re-scan re-charges the scoring cost for every
currently-open posting**, not just the new ones. If that matters for your API budget, scan
deliberately rather than on a tight auto-refresh schedule. (Without an API key, scoring is the free
offline heuristic, so re-scan cost is just CPU.)

## The posting lifecycle

A posting moves through these states across scans. The key signal is `last_seen_scan` — the ID of the
most recent scan that saw it. "Missed N scans" is simply the gap between the current scan ID and
`last_seen_scan`; there's no separate miss counter.

```mermaid
stateDiagram-v2
    [*] --> New: discovered first time
    New --> Scored: scored against your profile

    Scored --> SeenAgain: appears in a later scan
    SeenAgain --> SeenAgain: re-scored, last_seen advances

    SeenAgain --> MissedOnce: not in this run's results
    Scored --> MissedOnce: not in this run's results

    MissedOnce --> Expired: re-check confirms gone<br/>(404 / 410 / absent from ATS feed / expired-page marker)
    MissedOnce --> SeenAgain: reappears next scan
    MissedOnce --> Stale: still missing

    Stale --> Expired: missing 2+ scans (heuristic sweep)
    Stale --> SeenAgain: reappears (revived)

    Expired --> SeenAgain: reappears → un-expired (revived)
    Expired --> [*]: stays expired, hidden by default

    note right of MissedOnce
        An inconclusive re-check
        (timeout / unreachable feed)
        leaves the posting live and
        defers to the stale sweep.
    end note
```

### Why a posting disappears

When a posting isn't in a run's results, the tool doesn't assume it's gone — it tries to confirm:

- **ATS-backed postings** (Greenhouse, Lever, Ashby, …) — the connector re-fetches the whole board
  feed. If the feed loads and the posting isn't in it, it's **expired**. If the feed is unreachable,
  the result is **inconclusive** and the posting is left for the stale sweep.
- **Browser-scraped postings** — an HTTP GET to the posting URL. A `404`/`410`, or a body matching a
  known "this job has closed" marker, means **expired**. A healthy `2xx` means **still live**.
  Anything else is **inconclusive**.

Confirmed-gone postings are expired immediately. Inconclusive ones survive until they've been missing
across **two or more** scans, at which point the stale-miss sweep expires them — a backstop so a flaky
fetch doesn't expire a posting prematurely, but a genuinely-removed one still ages out.

## Re-scan reconciliation, end to end

This is what one re-scan does to the existing baseline, from opening the scan unit to closing it.

```mermaid
sequenceDiagram
    participant U as You
    participant S as Scan pipeline
    participant D as Discovery
    participant Sc as Scorer
    participant DB as Local DB (baseline)

    U->>S: scan
    S->>DB: open scan unit (scanId)
    S->>D: discover companies + postings
    D-->>S: postings + company list
    S->>DB: diff companies → new / gone
    loop every discovered posting
        S->>DB: upsert (mark seen this scan, un-expire if needed)
        S->>Sc: re-score against profile
        Sc-->>DB: overwrite score
    end
    S->>DB: list live postings NOT seen this run
    loop each unseen posting
        S->>D: re-fetch to check liveness
        alt confirmed gone
            S->>DB: expire now
        else inconclusive
            Note over S,DB: leave live, defer to sweep
        end
    end
    S->>DB: sweep: expire anything missing 2+ scans
    S->>DB: close scan unit (totals + diff)
    S-->>U: "+N new, -N gone, expired N"
```

## What you see after a re-scan

### CLI

The scan summary line reports the directory diff and expiries, e.g. `+3 new companies, -1 gone,
expired 5 posting(s)`. The `list` command then shows currently-live matches, highest score first;
expired and dismissed postings are hidden. There is **no per-posting "new this run" label** in the
CLI — the diff totals are the signal.

### Web dashboard

- **Overview** tab shows the latest scan's directory diff — companies that are *N new* and *N no
  longer listed*, each expandable.
- **Matches** hides expired postings by default. A **Show expired** toggle reveals them, rendered
  dimmed with an "expired" badge — so a posting you applied to that later closed is still findable,
  not silently dropped.
- During a scan, a live progress indicator reports the current phase (reading the directory, scoring,
  re-checking open roles).

Like the CLI, individual matches aren't tagged "new since last scan" — newness surfaces through the
Overview diff, not a per-posting badge.

## FAQ

**Does a re-scan delete my old data?** No. Postings are never deleted — they're marked expired and
hidden by default. Scores are overwritten (no history), but the posting row and your dismiss/apply
actions persist.

**A posting I applied to vanished — where is it?** It was expired (the role closed or dropped from
its board). Use **Show expired** in the dashboard to find it.

**Why was a posting expired when the role is clearly still open?** Most likely its board was
temporarily unreachable across two scans and the stale sweep aged it out. The next successful scan
that sees it will **revive** it automatically.

**Can I avoid re-paying for LLM scoring on every scan?** Not currently — re-scoring is unconditional.
Scan deliberately rather than on a frequent auto-refresh if API cost is a concern, or use the free
heuristic scorer (no API key).

**Does "gone company" mean it's deleted?** No — it means the company left the directory (or you
untracked it). Its already-discovered postings remain until they expire on their own.

---

> **TODO — user-facing wiki.** This doc is engineering-oriented. A friendlier, task-oriented wiki
> (getting started, "why is my match list empty?", scoring explained, FAQ) would help non-technical
> users understand the tool. Tracked as a backlog item — see the linked issue.
