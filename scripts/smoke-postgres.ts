import postgres from "postgres";
/**
 * Opt-in, manual smoke test for the live PostgresScanStore. NOT part of `npm test`.
 *
 *   DATABASE_URL="postgres://...service-role-conn..." npm run smoke:postgres
 *
 * Runs a tiny real sourcing cycle against a Postgres database that has the migrations applied
 * (supabase/migrations/, via `supabase db push`): startScan → savePosting → savePostings (batch) → finishScan →
 * listLivePostingsNotSeen → markPostingExpired → expireStalePostings, printing each result. Use a
 * THROWAWAY project/database — it writes (and expires) probe postings. Requires the `DATABASE_URL` to
 * be a service-role connection (writes bypass RLS).
 */
import { PostgresScanStore } from "../src/backend/postgres-scan-store";
import type { JobPosting } from "../src/domain/types";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL to a Postgres service-role connection string first.");
    process.exitCode = 1;
    return;
  }

  const sql = postgres(url);
  const store = new PostgresScanStore(sql);
  try {
    const scanId = await store.startScan();
    console.log(`startScan → scan #${scanId}`);

    const probe: JobPosting = {
      id: `smoke:${scanId}`,
      company: "smoke-co",
      title: "Smoke Test Engineer",
      url: "https://example.test/smoke",
      source: "smoke",
      description: "A throwaway posting written by smoke:postgres.",
      location: "Remote",
      fetchedAt: new Date(),
    };
    await store.savePosting(probe, scanId);
    console.log(`savePosting → wrote ${probe.id}`);

    // Exercise the bulk path the worker actually uses (multi-row INSERT … ON CONFLICT).
    const batch: JobPosting[] = [1, 2].map((n) => ({
      id: `smoke:${scanId}:batch:${n}`,
      company: "smoke-co",
      title: `Batch Smoke Engineer ${n}`,
      url: `https://example.test/smoke/batch/${n}`,
      source: "smoke",
      description: "A throwaway batched posting written by smoke:postgres.",
      fetchedAt: new Date(),
    }));
    await store.savePostings(batch, scanId);
    console.log(`savePostings → wrote ${batch.length} posting(s) in one batch`);

    // Two companies so the batched (multi-row) company upsert is exercised, not just one row.
    const companies = [
      { careersUrl: "https://example.test/smoke", name: "smoke-co" },
      { careersUrl: "https://example.test/smoke-2", name: "smoke-co-2" },
    ];
    const diff = await store.recordDirectory(scanId, companies);
    console.log(
      `recordDirectory → +${diff.newCompanies.length} / -${diff.removedCompanies.length}`,
    );

    await store.finishScan(scanId, {
      postingsSeen: 1 + batch.length,
      companiesSeen: companies.length,
      ...diff,
    });
    console.log("finishScan → ok");

    // A *later* scan id means the probe was "not seen this scan" → eligible for the liveness sweep.
    const notSeen = await store.listLivePostingsNotSeen(scanId + 1);
    console.log(`listLivePostingsNotSeen(${scanId + 1}) → ${notSeen.length} posting(s)`);

    const expired = await store.markPostingExpired(probe.id);
    console.log(`markPostingExpired(${probe.id}) → ${expired}`);

    const stale = await store.expireStalePostings(scanId + 5);
    console.log(`expireStalePostings → ${stale} newly expired`);

    console.log("\nSmoke test passed.");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exitCode = 1;
});
