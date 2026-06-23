import { type FormEvent, useState } from "react";
import { Button, Card, Empty, ErrorNote, Loading } from "../components/ui";
import { useAddCompany, useCompanies, useRemoveCompany } from "../hooks";

export function Companies() {
  const companies = useCompanies();
  const addCompany = useAddCompany();
  const removeCompany = useRemoveCompany();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");

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
        <h2 className="font-semibold text-slate-800">Track a company</h2>
        <p className="mt-1 text-xs text-slate-500">
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
          {companies.data.map((c) => (
            <Card key={c.careersUrl} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{c.name ?? c.careersUrl}</p>
                <a
                  href={c.careersUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-indigo-700 hover:underline"
                >
                  {c.careersUrl}
                </a>
              </div>
              <button
                type="button"
                onClick={() => removeCompany.mutate(c.careersUrl)}
                className="shrink-0 rounded text-sm text-slate-500 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Remove
              </button>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
