import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { type ChangeEvent, useEffect, useState } from "react";
import type { CompanyRef, ScorePreview } from "../api";
import { Button, Card, LiveStatus, Loading } from "../components/ui";
import { formatCount } from "../format";
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

export function Home() {
  const profile = useProfile();
  const upload = useUploadResume();
  const scan = useScanStatus();
  const startScan = useStartScan();
  const latestScan = useLatestScan();
  const scoreStatus = useScoreStatus();
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

  const skills = profile.data?.skills ?? [];

  return (
    <section className="space-y-4">
      <Card>
        <h2 className="font-semibold text-fg">1 · Your profile</h2>
        {skills.length > 0 ? (
          <p className="mt-1 text-sm text-muted">
            {skills.length} skill(s) extracted: {skills.slice(0, 12).join(", ")}
            {skills.length > 12 ? "…" : ""}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">No profile yet — upload a resume to build one.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label
            className={`inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:bg-subtle hover:text-fg focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-surface ${
              upload.isPending ? "cursor-not-allowed opacity-50" : "cursor-pointer"
            }`}
          >
            <Upload size={16} aria-hidden="true" />
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
            <span className="text-sm text-faint" title={fileName}>
              {fileName}
            </span>
          ) : (
            <span className="text-xs text-faint">.txt, .md, .pdf, or .docx</span>
          )}
          {upload.isPending ? <span className="text-sm text-faint">Parsing…</span> : null}
        </div>
        {fileError ? <p className="mt-2 text-sm text-danger">{fileError}</p> : null}
        {upload.isError ? <p className="mt-2 text-sm text-danger">{String(upload.error)}</p> : null}
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-fg">2 · Scan for jobs</h2>
          <Button
            onClick={() => startScan.mutate()}
            disabled={running || scoring || startScan.isPending}
          >
            {running ? "Scanning…" : "Scan now"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-faint">
          Find open roles from the stillhiring.today directory and your tracked companies, then give
          each a fast, free keyword score against your resume. Free and safe to re-run often — deep-
          scoring with Claude (step 3) is the paid, sharper pass on top of these results.
        </p>

        {running ? (
          <div className="mt-3" aria-live="polite">
            <LiveStatus
              message={status?.message ?? "Working…"}
              meta={
                <>
                  · <ElapsedTimer startedAt={startedAt} />s
                </>
              }
            />
            {status?.total ? (
              // Decorative bar; the live text above conveys progress to assistive tech.
              <div aria-hidden="true" className="mt-2 h-2 w-full overflow-hidden rounded bg-subtle">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((100 * (status.current ?? 0)) / status.total)}%` }}
                />
              </div>
            ) : null}
            {status && status.recent.length > 0 ? (
              <ul className="mt-2 max-h-32 overflow-auto rounded bg-code-bg p-2 font-mono text-xs text-code-fg">
                {status.recent.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {status?.state === "done" ? (
          <p className="mt-2 text-sm text-success">
            {status.message} — see the Matches tab.
            {status.warnings.length > 0 ? ` (${status.warnings.length} warning(s))` : ""}
          </p>
        ) : null}

        {status?.state === "error" ? (
          <p className="mt-2 text-sm text-danger">{status.error}</p>
        ) : null}

        <p className="mt-2 text-xs text-faint">
          Scans run in the background — you can switch tabs or close this page; it keeps going.
        </p>
      </Card>

      <DeepScoreCard hasKey={settings.data?.hasAnthropicKey ?? false} scanRunning={running} />

      {latestScan.data ? (
        <Card>
          <h2 className="font-semibold text-fg">Last scan</h2>
          <p className="mt-1 text-sm text-muted">
            {formatCount(latestScan.data.companiesSeen ?? 0)} companies ·{" "}
            {formatCount(latestScan.data.postingsSeen ?? 0)} postings scored
          </p>
          {latestScan.data.newCompanies.length === 0 &&
          latestScan.data.removedCompanies.length === 0 ? (
            <p className="mt-1 text-sm text-faint">No directory changes since the last scan.</p>
          ) : (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
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
    </section>
  );
}

/**
 * Deep-score with the LLM: a two-step preview → run flow. Disabled without an Anthropic key or
 * while a scan runs (the two mutate the same posting set, so they're mutually exclusive). Preview is
 * a free dry-run showing the plan + estimated cost; the run spends real money, so it's gated behind
 * the preview.
 */
function DeepScoreCard({ hasKey, scanRunning }: { hasKey: boolean; scanRunning: boolean }) {
  const scoreStatus = useScoreStatus();
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

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-fg">3 · Deep-score with Claude</h2>
      </div>
      <p className="mt-1 text-xs text-faint">
        Score postings with Claude — it reads the full job description against your resume for
        sharper relevance than the keyword pre-filter. Costs money — preview the estimate first. By
        default only postings not already deep-scored are scored, so re-running picks up new roles
        without paying to re-score the same ones. Tick “Re-score already-scored” to score everything
        again.
      </p>
      <p className="mt-1 text-xs text-faint">
        <span className="font-semibold text-muted">Limit</span> caps how many postings this run
        scores — highest heuristic matches first — so you can control the cost per run. It counts
        only postings that will actually be scored (already-scored ones are skipped unless you
        re-score), so if you have a large backlog, run it repeatedly with the limit you’re
        comfortable paying for and each run works further down the list.
      </p>

      {running && scoreStatus.data ? (
        <div className="mt-3" aria-live="polite">
          <LiveStatus message={scoreStatus.data.message ?? "Scoring…"} />
          {scoreStatus.data.total ? (
            // Decorative bar; the live text in the header conveys progress to assistive tech.
            <div aria-hidden="true" className="mt-2 h-2 w-full overflow-hidden rounded bg-subtle">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${Math.round(
                    (100 * (scoreStatus.data.current ?? 0)) / scoreStatus.data.total,
                  )}%`,
                }}
              />
            </div>
          ) : null}
          {scoreStatus.data.recent.length > 0 ? (
            <ul className="mt-2 max-h-32 overflow-auto rounded bg-code-bg p-2 font-mono text-xs text-code-fg">
              {scoreStatus.data.recent.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {!hasKey ? (
        <p className="mt-3 text-sm text-warning">
          Add an Anthropic API key in Settings to enable deep-scoring.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1 text-sm text-muted">
              <input
                type="checkbox"
                className="control"
                checked={remoteOnly}
                onChange={(e) => setRemoteOnly(e.target.checked)}
                disabled={blocked}
              />
              Remote only
            </label>
            <label className="flex items-center gap-1 text-sm text-muted">
              <input
                type="checkbox"
                className="control"
                checked={rescore}
                onChange={(e) => setRescore(e.target.checked)}
                disabled={blocked}
              />
              Re-score already-scored
            </label>
            <label className="flex items-center gap-1 text-sm text-muted">
              Limit
              <input
                type="number"
                min={1}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
                disabled={blocked}
                className="select ml-1 w-20"
              />
            </label>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button variant="ghost" onClick={runPreview} disabled={blocked || preview.isPending}>
              {preview.isPending ? "Estimating…" : "Preview"}
            </Button>
            <Button onClick={runDeepScore} disabled={blocked || startDeepScore.isPending}>
              {running ? "Scoring…" : "Deep-score"}
            </Button>
          </div>

          {scanRunning ? (
            <p
              className="mt-3 flex items-center gap-2 rounded-md bg-info-surface px-3 py-2 text-sm text-info"
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-info"
              />
              Waiting for the scan to finish — deep-scoring is paused until it's done.
            </p>
          ) : null}

          {previewData ? (
            <p className="mt-2 text-sm text-muted">
              ~{formatCount(previewData.counts.triageTitles)} posting(s) to score · est.{" "}
              <span className="font-semibold">${previewData.estimate.totalUsd.toFixed(2)}</span>
            </p>
          ) : null}
          {preview.isError ? (
            <p className="mt-2 text-sm text-danger">{String(preview.error)}</p>
          ) : null}

          {done ? (
            <p className="mt-2 text-sm text-success" aria-live="polite">
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
  const color = tone === "success" ? "text-success" : "text-warning";
  const shown = companies.slice(0, 8);
  return (
    <div>
      <p className={`text-sm font-medium ${color}`}>
        {sign}
        {label}
      </p>
      {companies.length === 0 ? (
        <p className="text-xs text-faint">—</p>
      ) : (
        <ul className="mt-1 text-xs text-muted">
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
