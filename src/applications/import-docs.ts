import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { Application } from "./model";
import { ApplicationError } from "./store";

/** The slice of the application + document stores the workspace importer needs. */
export type DocsImportTarget = {
  applications: { list(opts: { archived?: boolean }): Application[] };
  documents: {
    getByName(applicationId: number, name: string): unknown;
    attachFile(applicationId: number, sourcePath: string, name: string): unknown;
  };
};

export type WorkspaceImport = {
  folder: string;
  applicationId: number;
  company: string;
  imported: number;
  skipped: number;
};

export type DocsImportResult = { workspaces: WorkspaceImport[]; unmatched: string[] };

/**
 * Top-level folders in a job-hunt checkout that are tooling, not company workspaces. `archive/` is
 * not a workspace itself; its subfolders are.
 */
const NON_WORKSPACE_DIRS = new Set([
  "archive",
  "docs",
  "src",
  "tests",
  "scripts",
  "node_modules",
  "build",
  "dist",
  "__pycache__",
]);

/** Skipped anywhere in a workspace: hidden entries (.claude, .DS_Store) and build junk. */
function skipEntry(name: string): boolean {
  return name.startsWith(".") || name === "__pycache__" || name === "node_modules";
}

/** Company-name key for matching a folder to an application: lowercase alphanumerics only. */
export function companyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipEntry(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !skipEntry(e.name))
    .map((e) => join(dir, e.name))
    .sort();
}

/** Copy one workspace folder's files onto an application. */
export function importWorkspace(
  target: DocsImportTarget,
  folder: string,
  app: Pick<Application, "id" | "company">,
  opts: { overwrite?: boolean } = {},
): WorkspaceImport {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new ApplicationError(`not a folder: ${folder}`);
  }
  const result: WorkspaceImport = {
    folder,
    applicationId: app.id,
    company: app.company,
    imported: 0,
    skipped: 0,
  };
  for (const file of listFiles(folder)) {
    const name = relative(folder, file).split(sep).join("/");
    if (!opts.overwrite && target.documents.getByName(app.id, name)) {
      result.skipped++;
      continue;
    }
    target.documents.attachFile(app.id, file, name);
    result.imported++;
  }
  return result;
}

/**
 * Import a job-hunt checkout: every company folder (top level and under `archive/`) is matched to
 * an application by company name — active first, then archived, most recent first — and its files
 * are attached. Folders with no matching application are reported, not created. Existing documents
 * are kept unless `overwrite`, so re-running is safe.
 */
export function importJobHuntDocs(
  target: DocsImportTarget,
  root: string,
  opts: { overwrite?: boolean } = {},
): DocsImportResult {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new ApplicationError(`not a folder: ${root}`);
  }
  // First application per company key wins: active before archived, newest first within each.
  const byKey = new Map<string, Application>();
  for (const app of [
    ...target.applications.list({ archived: false }),
    ...target.applications.list({ archived: true }),
  ]) {
    const key = companyKey(app.company);
    if (key && !byKey.has(key)) byKey.set(key, app);
  }
  const folders = [
    ...subdirs(root).filter((d) => !NON_WORKSPACE_DIRS.has(basename(d))),
    ...subdirs(join(root, "archive")),
  ];
  const result: DocsImportResult = { workspaces: [], unmatched: [] };
  for (const folder of folders) {
    const key = companyKey(basename(folder));
    const app = byKey.get(key);
    if (!app) {
      result.unmatched.push(folder);
      continue;
    }
    result.workspaces.push(importWorkspace(target, folder, app, opts));
  }
  return result;
}
