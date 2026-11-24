import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Search } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { CompanyOverview } from "../api";
import {
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  Pill,
} from "../components/ui";
import { formatAbsoluteTime, formatCount, formatRelativeTime } from "../format";
import {
  useAddCompany,
  useAllCompanies,
  useCompanies,
  useManualReviewCompanies,
  useNeedsAttention,
  useRemoveCompany,
  useRetryFailedScan,
  useScanStatus,
} from "../hooks";

type CompanyEntry = { careersUrl: string; name?: string };

/** The label a company is shown under — and what we sort by. */
const label = (c: CompanyEntry) => c.name ?? c.careersUrl;

/** Sort companies by display label, case-insensitively (locale-aware). */
const byLabel = (a: CompanyEntry, b: CompanyEntry) =>
  label(a).localeCompare(label(b), undefined, { sensitivity: "base" });

/** A careers URL without its scheme, for compact display under a company's name. */
const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "");

/** How each scan method reads to a person. Unknown sources fall back to the raw value. */
const METHOD_LABEL: Record<string, string> = {
  ashby: "Ashby",
  bamboohr: "BambooHR",
  breezy: "Breezy",
  browser: "Web page",
  greenhouse: "Greenhouse",
  lever: "Lever",
  manual: "Not scanned",
  recruitee: "Recruitee",
  rippling: "Rippling",
  smartrecruiters: "SmartRecruiters",
  ukg: "UKG",
  workable: "Workable",
  workday: "Workday",
};
const methodLabel = (method: string) => METHOD_LABEL[method] ?? method;

const FILTERS = ["All", "Tracked", "Failing", "Not scanned"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_TEST: Record<Filter, (c: CompanyOverview) => boolean> = {
  All: () => true,
  Tracked: (c) => c.tracked,
  Failing: (c) => c.failure !== null,
  "Not scanned": (c) => c.method === "manual",
};

/** Rows rendered per page of the All companies table — the directory runs to thousands. */
const PAGE_SIZE = 100;

/** Rows shown in a side list before it folds behind "Show all". */
const SIDE_LIST_CAP = 6;

/** Untracking a company is permanent, so a single click only arms a confirm; the actual
 *  removal only fires on the follow-up "Confirm" click. "Cancel" (or re-render, since
 *  `confirming` is local state) backs out without side effects. */
function RemoveButton({ onRemove, pending }: { onRemove: () => void; pending: boolean }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)} disabled={pending}>
        Remove
      </Button>
    );
  }

  return (
    <span className="flex flex-none items-center gap-1">
      <Button variant="ghost" onClick={onRemove} disabled={pending} className="text-danger">
        Confirm
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** @param active Whether this tab is the one currently visible. When `false` (e.g. the user has
 *  switched to another tab), status polling is suppressed while the view stays mounted and its
 *  cached data stays readable — see the "Keep every tab mounted" comment in App.tsx. */
export function Companies({ active = true }: { active?: boolean } = {}) {
  const companies = useCompanies();
  const all = useAllCompanies();
  const manualReview = useManualReviewCompanies();
  const needsAttention = useNeedsAttention();
  const addCompany = useAddCompany();
  const removeCompany = useRemoveCompany();
  const retryFailedScan = useRetryFailedScan();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [showAllManual, setShowAllManual] = useState(false);

  const qc = useQueryClient();
  const scanStatus = useScanStatus({ enabled: active });
  // A scan (including the Rescan button's retry scan) runs in the background; when it finishes, a
  // company may have recovered and been cleared from failed_leads, and every company's last-checked
  // time and open-role count has moved. Refresh both without a page reload. Keyed on finishedAt so
  // each completed scan re-runs.
  const finishedAt = scanStatus.data?.state === "done" ? scanStatus.data.finishedAt : null;
  useEffect(() => {
    if (finishedAt) {
      qc.invalidateQueries({ queryKey: ["companies", "needs-attention"] });
      qc.invalidateQueries({ queryKey: ["companies", "all"] });
    }
  }, [finishedAt, qc]);

  const sortedCompanies = useMemo(
    () => (companies.data ? [...companies.data].sort(byLabel) : []),
    [companies.data],
  );
  const sortedManualReview = useMemo(
    () => (manualReview.data ? [...manualReview.data].sort(byLabel) : []),
    [manualReview.data],
  );
  const shownManualReview = showAllManual
    ? sortedManualReview
    : sortedManualReview.slice(0, SIDE_LIST_CAP);

  function add(e: FormEvent) {
    e.preventDefault();
    const careersUrl = url.trim();
    if (!careersUrl) return;
    // Mirror the server's protocol check client-side so an ftp:/mailto: URL fails fast with inline
    // feedback instead of a round-trip 400. (type="url" alone accepts those schemes.)
    if (!/^https?:\/\//i.test(careersUrl)) {
      setUrlError("Enter a URL starting with http:// or https://");
      return;
    }
    setUrlError(null);
    addCompany.mutate(
      { careersUrl, name: name.trim() || undefined },
      {
        onSuccess: () => {
          setUrl("");
          setName("");
        },
      },
    );
  }

  const hasNeedsAttention = (needsAttention.data?.length ?? 0) > 0;
  const hasManualReview = sortedManualReview.length > 0;
  const hasSidePanels = hasNeedsAttention || hasManualReview;

  // The header's one line about the data: how many companies a scan covers, and how many need you.
  const summary = all.data
    ? (() => {
        const total = all.data.length;
        const tracked = all.data.filter((c) => c.tracked).length;
        const failing = all.data.filter((c) => c.failure !== null).length;
        const parts = [
          `${formatCount(total)} ${total === 1 ? "company" : "companies"} known`,
          `${formatCount(tracked)} tracked by you`,
        ];
        if (failing > 0) parts.push(`${formatCount(failing)} failing`);
        return parts.join(" · ");
      })()
    : "The stillhiring.today directory plus the companies you track.";

  return (
    <section className="space-y-5">
      <PageHeader title="Companies" description={summary} />

      <div
        className={`grid grid-cols-[minmax(0,1fr)] items-start gap-4 ${hasSidePanels ? "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : ""}`}
      >
        <Card>
          <CardHeader
            title="Track a company"
            meta={companies.data ? `${formatCount(companies.data.length)} tracked` : undefined}
          />
          <p className="mt-1 text-sm text-muted">
            Add a company by its careers-page URL — it's scanned alongside the public directory.
          </p>
          <form onSubmit={add} className="mt-4 flex flex-wrap gap-2">
            <input
              type="url"
              aria-label="Careers page URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://boards.greenhouse.io/company"
              className="input mt-0 min-w-0 flex-[1_1_14rem]"
            />
            <input
              aria-label="Company name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional)"
              className="input mt-0 w-44"
            />
            <Button type="submit" disabled={addCompany.isPending || !url.trim()}>
              Add
            </Button>
          </form>
          {urlError ? <p className="mt-2 text-sm text-danger">{urlError}</p> : null}
          {addCompany.isError ? (
            <div className="mt-2">
              <ErrorNote error={addCompany.error} />
            </div>
          ) : null}

          <div className="mt-4">
            {companies.isPending ? (
              <Loading label="Loading companies…" />
            ) : companies.isError ? (
              <ErrorNote error={companies.error} />
            ) : companies.data.length === 0 ? (
              <Empty>No tracked companies yet.</Empty>
            ) : (
              <ul className="-mx-5 divide-y divide-rule border-t border-rule">
                {sortedCompanies.map((c) => (
                  <li
                    key={c.careersUrl}
                    className="flex min-h-14 items-center justify-between gap-3 px-5 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-fg">{c.name ?? c.careersUrl}</p>
                      <a
                        href={c.careersUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-xs text-faint hover:text-fg hover:underline"
                      >
                        {c.careersUrl}
                      </a>
                    </div>
                    <RemoveButton
                      onRemove={() => removeCompany.mutate(c.careersUrl)}
                      pending={removeCompany.isPending && removeCompany.variables === c.careersUrl}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {hasSidePanels ? (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
            {hasNeedsAttention && needsAttention.data ? (
              <Card>
                <CardHeader
                  title={`Needs attention (${formatCount(needsAttention.data.length)})`}
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => retryFailedScan.mutate()}
                      disabled={retryFailedScan.isPending}
                    >
                      Rescan
                    </Button>
                  }
                />
                <p className="mt-1 text-sm text-muted">
                  These companies have failed to fetch on 5+ consecutive scans — they're still
                  crawled normally, but no longer auto-retried within a run. Rescan to try them
                  again now.
                </p>
                <ul className="mt-3 space-y-2">
                  {needsAttention.data.map((c) => (
                    <li key={c.careersUrl} className="text-sm">
                      <span className="font-medium text-fg">{c.company}</span>{" "}
                      <span className="text-muted">
                        — {c.message} ({c.consecutiveFailures} scans)
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {hasManualReview ? (
              <Card>
                <CardHeader title={`Review manually (${formatCount(sortedManualReview.length)})`} />
                <p className="mt-1 text-sm text-muted">
                  These directory companies post on sites we don't auto-scan (LinkedIn/Indeed) —
                  open them to check their roles yourself.
                </p>
                <ul className="mt-3 divide-y divide-rule">
                  {shownManualReview.map((c) => (
                    <li
                      key={c.careersUrl}
                      className="flex h-10 items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate text-fg">{c.name ?? c.careersUrl}</span>
                      <a
                        href={c.careersUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex flex-none items-center gap-1 text-muted hover:text-fg"
                      >
                        open <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
                {sortedManualReview.length > SIDE_LIST_CAP ? (
                  <Button
                    variant="ghost"
                    className="mt-2 -ml-2.5"
                    onClick={() => setShowAllManual((v) => !v)}
                  >
                    {showAllManual
                      ? "Show fewer"
                      : `Show all ${formatCount(sortedManualReview.length)}`}
                  </Button>
                ) : null}
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>

      <AllCompanies query={all} />
    </section>
  );
}

/**
 * Every company the engine knows about — the directory plus your tracked list — with how a scan
 * reads it, its open roles, when it was last checked and whether it is failing. Searchable and
 * filterable, rendered a page at a time.
 */
function AllCompanies({ query }: { query: ReturnType<typeof useAllCompanies> }) {
  const [filter, setFilter] = useState<Filter>("All");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState(1);

  const rows = query.data ?? [];
  const needle = search.trim().toLowerCase();
  const counts = useMemo(() => {
    const out = {} as Record<Filter, number>;
    for (const f of FILTERS) out[f] = rows.filter(FILTER_TEST[f]).length;
    return out;
  }, [rows]);
  const filtered = useMemo(
    () =>
      rows.filter(
        (c) =>
          FILTER_TEST[filter](c) &&
          (needle === "" ||
            label(c).toLowerCase().includes(needle) ||
            c.careersUrl.toLowerCase().includes(needle)),
      ),
    [rows, filter, needle],
  );
  const visible = filtered.slice(0, pages * PAGE_SIZE);

  return (
    <Card flush>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <CardHeader
          title="All companies"
          meta={
            query.data
              ? filtered.length === rows.length
                ? formatCount(rows.length)
                : `${formatCount(filtered.length)} of ${formatCount(rows.length)}`
              : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="flex h-9 max-w-full min-w-0 items-center overflow-x-auto rounded-md bg-subtle p-0.5">
            <legend className="sr-only">Show</legend>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => {
                  setFilter(f);
                  setPages(1);
                }}
                className={`flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 ${
                  filter === f
                    ? "bg-surface font-medium text-fg shadow-[0_0_0_1px_var(--color-border)]"
                    : "text-muted hover:text-fg"
                }`}
              >
                {f}
                {query.data ? (
                  <span className="num text-xs text-faint">{formatCount(counts[f])}</span>
                ) : null}
              </button>
            ))}
          </fieldset>
          <div className="relative">
            <Search
              size={15}
              strokeWidth={1.75}
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
            />
            <input
              type="search"
              aria-label="Search all companies"
              placeholder="Search companies…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPages(1);
              }}
              className="select w-56 pl-9"
            />
          </div>
        </div>
      </div>

      <div className="mt-4">
        {query.isPending ? (
          <Loading label="Loading companies…" />
        ) : query.isError ? (
          <div className="px-5 pb-5">
            <ErrorNote error={query.error} />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 pb-5">
            <Empty>No companies yet. Run a scan from the Home tab to load the directory.</Empty>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 pb-5">
            <Empty>No companies match this filter.</Empty>
          </div>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-xs text-faint">
                <th scope="col" className="h-9 px-5 font-normal">
                  Company
                </th>
                <th scope="col" className="hidden h-9 w-36 px-3 font-normal sm:table-cell">
                  Scanned via
                </th>
                <th scope="col" className="h-9 w-24 px-3 text-right font-normal">
                  Open roles
                </th>
                <th
                  scope="col"
                  className="hidden h-9 w-36 px-3 text-right font-normal md:table-cell"
                >
                  Last checked
                </th>
                <th scope="col" className="hidden h-9 w-44 px-5 font-normal sm:table-cell">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule border-t border-rule">
              {visible.map((c) => (
                <CompanyRow key={c.careersUrl} company={c} />
              ))}
            </tbody>
          </table>
        )}
        {filtered.length > visible.length ? (
          <div className="flex justify-center border-t border-rule px-5 py-3">
            <Button variant="ghost" onClick={() => setPages((n) => n + 1)}>
              Show more ({formatCount(filtered.length - visible.length)} remaining)
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function CompanyStatus({ company }: { company: CompanyOverview }) {
  if (company.failure) {
    return (
      <Pill tone="negative" title={company.failure.message}>
        Failing · {company.failure.consecutiveFailures}{" "}
        {company.failure.consecutiveFailures === 1 ? "scan" : "scans"}
      </Pill>
    );
  }
  if (company.method === "manual") return <Pill>Review manually</Pill>;
  if (company.lastCheckedAt === null) return <span className="text-faint">Not checked yet</span>;
  return <span className="text-faint">OK</span>;
}

function CompanyRow({ company }: { company: CompanyOverview }) {
  const checked = formatRelativeTime(company.lastCheckedAt);
  return (
    <tr className="transition-colors hover:bg-raised">
      <td className="px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <a
            href={company.careersUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate font-medium text-fg hover:underline"
          >
            {label(company)}
          </a>
          {company.tracked ? <Pill>Tracked</Pill> : null}
        </div>
        <p className="truncate text-xs text-faint">{shortUrl(company.careersUrl)}</p>
        {/* Phone: the columns that fold away move to a second line, never dropped. */}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted sm:hidden">
          <span>{methodLabel(company.method)}</span>
          {checked ? <span>· {checked}</span> : null}
          <CompanyStatus company={company} />
        </div>
      </td>
      <td className="hidden px-3 py-2.5 text-muted sm:table-cell">{methodLabel(company.method)}</td>
      <td className="num px-3 py-2.5 text-right">
        {company.method === "manual" || company.lastCheckedAt === null ? (
          <span className="text-faint">—</span>
        ) : (
          <span className={company.openPostings > 0 ? "text-fg" : "text-faint"}>
            {formatCount(company.openPostings)}
          </span>
        )}
      </td>
      <td
        className="num hidden px-3 py-2.5 text-right text-muted md:table-cell"
        title={formatAbsoluteTime(company.lastCheckedAt) ?? undefined}
      >
        {checked ?? <span className="text-faint">—</span>}
      </td>
      <td className="hidden px-5 py-2.5 sm:table-cell">
        <CompanyStatus company={company} />
      </td>
    </tr>
  );
}
