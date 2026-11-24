import {
  Ban,
  Check,
  Globe,
  type LucideIcon,
  RotateCcw,
  Search,
  Star,
  TrendingUp,
  Users,
} from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import type { ScoredPosting } from "../api";
import { type CompanyLink, companyDisplayName, companyLinks } from "../company-links";
import {
  Button,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  Pill,
  SCORE_THRESHOLDS,
  ScorePill,
} from "../components/ui";
import { formatCount } from "../format";
import { useMatchAction, useMatches } from "../hooks";

// Semantic glyphs for each research link. lucide dropped brand marks, so these are generic icons
// (people/reviews/funding/site) — the aria-label + title carry the actual meaning.
const LINK_ICONS: Record<CompanyLink["key"], LucideIcon> = {
  website: Globe,
  glassdoor: Star,
  linkedin: Users,
  crunchbase: TrendingUp,
};

function CompanyLinksRow({ posting }: { posting: ScoredPosting["posting"] }) {
  // Use the normalized name (what the links actually search) in the label, not the raw
  // `posting.company` slug, so the tooltip/screen-reader text matches the visible company name.
  const displayName = companyDisplayName(posting.company);
  return (
    <div className="flex items-center gap-0.5">
      {companyLinks(posting).map((link) => {
        const Icon = LINK_ICONS[link.key];
        const title = `${link.label} — search for ${displayName}`;
        return (
          <a
            key={link.key}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            aria-label={title}
            title={title}
            className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
          </a>
        );
      })}
    </div>
  );
}

// Wrapped in memo so an optimistic save/dismiss/apply mutation on one card only re-renders that
// card, not the whole list — React.memo compares incoming props, and only the touched posting's
// `action`/`result` identity changes after a mutation.
// Rendering every match at once can mean 12,000+ cards in a single unvirtualized list (e.g. at
// minScore=0 on a large DB), which is slow enough to make the page feel hung. Paginate instead.
const PAGE_SIZE = 50;

const MatchCard = memo(function MatchCard({
  posting,
  result,
  action,
  expired,
  countryFilterActive,
}: ScoredPosting & { countryFilterActive: boolean }) {
  const setAction = useMatchAction();
  // Row actions sit at 32px so a row stays compact; the toolbar keeps the 36px controls.
  const rowButton = "h-8 px-2";
  const pending = setAction.isPending;
  const saved = action === "saved";
  // `action` is a single-value field (saved | dismissed | applied — see repository.ts's
  // user_actions table), so marking a saved posting applied silently replaces "saved" with no way
  // back short of re-saving. Un-applying doesn't restore it either. Arm a confirm step only for
  // that specific transition — applying an unsaved posting (the common path) stays a single click.
  const [confirmingApply, setConfirmingApply] = useState(false);
  // When the user is filtering by country, flag postings whose country couldn't be parsed — they're
  // kept in the results (we never silently drop unknowns) but the user should know why they appear.
  const showUnknownCountry = countryFilterActive && posting.country === undefined;

  return (
    <li
      className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 px-5 py-4 transition-colors hover:bg-raised ${expired ? "opacity-60" : ""}`}
    >
      <ScorePill score={result.score} />
      <div className="min-w-0">
        <a
          href={posting.url}
          target="_blank"
          rel="noreferrer"
          className="text-[15px] font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 rounded-sm"
        >
          {posting.title}
        </a>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span>
            {posting.company}
            {posting.location ? ` · ${posting.location}` : ""}
          </span>
          {posting.remote ? <Pill tone="accent">Remote</Pill> : null}
          {showUnknownCountry ? (
            <Pill title="The location couldn't be matched to a country, so this role is shown for every country filter.">
              Unknown location
            </Pill>
          ) : null}
          {expired ? (
            <span role="note" aria-label="This role has expired">
              <Pill tone="warning">
                <span aria-hidden="true">⊘&nbsp;</span>expired
              </Pill>
            </span>
          ) : null}
        </div>
        {result.rationale ? (
          <p className="mt-2 max-w-[72ch] text-sm leading-relaxed text-fg">{result.rationale}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          {result.matchedSkills.length > 0 || result.missingSkills.length > 0 ? (
            <dl className="min-w-0 space-y-0.5 text-xs leading-relaxed">
              {result.matchedSkills.length > 0 ? (
                <div className="flex gap-1.5">
                  <dt className="flex-none font-medium text-success">Matched:</dt>
                  <dd className="text-muted">{result.matchedSkills.join(", ")}</dd>
                </div>
              ) : null}
              {result.missingSkills.length > 0 ? (
                <div className="flex gap-1.5">
                  <dt className="flex-none font-medium text-warning">Missing:</dt>
                  <dd className="text-faint">{result.missingSkills.join(", ")}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <span />
          )}

          <div className="-mr-2 -mb-1 flex flex-wrap items-center gap-0.5">
            <Button
              variant="ghost"
              disabled={pending}
              aria-pressed={saved}
              onClick={() => setAction.mutate({ id: posting.id, action: saved ? null : "saved" })}
              className={`${rowButton} ${saved ? "text-accent-ink" : ""}`}
            >
              <Star
                size={15}
                strokeWidth={1.75}
                aria-hidden="true"
                className={saved ? "fill-current" : ""}
              />
              {saved ? "Saved" : "Save"}
            </Button>
            {confirmingApply ? (
              <span className="flex items-center gap-1 text-sm">
                <span className="px-1 text-muted">This will replace Saved.</span>
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setConfirmingApply(false);
                    setAction.mutate({ id: posting.id, action: "applied" });
                  }}
                  className="text-danger"
                >
                  Confirm
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingApply(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  if (action === "applied") {
                    setAction.mutate({ id: posting.id, action: null });
                  } else if (saved) {
                    setConfirmingApply(true);
                  } else {
                    setAction.mutate({ id: posting.id, action: "applied" });
                  }
                }}
                className={`${rowButton} ${action === "applied" ? "text-success" : ""}`}
              >
                <Check size={15} strokeWidth={1.75} aria-hidden="true" />
                {action === "applied" ? "Applied" : "Mark applied"}
              </Button>
            )}
            {action === "dismissed" ? (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => setAction.mutate({ id: posting.id, action: null })}
                className={rowButton}
              >
                <RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" />
                Undismiss
              </Button>
            ) : (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => setAction.mutate({ id: posting.id, action: "dismissed" })}
                className={rowButton}
              >
                <Ban size={15} strokeWidth={1.75} aria-hidden="true" />
                Dismiss
              </Button>
            )}
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
            <CompanyLinksRow posting={posting} />
          </div>
        </div>
      </div>
    </li>
  );
});

export function Matches() {
  // Default to the "relevant" floor so the list leads with genuinely relevant matches.
  const [minScore, setMinScore] = useState<number>(SCORE_THRESHOLDS.relevant);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [country, setCountry] = useState<string | undefined>(undefined);
  const [includeApplied, setIncludeApplied] = useState(false);
  const [onlyApplied, setOnlyApplied] = useState(false);
  // The controlled input value (updates per keystroke) vs the committed term that drives the query.
  // The query only re-runs on Enter or blur, so typing doesn't fire a request per character.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState<string | undefined>(undefined);
  const commitSearch = () => setSearch(searchInput.trim() || undefined);
  // In the Applied view (onlyApplied) the include*/expired flags are meaningless — the server shows
  // exactly the applied set (expired included) — so we send only the filters that still apply. This
  // keeps the key identical to the Applied-count query (real dedup) and avoids leaking a stale
  // includeApplied into a later normal query.
  const matches = useMatches(
    minScore,
    onlyApplied
      ? { remoteOnly, country, onlyApplied: true, search }
      : { includeExpired, includeDismissed, remoteOnly, country, includeApplied, search },
  );

  // Applied count for the badge. It must agree with what the Applied view actually shows, so it
  // carries the SAME non-action filters as the main query (minScore, remoteOnly, country) plus
  // onlyApplied. When the Applied view is already active the main query IS that result (identical
  // key ⇒ TanStack serves it from cache, no extra fetch).
  const appliedCountSource = useMatches(minScore, {
    remoteOnly,
    country,
    onlyApplied: true,
    search,
  });
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
    country !== undefined ||
    search !== undefined;

  const seenCountries = useRef(new Set<string>());
  const countryOptions = useMemo(() => {
    for (const m of matches.data ?? []) {
      if (m.posting.country) seenCountries.current.add(m.posting.country);
    }
    return [...seenCountries.current].sort();
    // matches.data identity changes whenever the result set changes, which is exactly when a new
    // country could appear; recomputing then keeps the superset current.
  }, [matches.data]);

  // How many pages of PAGE_SIZE cards to render. Resets to 1 whenever the query itself changes
  // (any filter, including the committed search term) so a new, narrower result set doesn't stay
  // scrolled past its own end, and a widened one doesn't dump every page back in at once.
  //
  // This is "adjusting state during render" (see react.dev/learn/you-might-not-need-an-effect):
  // comparing the new key against a ref and resetting on mismatch, rather than useEffect, avoids an
  // extra render after every filter change.
  const queryKey = JSON.stringify({
    minScore,
    includeExpired,
    includeDismissed,
    remoteOnly,
    country,
    includeApplied,
    onlyApplied,
    search,
  });
  const [visiblePages, setVisiblePages] = useState(1);
  const previousQueryKey = useRef(queryKey);
  if (previousQueryKey.current !== queryKey) {
    previousQueryKey.current = queryKey;
    setVisiblePages(1);
  }
  const visibleMatches = matches.data?.slice(0, visiblePages * PAGE_SIZE) ?? [];
  const hasMore = (matches.data?.length ?? 0) > visibleMatches.length;

  // When filtering by country, the server also returns postings whose location couldn't be parsed
  // (so they're never silently dropped — see repository.ts's listScoredPostings). Individually those
  // are flagged with the "Unknown location" badge (see showUnknownCountry above), but the aggregate
  // "Showing N matches" figure looked like N confirmed hits without that same caveat. Count them here
  // so the summary line can call that out too.
  const unknownCountryCount =
    country !== undefined
      ? (matches.data?.filter((m) => m.posting.country === undefined).length ?? 0)
      : 0;

  // Resets every filter to its default value in one action. minScore goes back to the "relevant"
  // floor (not 0) so clearing filters mirrors the initial mount state, not a maximally-broad one.
  const clearFilters = () => {
    setMinScore(SCORE_THRESHOLDS.relevant);
    setIncludeExpired(false);
    setIncludeDismissed(false);
    setRemoteOnly(false);
    setCountry(undefined);
    setIncludeApplied(false);
    setOnlyApplied(false);
    setSearchInput("");
    setSearch(undefined);
  };

  const checkLabel =
    "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted hover:text-fg";

  return (
    <section className="space-y-5">
      <PageHeader
        title="Matches"
        description="Open roles ranked against your resume, best first."
      />
      <div className="rounded-lg border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
          <div className="relative">
            <Search
              size={15}
              strokeWidth={1.75}
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
            />
            <input
              type="text"
              aria-label="Search matches"
              placeholder="Search title, company, location…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitSearch();
              }}
              onBlur={commitSearch}
              className="select w-64 max-w-full pl-9"
            />
          </div>
          <div className="flex h-9 items-center gap-3 px-1">
            <label htmlFor="minScore" className="num text-sm whitespace-nowrap text-muted">
              Minimum score: <span className="font-semibold text-fg">{minScore}</span>
            </label>
            <input
              id="minScore"
              type="range"
              min={0}
              max={100}
              step={5}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="control w-32"
            />
          </div>
          {countryOptions.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-muted">
              Country:{" "}
              <select
                value={country ?? ""}
                onChange={(e) => setCountry(e.target.value || undefined)}
                className="select"
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
          <div className="ml-auto flex items-center gap-2">
            {filtersAreActive ? (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
            <Button
              variant="toggle"
              pressed={onlyApplied}
              onClick={() => setOnlyApplied((v) => !v)}
            >
              Applied <span className="num text-faint">{formatCount(appliedCount)}</span>
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 border-t border-rule px-3 py-1">
          <label className={checkLabel}>
            <input
              type="checkbox"
              className="control"
              checked={remoteOnly}
              onChange={(e) => setRemoteOnly(e.target.checked)}
            />
            Remote only
          </label>
          {/* Show expired / Show dismissed are no-ops in the Applied view (it shows exactly the applied
            set, expired included), so hide them there. Remote/Country still narrow the applied set. */}
          {!onlyApplied ? (
            <>
              <label className={checkLabel}>
                <input
                  type="checkbox"
                  className="control"
                  checked={includeExpired}
                  onChange={(e) => setIncludeExpired(e.target.checked)}
                />
                Show expired
              </label>
              <label className={checkLabel}>
                <input
                  type="checkbox"
                  className="control"
                  checked={includeDismissed}
                  onChange={(e) => setIncludeDismissed(e.target.checked)}
                />
                Show dismissed
              </label>
              <label className={checkLabel}>
                <input
                  type="checkbox"
                  className="control"
                  checked={includeApplied}
                  onChange={(e) => setIncludeApplied(e.target.checked)}
                />
                Show applied
              </label>
            </>
          ) : null}
        </div>
      </div>

      {matches.data && matches.data.length > 0 ? (
        <p className="num text-sm text-muted">
          Showing{" "}
          <span className="font-semibold text-fg">
            {hasMore
              ? `${formatCount(visibleMatches.length)} of ${formatCount(matches.data.length)}`
              : formatCount(matches.data.length)}
          </span>{" "}
          {matches.data.length === 1 ? "match" : "matches"}
          {filtersAreActive ? " at the current filters" : ""}
          {unknownCountryCount > 0
            ? ` (${formatCount(unknownCountryCount)} with unknown location)`
            : ""}
        </p>
      ) : null}

      {matches.isPending ? (
        <Loading label="Loading matches…" />
      ) : matches.isError ? (
        <ErrorNote error={matches.error} />
      ) : matches.data.length === 0 ? (
        <Empty>
          {filtersAreActive
            ? "No matches at these filters. Try lowering the minimum score or clearing filters."
            : "No matches yet. Run a scan from the Home tab."}
        </Empty>
      ) : (
        <>
          <ul className="divide-y divide-rule overflow-hidden rounded-lg border border-border bg-surface">
            {visibleMatches.map((m) => (
              <MatchCard
                key={m.posting.id}
                posting={m.posting}
                result={m.result}
                action={m.action}
                expired={m.expired}
                countryFilterActive={country !== undefined}
              />
            ))}
          </ul>
          {hasMore ? (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setVisiblePages((n) => n + 1)}>
                Show more ({formatCount(matches.data.length - visibleMatches.length)} remaining)
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
