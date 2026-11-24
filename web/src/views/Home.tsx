import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { type ChangeEvent, useEffect, useState } from "react";
import type { CompanyRef, ScanRecord, ScorePreview } from "../api";
import {
  Button,
  Card,
  CardHeader,
  ErrorNote,
  LiveStatus,
  Loading,
  PageHeader,
  ProgressBar,
} from "../components/ui";
import { formatAbsoluteTime, formatCount, formatRelativeTime } from "../format";
import {
  useLatestScan,
  useProfile,
  useScanStatus,
  useScorePreview,
  useScoreStatus,
  useSettings,
  useStartDeepScore,
  useStartScan,
  useUploadResume,
} from "../hooks";

/** User-facing label for each scan kind, shown next to the "Last scan" timestamp. */
const SCAN_KIND_LABEL: Record<ScanRecord["kind"], string> = {
  full: "Full scan",
  incremental: "Incremental scan",
  retry: "Retry scan",
};

/** @param active Whether this tab is the one currently visible. When `false` (e.g. the user has
 *  switched to another tab), status polling is suppressed while the view stays mounted and its
 *  cached data stays readable — see the "Keep every tab mounted" comment in App.tsx. */
export function Home({ active = true }: { active?: boolean } = {}) {
  const profile = useProfile();
  const upload = useUploadResume();
  const scan = useScanStatus({ enabled: active });
  const startScan = useStartScan();
  const latestScan = useLatestScan();
  const scoreStatus = useScoreStatus({ enabled: active });
  const settings = useSettings();
  const qc = useQueryClient();

  const status = scan.data;
  const running = status?.state === "running";
  const scoring = scoreStatus.data?.state === "running";

  // A finished deep-score means re-ranked matches — refresh them.
  const scoreFinishedAt = scoreStatus.data?.state === "done" ? scoreStatus.data.finishedAt : null;
  useEffect(() => {
    if (scoreFinishedAt) qc.invalidateQueries({ queryKey: ["matches"] });
  }, [scoreFinishedAt, qc]);

  // A scan that finishes in the background (e.g. the scheduled refresh) should refresh matches too.
  // Keying on finishedAt re-runs this for each completed scan, not just the first.
  const finishedAt = status?.state === "done" ? status.finishedAt : null;
  useEffect(() => {
    if (finishedAt) {
      qc.invalidateQueries({ queryKey: ["matches"] });
      qc.invalidateQueries({ queryKey: ["latest-scan"] });
    }
  }, [finishedAt, qc]);

  const startedAt = running ? status?.startedAt : null;

  const [fileError, setFileError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rescanAll, setRescanAll] = useState(false);

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    // Pre-flight checks so a wrong-type or oversized file fails instantly instead of after an
    // upload round-trip. The server enforces both too (the source of truth); this is just UX.
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["txt", "md", "pdf", "docx"].includes(ext)) {
      setFileError("Unsupported file type. Use a .txt, .md, .pdf, or .docx resume.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setFileError("That file is over the 10MB limit.");
      return;
    }
    setFileError(null);
    upload.mutate(file);
  }

  if (profile.isPending) return <Loading label="Loading…" />;
  // A failed /api/profile fetch (500, network error, or a zod schema-drift parse failure) must not
  // fall through to the "no profile yet" empty state below — that would tell a user who already
  // uploaded a resume they have none, with no hint the request failed.
  if (profile.isError) return <ErrorNote error={profile.error} />;

  const skills = profile.data?.skills ?? [];

  // The header's one line about the data: when the matches were last refreshed, and how widely.
  const lastRan = latestScan.data
    ? formatRelativeTime(latestScan.data.finishedAt ?? latestScan.data.startedAt)
    : null;
  const headerLine = latestScan.data
    ? `Last scanned ${lastRan ?? "recently"} across ${formatCount(latestScan.data.companiesSeen ?? 0)} companies.`
    : "Upload your resume, then scan to find roles that fit it.";

  return (
    <section className="space-y-5">
      <PageHeader title="Home" description={headerLine} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <Card>
            <CardHeader
              title="Scan for jobs"
              action={
                <>
                  <label className="flex h-9 cursor-pointer items-center gap-2 px-1 text-sm text-muted hover:text-fg">
                    <input
                      type="checkbox"
                      className="control"
                      checked={rescanAll}
                      onChange={(e) => setRescanAll(e.target.checked)}
                      disabled={running || scoring || startScan.isPending}
                    />
                    Rescan all
                  </label>
                  <Button
                    onClick={() => startScan.mutate(rescanAll ? "full" : "incremental")}
                    disabled={running || scoring || startScan.isPending}
                  >
                    {running ? "Scanning…" : "Scan now"}
                  </Button>
                </>
              }
            />
            <p className="mt-1 max-w-[68ch] text-sm text-muted">
              Find open roles from the stillhiring.today directory and your tracked companies, then
              give each a fast, free keyword score against your resume. Skips companies checked
              recently — tick “Rescan all” to re-visit every company now.
            </p>

            {running ? (
              <div className="mt-4 rounded-md bg-raised p-4" aria-live="polite" aria-atomic="true">
                <LiveStatus
                  message={status?.message ?? "Working…"}
                  meta={
                    <>
                      · <ElapsedTimer startedAt={startedAt} />s
                    </>
                  }
                />
                {status?.total ? (
                  <ProgressBar current={status.current ?? 0} total={status.total} />
                ) : null}
                {status && status.recent.length > 0 ? (
                  <ul className="mt-3 max-h-36 overflow-auto rounded-md bg-code-bg p-3 font-mono text-xs leading-relaxed text-code-fg">
                    {status.recent.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {/* The status poll itself failed (server died, network dropped) while the last-known state is
                still "running". Without this, TanStack Query keeps the stale "running" data and the
                spinner above would loop forever with no sign anything went wrong. */}
            {scan.isError ? (
              <p className="mt-2 text-sm text-danger" aria-live="assertive">
                Lost contact with the scan — it may still be running in the background. Reload to
                check its status. (
                {scan.error instanceof Error ? scan.error.message : String(scan.error)})
              </p>
            ) : null}

            {status?.state === "done" ? (
              <>
                <p className="mt-4 flex items-center gap-2 text-sm text-fg">
                  <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full bg-success" />
                  {status.message} — see the Matches tab.
                </p>
                {status.warnings.length > 0 ? (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-warning hover:underline">
                      {status.warnings.length} warning(s) — companies that didn't load
                    </summary>
                    <ul className="mt-1 list-disc pl-5 text-faint">
                      {status.warnings.map((w) => (
                        <li key={`${w.source}:${w.message}`}>
                          {w.source ? `${w.source}: ` : ""}
                          {w.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            ) : null}

            {status?.state === "error" ? (
              <p className="mt-2 text-sm text-danger">{status.error}</p>
            ) : null}

            <p className="mt-3 text-xs text-faint">
              Scans run in the background — you can switch tabs or close this page; it keeps going.
            </p>
          </Card>

          <DeepScoreCard
            hasKey={settings.data?.hasAnthropicKey ?? false}
            scanRunning={running}
            active={active}
          />
        </div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          <Card>
            <CardHeader
              title="Your profile"
              meta={skills.length > 0 ? `${skills.length} skill(s)` : undefined}
            />
            {skills.length > 0 ? (
              <>
                <p className="sr-only">
                  {skills.length} skill(s) extracted: {skills.slice(0, 12).join(", ")}
                </p>
                <ul aria-hidden="true" className="mt-3 flex flex-wrap gap-1.5">
                  {skills.slice(0, 12).map((skill) => (
                    <li key={skill} className="rounded bg-subtle px-2 py-0.5 text-xs text-fg">
                      {skill}
                    </li>
                  ))}
                  {skills.length > 12 ? (
                    <li className="num px-1 py-0.5 text-xs text-faint">
                      +{formatCount(skills.length - 12)} more
                    </li>
                  ) : null}
                </ul>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted">
                No profile yet — upload a resume to build one.
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
              <label
                className={`inline-flex h-9 items-center gap-2 rounded-md border border-control bg-surface px-3.5 text-sm font-medium text-fg transition-colors hover:border-faint hover:bg-raised focus-within:ring-3 focus-within:ring-ring/30 ${
                  upload.isPending ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                }`}
              >
                <Upload size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>{skills.length > 0 ? "Replace resume" : "Choose resume"}</span>
                <input
                  type="file"
                  accept=".txt,.md,.pdf,.docx"
                  onChange={onFile}
                  disabled={upload.isPending}
                  className="sr-only"
                />
              </label>
              {fileName ? (
                <span className="min-w-0 truncate text-sm text-faint" title={fileName}>
                  {fileName}
                </span>
              ) : (
                <span className="text-xs text-faint">.txt, .md, .pdf, or .docx</span>
              )}
              {upload.isPending ? <span className="text-sm text-faint">Parsing…</span> : null}
            </div>
            {fileError ? <p className="mt-2 text-sm text-danger">{fileError}</p> : null}
            {upload.isError ? (
              <p className="mt-2 text-sm text-danger">{String(upload.error)}</p>
            ) : null}
          </Card>

          {latestScan.data ? (
            <Card>
              <CardHeader
                title="Last scan"
                meta={(() => {
                  const ranAt = latestScan.data.finishedAt ?? latestScan.data.startedAt;
                  const relative = formatRelativeTime(ranAt);
                  return relative ? (
                    <span title={formatAbsoluteTime(ranAt) ?? undefined}>
                      {SCAN_KIND_LABEL[latestScan.data.kind]} · {relative}
                    </span>
                  ) : undefined;
                })()}
              />
              <dl className="mt-4 grid grid-cols-2 divide-x divide-border rounded-md bg-raised py-3">
                <div className="px-4">
                  <dt className="text-xs text-muted">Companies</dt>
                  <dd className="num mt-1 text-2xl font-semibold tracking-[-0.01em] text-fg">
                    {formatCount(latestScan.data.companiesSeen ?? 0)}
                  </dd>
                </div>
                <div className="px-4">
                  <dt className="text-xs text-muted">Postings scored</dt>
                  <dd className="num mt-1 text-2xl font-semibold tracking-[-0.01em] text-fg">
                    {formatCount(latestScan.data.postingsSeen ?? 0)}
                  </dd>
                </div>
              </dl>
              <p className="sr-only">
                {formatCount(latestScan.data.companiesSeen ?? 0)} companies ·{" "}
                {formatCount(latestScan.data.postingsSeen ?? 0)} postings scored
              </p>
              {latestScan.data.newCompanies.length === 0 &&
              latestScan.data.removedCompanies.length === 0 ? (
                <p className="mt-3 text-sm text-muted">No directory changes since the last scan.</p>
              ) : (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <CompanyDelta
                    tone="success"
                    label={`${formatCount(latestScan.data.newCompanies.length)} new`}
                    companies={latestScan.data.newCompanies}
                  />
                  <CompanyDelta
                    tone="warning"
                    label={`${formatCount(latestScan.data.removedCompanies.length)} no longer listed`}
                    companies={latestScan.data.removedCompanies}
                  />
                </div>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * Deep-score with the LLM: a two-step preview → run flow. Disabled without an Anthropic key or
 * while a scan runs (the two mutate the same posting set, so they're mutually exclusive). Preview is
 * a free dry-run showing the plan + estimated cost; the run spends real money, so it's gated behind
 * the preview.
 */
function DeepScoreCard({
  hasKey,
  scanRunning,
  active,
}: {
  hasKey: boolean;
  scanRunning: boolean;
  active: boolean;
}) {
  const scoreStatus = useScoreStatus({ enabled: active });
  const preview = useScorePreview();
  const startDeepScore = useStartDeepScore();

  const [remoteOnly, setRemoteOnly] = useState(false);
  const [limit, setLimit] = useState(100);
  const [rescore, setRescore] = useState(false);

  const running = scoreStatus.data?.state === "running";
  const done = scoreStatus.data?.state === "done" ? scoreStatus.data : null;
  const errored = scoreStatus.data?.state === "error" ? scoreStatus.data : null;
  const previewData: ScorePreview | undefined = preview.data;

  const options = { remoteOnly, limit, rescore };
  const blocked = !hasKey || scanRunning || running;

  function runPreview() {
    preview.mutate(options);
  }
  function runDeepScore() {
    startDeepScore.mutate(options, { onSuccess: () => preview.reset() });
  }
  function changeOption<T>(setter: (value: T) => void, value: T) {
    setter(value);
    preview.reset(); // a prior estimate no longer describes the pending run
  }

  return (
    <Card>
      <CardHeader title="Deep-score with Claude" />
      <p className="mt-1 max-w-[68ch] text-sm text-muted">
        Score postings with Claude — it reads the full job description against your resume for
        sharper relevance than the keyword pre-filter. Costs money — preview the estimate first. By
        default only postings not already deep-scored are scored, so re-running picks up new roles
        without paying to re-score the same ones. Tick “Re-score already-scored” to score everything
        again.
      </p>
      <p className="mt-2 max-w-[68ch] text-xs leading-relaxed text-faint">
        <span className="font-semibold text-muted">Limit</span> caps how many postings this run
        scores — highest heuristic matches first — so you can control the cost per run. It counts
        only postings that will actually be scored (already-scored ones are skipped unless you
        re-score), so if you have a large backlog, run it repeatedly with the limit you’re
        comfortable paying for and each run works further down the list.
      </p>

      {running && scoreStatus.data ? (
        <div className="mt-4 rounded-md bg-raised p-4" aria-live="polite" aria-atomic="true">
          <LiveStatus message={scoreStatus.data.message ?? "Scoring…"} />
          {scoreStatus.data.total ? (
            <ProgressBar current={scoreStatus.data.current ?? 0} total={scoreStatus.data.total} />
          ) : null}
          {scoreStatus.data.recent.length > 0 ? (
            <ul className="mt-3 max-h-36 overflow-auto rounded-md bg-code-bg p-3 font-mono text-xs leading-relaxed text-code-fg">
              {scoreStatus.data.recent.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Same as the scan card: a failed status poll while the last-known state is "running" would
          otherwise leave the "Scoring…" spinner looping forever with no error. */}
      {scoreStatus.isError ? (
        <p className="mt-3 text-sm text-danger" aria-live="assertive">
          Lost contact with the deep-score run — it may still be running in the background. Reload
          to check its status. (
          {scoreStatus.error instanceof Error
            ? scoreStatus.error.message
            : String(scoreStatus.error)}
          )
        </p>
      ) : null}

      {!hasKey ? (
        <p className="mt-4 rounded-md bg-pill-warning-bg px-3 py-2 text-sm text-pill-warning-ink">
          Add an Anthropic API key in Settings to enable deep-scoring.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-muted hover:text-fg">
              <input
                type="checkbox"
                className="control"
                checked={remoteOnly}
                onChange={(e) => changeOption(setRemoteOnly, e.target.checked)}
                disabled={blocked}
              />
              Remote only
            </label>
            <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-muted hover:text-fg">
              <input
                type="checkbox"
                className="control"
                checked={rescore}
                onChange={(e) => changeOption(setRescore, e.target.checked)}
                disabled={blocked}
              />
              Re-score already-scored
            </label>
            <label className="flex items-center gap-2 text-sm text-muted">
              Limit
              <input
                type="number"
                min={1}
                value={limit}
                onChange={(e) => changeOption(setLimit, Math.max(1, Number(e.target.value) || 1))}
                disabled={blocked}
                className="select num w-20"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={runPreview}
              disabled={blocked || preview.isPending}
            >
              {preview.isPending ? "Estimating…" : "Preview"}
            </Button>
            <Button
              onClick={runDeepScore}
              disabled={blocked || startDeepScore.isPending || !previewData}
            >
              {running ? "Scoring…" : "Deep-score"}
            </Button>
          </div>

          {scanRunning ? (
            <p
              className="mt-4 flex items-center gap-2 rounded-md bg-raised px-3 py-2 text-sm text-muted"
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent"
              />
              Waiting for the scan to finish — deep-scoring is paused until it's done.
            </p>
          ) : null}

          {previewData ? (
            <p className="num mt-3 text-sm text-muted">
              ~{formatCount(previewData.counts.triageTitles)} posting(s) to score · est.{" "}
              <span className="font-semibold text-fg">
                ${previewData.estimate.totalUsd.toFixed(2)}
              </span>
            </p>
          ) : null}
          {preview.isError ? (
            <p className="mt-2 text-sm text-danger">{String(preview.error)}</p>
          ) : null}

          {done ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-fg" aria-live="polite">
              <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full bg-success" />
              Deep-scored {formatCount(done.counts?.deepScored ?? 0)} posting(s) — see the Matches
              tab.
              {done.abortedOnLimit ? " Stopped early — provider usage/rate limit reached." : ""}
            </p>
          ) : null}
          {errored ? <p className="mt-2 text-sm text-danger">{errored.error}</p> : null}
          {startDeepScore.isError ? (
            <p className="mt-2 text-sm text-danger">{String(startDeepScore.error)}</p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** The elapsed seconds since a scan started, ticking once a second. Isolated into its own component
 *  so the interval re-renders only this counter, not the whole Home tree. */
function ElapsedTimer({ startedAt }: { startedAt: string | null | undefined }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return <>{elapsed}</>;
}

function CompanyDelta({
  tone,
  label,
  companies,
}: {
  tone: "success" | "warning";
  label: string;
  companies: CompanyRef[];
}) {
  const sign = tone === "success" ? "+" : "−";
  const color = tone === "success" ? "text-success" : "text-fg";
  const shown = companies.slice(0, 8);
  return (
    <div>
      <p className={`num text-sm font-medium ${color}`}>
        {sign}
        {label}
      </p>
      {companies.length === 0 ? (
        <p className="mt-1 text-xs text-faint">—</p>
      ) : (
        <ul className="mt-1.5 space-y-1 text-xs text-muted">
          {shown.map((c) => (
            <li key={c.careersUrl} className="truncate">
              {c.name ?? c.careersUrl}
            </li>
          ))}
          {companies.length > shown.length ? (
            <li className="text-faint">…and {formatCount(companies.length - shown.length)} more</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
