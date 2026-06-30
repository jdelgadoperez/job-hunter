import { useMemo, useRef, useState } from "react";
import type { ScoredPosting } from "../api";
import { Button, Card, Empty, ErrorNote, Loading, ScorePill } from "../components/ui";
import { useMatchAction, useMatches } from "../hooks";

function MatchCard({
  posting,
  result,
  action,
  expired,
  countryFilterActive,
}: ScoredPosting & { countryFilterActive: boolean }) {
  const setAction = useMatchAction();
  const pending = setAction.isPending;
  const saved = action === "saved";
  // When the user is filtering by country, flag postings whose country couldn't be parsed — they're
  // kept in the results (we never silently drop unknowns) but the user should know why they appear.
  const showUnknownCountry = countryFilterActive && posting.country === undefined;

  return (
    <Card className={expired ? "opacity-60" : ""}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <a
            href={posting.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-link hover:underline"
          >
            {posting.title}
          </a>
          <p className="text-sm text-faint">
            {posting.company}
            {posting.location ? ` · ${posting.location}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {posting.remote ? (
            <span className="rounded-full bg-info-surface px-2 py-0.5 text-xs text-info">
              Remote
            </span>
          ) : null}
          {showUnknownCountry ? (
            <span
              className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted"
              title="The location couldn't be matched to a country, so this role is shown for every country filter."
            >
              Unknown location
            </span>
          ) : null}
          {expired ? (
            <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted">expired</span>
          ) : null}
          <ScorePill score={result.score} />
        </div>
      </div>
      {result.rationale ? <p className="mt-2 text-sm text-fg">{result.rationale}</p> : null}
      {result.matchedSkills.length > 0 ? (
        <p className="mt-2 text-xs text-faint">
          <span className="font-semibold text-success">Matched:</span>{" "}
          {result.matchedSkills.join(", ")}
        </p>
      ) : null}
      {result.missingSkills.length > 0 ? (
        <p className="mt-1 text-xs text-faint">
          <span className="font-semibold text-warning">Missing:</span>{" "}
          {result.missingSkills.join(", ")}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => setAction.mutate({ id: posting.id, action: saved ? null : "saved" })}
          className={saved ? "text-success" : ""}
        >
          {saved ? "★ Saved" : "☆ Save"}
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            setAction.mutate({ id: posting.id, action: action === "applied" ? null : "applied" })
          }
          className={action === "applied" ? "text-success" : ""}
        >
          {action === "applied" ? "✓ Applied" : "Mark applied"}
        </Button>
        {action === "dismissed" ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => setAction.mutate({ id: posting.id, action: null })}
          >
            Undismiss
          </Button>
        ) : (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => setAction.mutate({ id: posting.id, action: "dismissed" })}
          >
            Dismiss
          </Button>
        )}
      </div>
    </Card>
  );
}

export function Matches() {
  // Default to a 50 floor so the list leads with genuinely relevant matches.
  const [minScore, setMinScore] = useState(50);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [country, setCountry] = useState<string | undefined>(undefined);
  const [includeApplied, setIncludeApplied] = useState(false);
  const [onlyApplied, setOnlyApplied] = useState(false);
  // In the Applied view (onlyApplied) the include*/expired flags are meaningless — the server shows
  // exactly the applied set (expired included) — so we send only the filters that still apply. This
  // keeps the key identical to the Applied-count query (real dedup) and avoids leaking a stale
  // includeApplied into a later normal query.
  const matches = useMatches(
    minScore,
    onlyApplied
      ? { remoteOnly, country, onlyApplied: true }
      : { includeExpired, includeDismissed, remoteOnly, country, includeApplied },
  );

  // Applied count for the badge. It must agree with what the Applied view actually shows, so it
  // carries the SAME non-action filters as the main query (minScore, remoteOnly, country) plus
  // onlyApplied. When the Applied view is already active the main query IS that result (identical
  // key ⇒ TanStack serves it from cache, no extra fetch).
  const appliedCountSource = useMatches(minScore, { remoteOnly, country, onlyApplied: true });
  const appliedCount = appliedCountSource.data?.length ?? 0;

  // Country dropdown options are derived from the main query rather than a separate fetch. Selecting
  // a country narrows the main query (and thus the countries present in it), so we accumulate every
  // country we've ever seen into a persistent superset — otherwise the dropdown would collapse to
  // just the selected country and the user couldn't switch directly to another.
  // Whether any filter is narrowing the result set, so a zero-result list can say "loosen your
  // filters" instead of misleadingly telling a user with data to go run a scan. minScore > 0 counts
  // because even the default 50 floor can hide every posting in a sparse DB.
  const filtersAreActive =
    minScore > 0 ||
    includeExpired ||
    includeDismissed ||
    remoteOnly ||
    includeApplied ||
    onlyApplied ||
    country !== undefined;

  const seenCountries = useRef(new Set<string>());
  const countryOptions = useMemo(() => {
    for (const m of matches.data ?? []) {
      if (m.posting.country) seenCountries.current.add(m.posting.country);
    }
    return [...seenCountries.current].sort();
    // matches.data identity changes whenever the result set changes, which is exactly when a new
    // country could appear; recomputing then keeps the superset current.
  }, [matches.data]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor="minScore" className="text-sm text-muted">
          Minimum score: <span className="font-semibold">{minScore}</span>
        </label>
        <input
          id="minScore"
          type="range"
          min={0}
          max={100}
          step={5}
          value={minScore}
          onChange={(e) => setMinScore(Number(e.target.value))}
          className="control w-48"
        />
        {/* Show expired / Show dismissed are no-ops in the Applied view (it shows exactly the applied
            set, expired included), so hide them there. Remote/Country still narrow the applied set. */}
        {!onlyApplied ? (
          <>
            <label className="flex items-center gap-1 text-sm text-muted">
              <input
                type="checkbox"
                className="control"
                checked={includeExpired}
                onChange={(e) => setIncludeExpired(e.target.checked)}
              />
              Show expired
            </label>
            <label className="flex items-center gap-1 text-sm text-muted">
              <input
                type="checkbox"
                className="control"
                checked={includeDismissed}
                onChange={(e) => setIncludeDismissed(e.target.checked)}
              />
              Show dismissed
            </label>
          </>
        ) : null}
        <label className="flex items-center gap-1 text-sm text-muted">
          <input
            type="checkbox"
            className="control"
            checked={remoteOnly}
            onChange={(e) => setRemoteOnly(e.target.checked)}
          />
          Remote only
        </label>
        {countryOptions.length > 0 && (
          <label className="flex items-center gap-1 text-sm text-muted">
            Country:{" "}
            <select
              value={country ?? ""}
              onChange={(e) => setCountry(e.target.value || undefined)}
              className="select ml-1"
            >
              <option value="">All countries</option>
              {countryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          variant="toggle"
          pressed={onlyApplied}
          onClick={() => setOnlyApplied((v) => !v)}
          className="px-2 py-0.5"
        >
          Applied ({appliedCount})
        </Button>
        {!onlyApplied ? (
          <label className="flex items-center gap-1 text-sm text-muted">
            <input
              type="checkbox"
              className="control"
              checked={includeApplied}
              onChange={(e) => setIncludeApplied(e.target.checked)}
            />
            Show applied
          </label>
        ) : null}
      </div>

      {matches.isPending ? (
        <Loading label="Loading matches…" />
      ) : matches.isError ? (
        <ErrorNote error={matches.error} />
      ) : matches.data.length === 0 ? (
        <Empty>
          {filtersAreActive
            ? "No matches at these filters. Try lowering the minimum score or clearing filters."
            : "No matches yet. Run a scan from the Overview tab."}
        </Empty>
      ) : (
        <div className="space-y-3">
          {matches.data.map((m) => (
            <MatchCard
              key={m.posting.id}
              posting={m.posting}
              result={m.result}
              action={m.action}
              expired={m.expired}
              countryFilterActive={country !== undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
