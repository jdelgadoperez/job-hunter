import { useState } from "react";
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
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900 dark:text-blue-200">
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
          onClick={() => setAction.mutate({ id: posting.id, action: saved ? null : "saved" })}
          className={saved ? "text-success" : ""}
        >
          {saved ? "★ Saved" : "☆ Save"}
        </Button>
        <Button
          variant="ghost"
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
            onClick={() => setAction.mutate({ id: posting.id, action: null })}
          >
            Undismiss
          </Button>
        ) : (
          <Button
            variant="ghost"
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
  const matches = useMatches(minScore, {
    includeExpired,
    includeDismissed,
    remoteOnly,
    country,
    includeApplied,
    onlyApplied,
  });

  // Dropdown options come from the SAME query WITHOUT the country filter, so the full set of
  // countries stays available even while a country is selected — otherwise selecting one country
  // would collapse the list to just that country and the user couldn't switch directly to another.
  const countrySource = useMatches(minScore, { includeExpired, includeDismissed, remoteOnly });

  // Applied count — onlyApplied query so the badge stays accurate regardless of current filter.
  // TanStack Query dedupes by key, so this is free when "Applied (N)" mode is already active.
  const appliedSource = useMatches(minScore, { onlyApplied: true });
  const appliedCount = appliedSource.data?.length ?? 0;
  const countryOptions: string[] = countrySource.data
    ? [
        ...new Set(
          countrySource.data.flatMap((m) => (m.posting.country ? [m.posting.country] : [])),
        ),
      ].sort()
    : [];

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
          className="w-48"
        />
        <label className="flex items-center gap-1 text-sm text-muted">
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(e) => setIncludeExpired(e.target.checked)}
          />
          Show expired
        </label>
        <label className="flex items-center gap-1 text-sm text-muted">
          <input
            type="checkbox"
            checked={includeDismissed}
            onChange={(e) => setIncludeDismissed(e.target.checked)}
          />
          Show dismissed
        </label>
        <label className="flex items-center gap-1 text-sm text-muted">
          <input
            type="checkbox"
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
              className="ml-1 rounded border border-border bg-surface px-1 py-0.5 text-sm"
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
        <button
          type="button"
          onClick={() => setOnlyApplied((v) => !v)}
          className={`rounded border px-2 py-0.5 text-sm ${
            onlyApplied ? "border-link bg-subtle text-fg" : "border-border text-muted"
          }`}
        >
          Applied ({appliedCount})
        </button>
        {!onlyApplied ? (
          <label className="flex items-center gap-1 text-sm text-muted">
            <input
              type="checkbox"
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
        <Empty>No matches yet. Run a scan from the Overview tab.</Empty>
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
