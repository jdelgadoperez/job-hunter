import { type FormEvent, useState } from "react";
import {
  APPLICATION_STATUSES,
  type Application,
  type ApplicationStatus,
  CLOSED_STATUSES,
} from "../api";
import { Button, Card, ConfirmButton, Empty, ErrorNote, Loading } from "../components/ui";
import { statusLabel } from "../format";
import {
  useAddApplicationNote,
  useApplicationStats,
  useApplications,
  useArchiveApplication,
  useCreateApplication,
  useRemoveApplication,
  useUpdateApplication,
} from "../hooks";
import { Documents } from "./Documents";

const STATUS_TONE: Record<ApplicationStatus, string> = {
  applied: "text-muted",
  screened: "text-primary",
  interviewed: "text-primary",
  offered: "text-success",
  rejected: "text-faint",
  ghosted: "text-faint",
  withdrawn: "text-faint",
};

function AddApplicationForm({ onDone }: { onDone: () => void }) {
  const create = useCreateApplication();
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [url, setUrl] = useState("");
  const [dateApplied, setDateApplied] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!company.trim() || !role.trim()) return;
    create.mutate(
      {
        company: company.trim(),
        role: role.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(dateApplied ? { dateApplied } : {}),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <Card>
      <h2 className="font-semibold text-fg">Add an application</h2>
      <p className="mt-1 text-xs text-faint">
        For roles you applied to outside job-hunter. Marking a match applied adds it here
        automatically.
      </p>
      <form onSubmit={submit} className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          aria-label="Company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company"
          className="input"
        />
        <input
          aria-label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Role"
          className="input"
        />
        <input
          aria-label="Posting URL"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Posting URL (optional)"
          className="input"
        />
        <input
          aria-label="Date applied"
          type="date"
          value={dateApplied}
          onChange={(e) => setDateApplied(e.target.value)}
          className="input"
        />
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={create.isPending || !company.trim() || !role.trim()}>
            Add
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
      {create.error ? <ErrorNote error={create.error} /> : null}
    </Card>
  );
}

function ApplicationDetail({ app }: { app: Application }) {
  const addNote = useAddApplicationNote();
  const archive = useArchiveApplication();
  const remove = useRemoveApplication();
  const [note, setNote] = useState("");
  const canArchive = CLOSED_STATUSES.includes(app.status);

  function submitNote(e: FormEvent) {
    e.preventDefault();
    const content = note.trim();
    if (!content) return;
    addNote.mutate({ id: app.id, content }, { onSuccess: () => setNote("") });
  }

  const facts: [string, string | null][] = [
    ["Salary", app.salaryRange],
    ["Recruiter", app.recruiter],
    ["Source", app.source],
  ];

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
      {facts.some(([, v]) => v) ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {facts.map(([k, v]) =>
            v ? (
              <div key={k} className="contents">
                <dt className="text-faint">{k}</dt>
                <dd className="text-fg">{v}</dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : null}

      <ol aria-label="Notes" className="space-y-1">
        {app.notes.map((n) => (
          <li key={n.id} className="flex gap-3">
            <span className="shrink-0 font-mono text-xs text-faint">{n.date}</span>
            <span className="text-fg">{n.content}</span>
          </li>
        ))}
      </ol>

      <form onSubmit={submitNote} className="flex gap-2">
        <input
          aria-label={`Note for ${app.company}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note…"
          className="input flex-1"
        />
        <Button type="submit" disabled={addNote.isPending || !note.trim()}>
          Add note
        </Button>
      </form>

      <Documents applicationId={app.id} />

      <div className="flex flex-wrap items-center gap-2">
        {app.archived ? (
          <Button variant="ghost" onClick={() => archive.mutate({ id: app.id, archived: false })}>
            Unarchive
          </Button>
        ) : (
          <Button
            variant="ghost"
            disabled={!canArchive || archive.isPending}
            title={canArchive ? undefined : "Only rejected, ghosted, or withdrawn can be archived"}
            onClick={() => archive.mutate({ id: app.id, archived: true })}
          >
            Archive
          </Button>
        )}
        <ConfirmButton
          label="Delete"
          confirmLabel="Confirm delete"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(app.id)}
        />
      </div>
      {addNote.error || archive.error || remove.error ? (
        <ErrorNote error={addNote.error ?? archive.error ?? remove.error} />
      ) : null}
    </div>
  );
}

function ApplicationRow({ app }: { app: Application }) {
  const update = useUpdateApplication();
  const [open, setOpen] = useState(false);

  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="text-left font-semibold text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {app.company} — {app.role}
            </button>
            <p className="text-xs text-faint">
              Applied {app.dateApplied}
              {app.url ? (
                <>
                  {" · "}
                  <a href={app.url} target="_blank" rel="noreferrer" className="hover:underline">
                    posting
                  </a>
                </>
              ) : null}
              {app.archived ? " · archived" : ""}
            </p>
          </div>
          <select
            aria-label={`Status for ${app.company}`}
            value={app.status}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate({ id: app.id, status: e.target.value as ApplicationStatus })
            }
            className={`input w-36 text-sm font-medium ${STATUS_TONE[app.status]}`}
          >
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </div>
        {update.error ? <ErrorNote error={update.error} /> : null}
        {open ? <ApplicationDetail app={app} /> : null}
      </Card>
    </li>
  );
}

export function Applications() {
  const [archived, setArchived] = useState(false);
  const [status, setStatus] = useState<ApplicationStatus | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const stats = useApplicationStats();
  const apps = useApplications({
    archived,
    ...(status ? { status } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  const counts = archived ? stats.data?.archived : stats.data?.active;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search applications"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search company, role, notes…"
          className="input flex-1"
        />
        <Button variant="toggle" pressed={archived} onClick={() => setArchived((a) => !a)}>
          Archived
        </Button>
        {!adding ? <Button onClick={() => setAdding(true)}>Add application</Button> : null}
      </div>

      {adding ? <AddApplicationForm onDone={() => setAdding(false)} /> : null}

      {counts && Object.keys(counts).length > 0 && !search.trim() ? (
        <fieldset aria-label="Filter by status" className="flex flex-wrap gap-1">
          <Button
            variant="toggle"
            pressed={status === undefined}
            onClick={() => setStatus(undefined)}
          >
            All
          </Button>
          {APPLICATION_STATUSES.filter((s) => counts[s]).map((s) => (
            <Button
              key={s}
              variant="toggle"
              pressed={status === s}
              onClick={() => setStatus(status === s ? undefined : s)}
            >
              {statusLabel(s)} · {counts[s]}
            </Button>
          ))}
        </fieldset>
      ) : null}

      {apps.isLoading ? (
        <Loading label="Loading applications…" />
      ) : apps.error ? (
        <ErrorNote error={apps.error} />
      ) : apps.data && apps.data.length > 0 ? (
        <ul className="space-y-2">
          {apps.data.map((app) => (
            <ApplicationRow key={app.id} app={app} />
          ))}
        </ul>
      ) : (
        <Empty>
          {search.trim() || status || archived
            ? "No applications match."
            : "No applications yet. Mark a match applied, or add one above."}
        </Empty>
      )}
    </section>
  );
}
