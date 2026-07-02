import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useEffect, useState } from "react";
import type { CompanyRef, ScorePreview } from "../api";
import { Button, Card, Loading } from "../components/ui";
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

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
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
        <label className="mt-3 inline-block">
          <span className="sr-only">Upload resume</span>
          <input
            type="file"
            accept=".txt,.md,.pdf,.docx"
            onChange={onFile}
            disabled={upload.isPending}
            className="text-sm"
          />
        </label>
        {upload.isPending ? <span className="ml-2 text-sm text-faint">Parsing…</span> : null}
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

        {running ? (
          <div className="mt-3" aria-live="polite">
            <p className="text-sm text-muted">
              {status?.message ?? "Working…"}{" "}
              <span className="text-faint">
                · <ElapsedTimer startedAt={startedAt} />s
              </span>
            </p>
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
            {latestScan.data.companiesSeen ?? 0} companies · {latestScan.data.postingsSeen ?? 0}{" "}
            postings scored
          </p>
          {latestScan.data.newCompanies.length === 0 &&
          latestScan.data.removedCompanies.length === 0 ? (
            <p className="mt-1 text-sm text-faint">No directory changes since the last scan.</p>
          ) : (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <CompanyDelta
                tone="success"
                label={`${latestScan.data.newCompanies.length} new`}
                companies={latestScan.data.newCompanies}
              />
              <CompanyDelta
                tone="warning"
                label={`${latestScan.data.removedCompanies.length} no longer listed`}
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

  const running = scoreStatus.data?.state === "running";
  const done = scoreStatus.data?.state === "done" ? scoreStatus.data : null;
  const errored = scoreStatus.data?.state === "error" ? scoreStatus.data : null;
  const previewData: ScorePreview | undefined = preview.data;

  const options = { remoteOnly, limit };
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
        {running ? <span className="text-sm text-faint">{scoreStatus.data?.message}</span> : null}
      </div>
      <p className="mt-1 text-xs text-faint">
        Re-rank matches with the LLM for sharper relevance. Costs money — preview the estimate
        first.
      </p>

      {running && scoreStatus.data ? (
        <div className="mt-3" aria-live="polite">
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
            <p className="mt-2 text-xs text-faint">Waiting for the scan to finish…</p>
          ) : null}

          {previewData ? (
            <p className="mt-2 text-sm text-muted">
              ~{previewData.counts.triageTitles} posting(s) to score · est.{" "}
              <span className="font-semibold">${previewData.estimate.totalUsd.toFixed(2)}</span>
            </p>
          ) : null}
          {preview.isError ? (
            <p className="mt-2 text-sm text-danger">{String(preview.error)}</p>
          ) : null}

          {done ? (
            <p className="mt-2 text-sm text-success" aria-live="polite">
              Deep-scored {done.counts?.deepScored ?? 0} posting(s) — see the Matches tab.
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
            <li className="text-faint">…and {companies.length - shown.length} more</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
