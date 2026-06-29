import { type FormEvent, useMemo, useState } from "react";
import { Button, Card, Empty, ErrorNote, Loading } from "../components/ui";
import { useAddCompany, useCompanies, useManualReviewCompanies, useRemoveCompany } from "../hooks";

type CompanyEntry = { careersUrl: string; name?: string };

/** The label a company is shown under — and what we sort by. */
const label = (c: CompanyEntry) => c.name ?? c.careersUrl;

/** Sort companies by display label, case-insensitively (locale-aware). */
const byLabel = (a: CompanyEntry, b: CompanyEntry) =>
  label(a).localeCompare(label(b), undefined, { sensitivity: "base" });

export function Companies() {
  const companies = useCompanies();
  const manualReview = useManualReviewCompanies();
  const addCompany = useAddCompany();
  const removeCompany = useRemoveCompany();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");

  const sortedCompanies = useMemo(
    () => (companies.data ? [...companies.data].sort(byLabel) : []),
    [companies.data],
  );
  const sortedManualReview = useMemo(
    () => (manualReview.data ? [...manualReview.data].sort(byLabel) : []),
    [manualReview.data],
  );

  function add(e: FormEvent) {
    e.preventDefault();
    const careersUrl = url.trim();
    if (!careersUrl) return;
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

  return (
    <section className="space-y-4">
      <Card>
        <h2 className="font-semibold text-fg">Track a company</h2>
        <p className="mt-1 text-xs text-faint">
          Add a company by its careers-page URL — it's scanned alongside the public directory.
        </p>
        <form onSubmit={add} className="mt-3 flex flex-wrap gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://boards.greenhouse.io/acme"
            className="input flex-1"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            className="input w-44"
          />
          <Button type="submit" disabled={addCompany.isPending || !url.trim()}>
            Add
          </Button>
        </form>
        {addCompany.isError ? <ErrorNote error={addCompany.error} /> : null}
      </Card>

      {companies.isPending ? (
        <Loading label="Loading companies…" />
      ) : companies.isError ? (
        <ErrorNote error={companies.error} />
      ) : companies.data.length === 0 ? (
        <Empty>No tracked companies yet.</Empty>
      ) : (
        <div className="space-y-2">
          {sortedCompanies.map((c) => (
            <Card key={c.careersUrl} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-fg">{c.name ?? c.careersUrl}</p>
                <a
                  href={c.careersUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-link hover:underline"
                >
                  {c.careersUrl}
                </a>
              </div>
              <button
                type="button"
                onClick={() => removeCompany.mutate(c.careersUrl)}
                className="shrink-0 rounded text-sm text-faint hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Remove
              </button>
            </Card>
          ))}
        </div>
      )}

      {manualReview.data && manualReview.data.length > 0 ? (
        <Card>
          <h2 className="font-semibold text-fg">Review manually ({manualReview.data.length})</h2>
          <p className="mt-1 text-xs text-faint">
            These directory companies post on sites we don't auto-scan (LinkedIn/Indeed) — open them
            to check their roles yourself.
          </p>
          <ul className="mt-3 space-y-1">
            {sortedManualReview.map((c) => (
              <li key={c.careersUrl} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-fg">{c.name ?? c.careersUrl}</span>
                <a
                  href={c.careersUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-link hover:underline"
                >
                  open ↗
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
