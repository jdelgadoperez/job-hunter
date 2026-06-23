import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useEffect, useState } from "react";
import type { CompanyRef } from "../api";
import { Button, Card, Loading } from "../components/ui";
import { useLatestScan, useProfile, useScanStatus, useStartScan, useUploadResume } from "../hooks";

export function Overview() {
  const profile = useProfile();
  const upload = useUploadResume();
  const scan = useScanStatus();
  const startScan = useStartScan();
  const latestScan = useLatestScan();
  const qc = useQueryClient();

  const status = scan.data;
  const running = status?.state === "running";

  // A scan that finishes in the background (e.g. the scheduled refresh) should refresh matches too.
  // Keying on finishedAt re-runs this for each completed scan, not just the first.
  const finishedAt = status?.state === "done" ? status.finishedAt : null;
  useEffect(() => {
    if (finishedAt) {
      qc.invalidateQueries({ queryKey: ["matches"] });
      qc.invalidateQueries({ queryKey: ["latest-scan"] });
    }
  }, [finishedAt, qc]);

  // Tick an elapsed counter while a scan runs, so the long opening step never looks frozen.
  const startedAt = running ? status?.startedAt : null;
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

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
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
        {upload.isError ? <p className="mt-2 text-sm text-danger">{String(upload.error)}</p> : null}
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-fg">2 · Scan for jobs</h2>
          <Button onClick={() => startScan.mutate()} disabled={running || startScan.isPending}>
            {running ? "Scanning…" : "Scan now"}
          </Button>
        </div>

        {running ? (
          <div className="mt-3" aria-live="polite">
            <p className="text-sm text-muted">
              {status?.message ?? "Working…"} <span className="text-faint">· {elapsed}s</span>
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
              <ul className="mt-2 max-h-32 overflow-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">
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
                tone="emerald"
                label={`${latestScan.data.newCompanies.length} new`}
                companies={latestScan.data.newCompanies}
              />
              <CompanyDelta
                tone="amber"
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

function CompanyDelta({
  tone,
  label,
  companies,
}: {
  tone: "emerald" | "amber";
  label: string;
  companies: CompanyRef[];
}) {
  const sign = tone === "emerald" ? "+" : "−";
  const color = tone === "emerald" ? "text-success" : "text-warning";
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
