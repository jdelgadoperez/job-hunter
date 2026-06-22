import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useEffect } from "react";
import { Button, Card, Loading } from "../components/ui";
import { useProfile, useScanStatus, useStartScan, useUploadResume } from "../hooks";

export function Overview() {
  const profile = useProfile();
  const upload = useUploadResume();
  const scan = useScanStatus();
  const startScan = useStartScan();
  const qc = useQueryClient();

  const status = scan.data;
  const running = status?.state === "running";

  // A scan that finishes in the background (e.g. the scheduled refresh) should refresh matches too.
  // Keying on finishedAt re-runs this for each completed scan, not just the first.
  const finishedAt = status?.state === "done" ? status.finishedAt : null;
  useEffect(() => {
    if (finishedAt) qc.invalidateQueries({ queryKey: ["matches"] });
  }, [finishedAt, qc]);

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
  }

  if (profile.isPending) return <Loading label="Loading…" />;

  const skills = profile.data?.skills ?? [];

  return (
    <section className="space-y-4">
      <Card>
        <h2 className="font-semibold text-slate-800">1 · Your profile</h2>
        {skills.length > 0 ? (
          <p className="mt-1 text-sm text-slate-600">
            {skills.length} skill(s) extracted: {skills.slice(0, 12).join(", ")}
            {skills.length > 12 ? "…" : ""}
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            No profile yet — upload a resume to build one.
          </p>
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
        {upload.isPending ? <span className="ml-2 text-sm text-slate-500">Parsing…</span> : null}
        {upload.isError ? (
          <p className="mt-2 text-sm text-red-700">{String(upload.error)}</p>
        ) : null}
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">2 · Scan for jobs</h2>
          <Button onClick={() => startScan.mutate()} disabled={running || startScan.isPending}>
            {running ? "Scanning…" : "Scan now"}
          </Button>
        </div>

        {running ? (
          <div className="mt-3">
            <p className="text-sm text-slate-600">{status?.message ?? "Working…"}</p>
            {status?.total ? (
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-100">
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{ width: `${Math.round((100 * (status.current ?? 0)) / status.total)}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {status?.state === "done" ? (
          <p className="mt-2 text-sm text-emerald-700">
            {status.message} — see the Matches tab.
            {status.warnings.length > 0 ? ` (${status.warnings.length} warning(s))` : ""}
          </p>
        ) : null}

        {status?.state === "error" ? (
          <p className="mt-2 text-sm text-red-700">{status.error}</p>
        ) : null}

        <p className="mt-2 text-xs text-slate-400">
          Scans run in the background — you can switch tabs or close this page; it keeps going.
        </p>
      </Card>
    </section>
  );
}
