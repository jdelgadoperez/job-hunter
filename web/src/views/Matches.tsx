import { useState } from "react";
import type { ScoredPosting } from "../api";
import { Button, Card, Empty, ErrorNote, Loading, ScorePill } from "../components/ui";
import { useMatchAction, useMatches } from "../hooks";

function MatchCard({ posting, result, action, expired }: ScoredPosting) {
  const setAction = useMatchAction();
  const saved = action === "saved";

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
  const matches = useMatches(minScore, { includeExpired, includeDismissed });

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
            />
          ))}
        </div>
      )}
    </section>
  );
}
