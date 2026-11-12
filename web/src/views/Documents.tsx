import { type FormEvent, lazy, Suspense, useState } from "react";
import { type DocumentMeta, documentRawUrl } from "../api";
import { Button, ErrorNote, Loading } from "../components/ui";
import { useDocuments, useNote, useRemoveDocument, useSaveNote } from "../hooks";

// The markdown renderer (react-markdown + GFM) is ~170 KB, so it loads only when a note is opened.
const Markdown = lazy(() => import("./Markdown"));

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function NoteView({
  applicationId,
  doc,
  onClose,
}: {
  applicationId: number;
  doc: DocumentMeta;
  onClose: () => void;
}) {
  const note = useNote(applicationId, doc.id);
  const save = useSaveNote(applicationId);
  const remove = useRemoveDocument(applicationId);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (note.isLoading) return <Loading label={`Loading ${doc.name}…`} />;
  if (note.error || !note.data) return <ErrorNote error={note.error} />;
  const content = note.data.content;

  return (
    <section aria-label={doc.name} className="rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="font-mono text-xs text-muted">{doc.name}</h3>
        <div className="flex flex-wrap gap-1">
          {draft === null ? (
            <>
              <Button variant="ghost" onClick={() => setDraft(content)}>
                Edit
              </Button>
              {confirmingDelete ? (
                <>
                  <Button
                    variant="ghost"
                    className="text-danger"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(doc.id, { onSuccess: onClose })}
                  >
                    Confirm delete
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </Button>
              )}
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={save.isPending || draft === content}
                onClick={() =>
                  save.mutate(
                    { documentId: doc.id, content: draft },
                    { onSuccess: () => setDraft(null) },
                  )
                }
              >
                Save
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="p-3">
        {draft === null ? (
          <Suspense fallback={<Loading label="Rendering…" />}>
            <Markdown>{content}</Markdown>
          </Suspense>
        ) : (
          <textarea
            aria-label={`Edit ${doc.name}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={20}
            className="input w-full font-mono text-xs"
          />
        )}
        {save.error || remove.error ? <ErrorNote error={save.error ?? remove.error} /> : null}
      </div>
    </section>
  );
}

function NewNoteForm({
  applicationId,
  onCreated,
  onCancel,
}: {
  applicationId: number;
  onCreated: (doc: DocumentMeta) => void;
  onCancel: () => void;
}) {
  const save = useSaveNote(applicationId);
  const [name, setName] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const fileName = /\.(md|markdown|txt)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
    const title = fileName.replace(/\.(md|markdown|txt)$/i, "");
    save.mutate({ name: fileName, content: `# ${title}\n` }, { onSuccess: onCreated });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2">
      <input
        aria-label="New note name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. onsite-prep.md"
        className="input flex-1"
      />
      <Button type="submit" disabled={save.isPending || !name.trim()}>
        Create
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </form>
  );
}

/** An application's documents: notes open in a markdown viewer/editor; files open in a new tab. */
export function Documents({ applicationId }: { applicationId: number }) {
  const docs = useDocuments(applicationId);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const open = docs.data?.find((d) => d.id === openId && d.kind === "note");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg">Documents</h3>
        {!creating ? (
          <Button variant="ghost" onClick={() => setCreating(true)}>
            New note
          </Button>
        ) : null}
      </div>
      {creating ? (
        <NewNoteForm
          applicationId={applicationId}
          onCancel={() => setCreating(false)}
          onCreated={(doc) => {
            setCreating(false);
            setOpenId(doc.id);
          }}
        />
      ) : null}
      {docs.isLoading ? (
        <Loading label="Loading documents…" />
      ) : docs.error ? (
        <ErrorNote error={docs.error} />
      ) : docs.data && docs.data.length > 0 ? (
        <ul aria-label="Documents" className="space-y-0.5">
          {docs.data.map((doc) => (
            <li key={doc.id} className="flex items-baseline justify-between gap-3">
              {doc.kind === "note" ? (
                <button
                  type="button"
                  aria-pressed={openId === doc.id}
                  onClick={() => setOpenId(openId === doc.id ? null : doc.id)}
                  className="truncate text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {doc.name}
                </button>
              ) : (
                <a
                  href={documentRawUrl(applicationId, doc.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-muted hover:underline"
                >
                  {doc.name}
                </a>
              )}
              <span className="shrink-0 text-xs text-faint">
                {doc.kind === "note" ? "note" : "file"} · {formatBytes(doc.size)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">
          No documents. Create a note, or import prep folders with{" "}
          <code className="font-mono">job-hunter app import-docs</code>.
        </p>
      )}
      {open ? (
        <NoteView
          key={open.id}
          applicationId={applicationId}
          doc={open}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
