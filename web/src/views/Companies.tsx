import { Card, Empty, ErrorNote, Loading } from "../components/ui";
import { useCompanies } from "../hooks";

export function Companies() {
  const companies = useCompanies();

  return (
    <section className="space-y-4">
      <p className="text-sm text-slate-600">
        Companies you track are scanned alongside the public directory. Add or remove them with the
        CLI:{" "}
        <code className="rounded bg-slate-100 px-1">job-hunter track add &lt;careers-url&gt;</code>.
      </p>

      {companies.isPending ? (
        <Loading label="Loading companies…" />
      ) : companies.isError ? (
        <ErrorNote error={companies.error} />
      ) : companies.data.length === 0 ? (
        <Empty>No tracked companies yet.</Empty>
      ) : (
        <div className="space-y-2">
          {companies.data.map((c) => (
            <Card key={c.careersUrl} className="flex items-center justify-between">
              <span className="font-medium text-slate-800">{c.name ?? c.careersUrl}</span>
              <a
                href={c.careersUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-indigo-700 hover:underline"
              >
                {c.careersUrl}
              </a>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
