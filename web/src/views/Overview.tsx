import { type ChangeEvent, useState } from "react";
import { type ScanEvent, runScan } from "../api";
import { Button, Card, Loading } from "../components/ui";
import { useProfile, useUploadResume } from "../hooks";

type ScanState = { running: boolean; lines: string[]; error?: string; done?: number };

export function Overview() {
  const profile = useProfile();
  const upload = useUploadResume();
  const [scan, setScan] = useState<ScanState>({ running: false, lines: [] });

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
  }

  async function startScan() {
    setScan({ running: true, lines: [] });
    const lines: string[] = [];
    const onEvent = (event: ScanEvent) => {
      if (event.phase === "log") lines.push(event.message);
      if (event.phase === "start") lines.push("Starting scan…");
      setScan((s) => ({ ...s, lines: [...lines] }));
      if (event.phase === "done") setScan({ running: false, lines: [...lines], done: event.count });
      if (event.phase === "error")
        setScan({ running: false, lines: [...lines], error: event.message });
    };
    try {
      await runScan(onEvent);
      setScan((s) => (s.running ? { ...s, running: false } : s));
    } catch (err) {
      setScan((s) => ({
        ...s,
        running: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
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
          <Button onClick={startScan} disabled={scan.running}>
            {scan.running ? "Scanning…" : "Scan now"}
          </Button>
        </div>
        {scan.done !== undefined ? (
          <p className="mt-2 text-sm text-emerald-700">
            Done — scored {scan.done} posting(s). See the Matches tab.
          </p>
        ) : null}
        {scan.error ? <p className="mt-2 text-sm text-red-700">{scan.error}</p> : null}
        {scan.lines.length > 0 ? (
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
            {scan.lines.join("\n")}
          </pre>
        ) : null}
      </Card>
    </section>
  );
}
