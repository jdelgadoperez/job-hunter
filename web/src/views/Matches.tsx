import { useState } from "react";
import type { ScoredPosting } from "../api";
import { Card, Empty, ErrorNote, Loading, ScorePill } from "../components/ui";
import { useMatches } from "../hooks";

function MatchCard({ posting, result }: ScoredPosting) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <a
            href={posting.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-indigo-700 hover:underline"
          >
            {posting.title}
          </a>
          <p className="text-sm text-slate-500">
            {posting.company}
            {posting.location ? ` · ${posting.location}` : ""}
          </p>
        </div>
        <ScorePill score={result.score} />
      </div>
      {result.rationale ? <p className="mt-2 text-sm text-slate-700">{result.rationale}</p> : null}
      {result.matchedSkills.length > 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          <span className="font-semibold text-emerald-700">Matched:</span>{" "}
          {result.matchedSkills.join(", ")}
        </p>
      ) : null}
      {result.missingSkills.length > 0 ? (
        <p className="mt-1 text-xs text-slate-500">
          <span className="font-semibold text-amber-700">Missing:</span>{" "}
          {result.missingSkills.join(", ")}
        </p>
      ) : null}
    </Card>
  );
}

export function Matches() {
  // Default to a 50 floor so the list leads with genuinely relevant matches.
  const [minScore, setMinScore] = useState(50);
  const matches = useMatches(minScore);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <label htmlFor="minScore" className="text-sm text-slate-600">
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
            <MatchCard key={m.posting.id} posting={m.posting} result={m.result} />
          ))}
        </div>
      )}
    </section>
  );
}
