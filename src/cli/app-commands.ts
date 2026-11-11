import { importJobHuntDocs, importWorkspace } from "@app/applications/import-docs";
import { APPLICATION_STATUSES, type Application } from "@app/applications/model";
import { ApplicationError } from "@app/applications/store";
import type { Repository } from "@app/storage/repository";
import type { Logger } from "./commands";
import type { AppCommand } from "./parse-app";
import { style } from "./style";

export type AppCommandDeps = {
  repo: Repository;
  /** stdout: results (and JSON). */
  log: Logger;
  /** stderr: hints and errors, kept out of `--json` output. */
  diag: Logger;
  /** Import a `jt` database into this one (injected so tests needn't touch the real home dir). */
  importJt: (path: string | undefined) => {
    imported: number;
    skipped: number;
    notes: number;
    path: string;
  };
};

function line(app: Application): string {
  const archived = app.archived ? style.dim(" (archived)") : "";
  return `${style.dim(String(app.id).padStart(4))}  ${app.dateApplied}  ${app.status.padEnd(11)} ${style.bold(app.company)} — ${app.role}${archived}`;
}

function detail(app: Application): string[] {
  const rows: [string, string | null][] = [
    ["Status", app.status],
    ["Applied", app.dateApplied],
    ["URL", app.url],
    ["Source", app.source],
    ["Salary", app.salaryRange],
    ["Recruiter", app.recruiter],
    ["Posting", app.postingId],
  ];
  const out = [
    `${style.bold(`${app.company} — ${app.role}`)} ${style.dim(`#${app.id}`)}${app.archived ? style.dim(" (archived)") : ""}`,
  ];
  for (const [label, value] of rows) if (value) out.push(`  ${label.padEnd(10)} ${value}`);
  if (app.notes.length > 0) {
    out.push("", style.bold("Notes"));
    for (const note of app.notes) out.push(`  ${style.dim(note.date)}  ${note.content}`);
  }
  return out;
}

/** Resolve among active applications first, then archived ones (documents outlive archiving). */
function resolveAny(store: Repository["applications"], selector: string): Application {
  try {
    return store.resolve(selector);
  } catch (activeError) {
    // Only a miss falls through; an ambiguous active match must stay an error, not pick an archived one.
    if (
      !(activeError instanceof ApplicationError) ||
      !/^no application/.test(activeError.message)
    ) {
      throw activeError;
    }
    try {
      return store.resolve(selector, { archived: true });
    } catch {
      throw activeError;
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function printList(apps: Application[], log: Logger): void {
  for (const app of apps) log(line(app));
}

/**
 * Run an `app` subcommand. Returns the process exit code: 0 on success, 1 on a user error (unknown
 * company, ambiguous selector, bad transition), which is reported on stderr rather than thrown.
 */
export function runAppCommand(cmd: AppCommand, deps: AppCommandDeps): number {
  const { repo, log, diag } = deps;
  const store = repo.applications;
  try {
    switch (cmd.sub) {
      case "add": {
        const app = repo.transaction(() => {
          const created = store.add({
            company: cmd.company,
            role: cmd.role,
            url: cmd.url ?? null,
            source: cmd.source ?? null,
            salaryRange: cmd.salaryRange ?? null,
            recruiter: cmd.recruiter ?? null,
            postingId: cmd.postingId ?? null,
            ...(cmd.date ? { dateApplied: cmd.date } : {}),
          });
          // Keep the match list in step: a linked posting drops out of the default matches view.
          if (cmd.postingId) repo.setUserAction(cmd.postingId, "applied");
          return created;
        });
        if (cmd.json) log(JSON.stringify(app, null, 2));
        else log(style.success(`Added #${app.id}: ${app.company} — ${app.role}`));
        return 0;
      }
      case "list": {
        const apps = store.list({
          archived: cmd.archived,
          ...(cmd.status ? { status: cmd.status } : {}),
        });
        if (cmd.json) {
          log(JSON.stringify(apps, null, 2));
        } else if (apps.length === 0) {
          diag(
            style.dim(
              cmd.archived || cmd.status
                ? "No matching applications."
                : "No applications yet. Add one with `job-hunter app add <company> <role>`.",
            ),
          );
        } else {
          printList(apps, log);
        }
        return 0;
      }
      case "view": {
        const app = store.resolve(cmd.selector, { archived: cmd.archived });
        if (cmd.json) log(JSON.stringify(app, null, 2));
        else for (const row of detail(app)) log(row);
        return 0;
      }
      case "status": {
        const app = store.resolve(cmd.selector);
        const before = app.status;
        const updated = store.setStatus(app.id, cmd.status, cmd.date);
        log(
          before === updated.status
            ? style.dim(`${app.company} is already ${before}.`)
            : style.success(`${app.company} — ${app.role}: ${before} → ${updated.status}`),
        );
        return 0;
      }
      case "note": {
        const app = store.resolve(cmd.selector);
        const note = store.addNote(app.id, cmd.text, cmd.date);
        log(style.success(`Note added to ${app.company} — ${app.role}`));
        log(`  ${style.dim(note.date)}  ${note.content}`);
        return 0;
      }
      case "edit": {
        const app = store.resolve(cmd.selector);
        const updated = store.update(app.id, cmd.patch);
        log(style.success(`Updated #${updated.id}: ${updated.company} — ${updated.role}`));
        return 0;
      }
      case "search": {
        const apps = store.search(cmd.term);
        if (cmd.json) log(JSON.stringify(apps, null, 2));
        else if (apps.length === 0) diag(style.dim(`No applications match "${cmd.term}".`));
        else printList(apps, log);
        return 0;
      }
      case "stats": {
        const counts = store.countsByStatus({ archived: cmd.archived });
        if (cmd.json) {
          log(JSON.stringify(counts, null, 2));
          return 0;
        }
        const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
        log(style.bold(cmd.archived ? "Archived applications" : "Active applications"));
        for (const status of APPLICATION_STATUSES) {
          const n = counts[status];
          if (n) log(`  ${status.padEnd(12)} ${n}`);
        }
        log(`  ${"total".padEnd(12)} ${total}`);
        return 0;
      }
      case "archive": {
        if (!cmd.selector) {
          const archivable = store.listArchivable();
          if (archivable.length === 0) {
            diag(style.dim("Nothing to archive (only rejected, ghosted, or withdrawn can be)."));
          } else {
            diag(style.dim("Archivable — run `job-hunter app archive <company|id>`:"));
            printList(archivable, log);
          }
          return 0;
        }
        const app = store.archive(store.resolve(cmd.selector).id);
        log(style.success(`Archived ${app.company} — ${app.role}`));
        return 0;
      }
      case "unarchive": {
        const app = store.unarchive(store.resolve(cmd.selector, { archived: true }).id);
        log(style.success(`Restored ${app.company} — ${app.role}`));
        return 0;
      }
      case "remove": {
        const app = store.resolve(cmd.selector);
        repo.transaction(() => {
          store.remove(app.id);
          // Un-mark the linked match too, so it doesn't sit in "applied" with no application.
          if (app.postingId) repo.clearUserAction(app.postingId);
        });
        log(style.success(`Removed ${app.company} — ${app.role}`));
        return 0;
      }
      case "docs": {
        const app = resolveAny(store, cmd.selector);
        const docs = repo.documents.list(app.id);
        if (cmd.json) log(JSON.stringify(docs, null, 2));
        else if (docs.length === 0) diag(style.dim(`No documents for ${app.company}.`));
        else {
          for (const doc of docs) {
            const kind = doc.kind === "note" ? "note" : "file";
            log(`  ${style.dim(kind.padEnd(5))} ${doc.name} ${style.dim(formatBytes(doc.size))}`);
          }
        }
        return 0;
      }
      case "doc": {
        const app = resolveAny(store, cmd.selector);
        const meta = repo.documents.getByName(app.id, cmd.name);
        if (!meta) throw new ApplicationError(`${app.company} has no document "${cmd.name}"`);
        const doc = repo.documents.read(app.id, meta.id);
        if (!doc) throw new ApplicationError(`"${cmd.name}" is missing from disk`);
        if (meta.kind === "note") log(doc.body.toString("utf8"));
        else {
          log(
            style.dim(
              `${meta.name} (${meta.mime}, ${formatBytes(meta.size)}) isn't a text note; open it from the dashboard.`,
            ),
          );
        }
        return 0;
      }
      case "import-docs": {
        const opts = { overwrite: cmd.overwrite };
        const result = cmd.into
          ? {
              workspaces: [importWorkspace(repo, cmd.path, resolveAny(store, cmd.into), opts)],
              unmatched: [],
            }
          : importJobHuntDocs(repo, cmd.path, opts);
        for (const w of result.workspaces) {
          const skipped = w.skipped ? style.dim(` (${w.skipped} already there)`) : "";
          log(`${style.success("✓")} ${w.company}: ${w.imported} document(s)${skipped}`);
        }
        for (const folder of result.unmatched) {
          diag(
            style.warn(
              `  ! No application matches ${folder}. Add one (app add) or run: job-hunter app import-docs "${folder}" --into <company|id>`,
            ),
          );
        }
        if (result.workspaces.length === 0 && result.unmatched.length === 0) {
          diag(style.dim("No company folders found."));
        }
        return 0;
      }
      case "import": {
        const result = deps.importJt(cmd.path);
        log(
          style.success(
            `Imported ${result.imported} application(s) and ${result.notes} note(s) from ${result.path}`,
          ),
        );
        if (result.skipped > 0) {
          log(style.dim(`Skipped ${result.skipped} already present (same company, role, date).`));
        }
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof ApplicationError) {
      diag(style.error(`Error: ${error.message}`));
      return 1;
    }
    throw error;
  }
}
