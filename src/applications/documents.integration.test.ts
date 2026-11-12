import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanDocumentName, isNoteName, mimeFor } from "./documents";
import { companyKey, importJobHuntDocs, importWorkspace } from "./import-docs";

let dir: string;
let docsDir: string;
let repo: Repository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jh-docs-"));
  docsDir = join(dir, "docs");
  repo = new Repository(":memory:", { docsDir });
});
afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string | Buffer = "x"): string {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe("document helpers", () => {
  it("normalizes names and rejects escapes, absolute paths, and hidden segments", () => {
    expect(cleanDocumentName(" sys-design\\\\data/./report.md ")).toBe("sys-design/data/report.md");
    for (const bad of ["", "  ", ".", "../x.md", "a/../../x", "/etc/passwd", "C:/x", ".claude/x"]) {
      expect(() => cleanDocumentName(bad), bad).toThrow();
    }
  });

  it("classifies notes and maps mime types", () => {
    expect(isNoteName("prep.MD")).toBe(true);
    expect(isNoteName("notes.txt")).toBe(true);
    expect(isNoteName("arch.svg")).toBe(false);
    expect(mimeFor("a.pdf")).toBe("application/pdf");
    expect(mimeFor("a.pptx")).toContain("presentationml");
    expect(mimeFor("a.weird")).toBe("application/octet-stream");
  });

  it("keys company names loosely", () => {
    expect(companyKey("Acme Labs, Inc.")).toBe("acmelabsinc");
    expect(companyKey("acme-labs-inc")).toBe("acmelabsinc");
  });
});

describe("DocumentStore", () => {
  it("saves, lists, reads, updates, and removes notes", () => {
    const app = repo.applications.add({ company: "Acme", role: "Eng" });
    const note = repo.documents.saveNote(app.id, "prep.md", "# Prep");
    expect(note).toMatchObject({ name: "prep.md", kind: "note", content: "# Prep", size: 6 });
    expect(repo.documents.list(app.id).map((d) => d.name)).toEqual(["prep.md"]);

    const updated = repo.documents.updateNote(app.id, note.id, "# Prep v2");
    expect(updated.content).toBe("# Prep v2");
    expect(updated.id).toBe(note.id);
    expect(repo.documents.read(app.id, note.id)?.body.toString()).toBe("# Prep v2");

    expect(() => repo.documents.saveNote(app.id, "diagram.png", "x")).toThrow("notes must be");
    expect(() => repo.documents.updateNote(app.id, 999, "x")).toThrow("no note with id 999");
    expect(repo.documents.remove(app.id, note.id)).toBe(true);
    expect(repo.documents.remove(app.id, note.id)).toBe(false);
    expect(repo.documents.get(app.id, note.id)).toBeUndefined();
  });

  it("reads text files into notes and copies other files under docsDir", () => {
    const app = repo.applications.add({ company: "Acme", role: "Eng" });
    const md = repo.documents.attachFile(app.id, write("ws/prep.md", "# Hi"), "prep.md");
    expect(md.kind).toBe("note");

    const pdfBytes = Buffer.from("%PDF-1.4 test");
    const pdf = repo.documents.attachFile(app.id, write("ws/r.pdf", pdfBytes), "resume/r.pdf");
    expect(pdf).toMatchObject({ kind: "file", mime: "application/pdf", size: pdfBytes.length });
    const stored = join(docsDir, String(app.id), "resume", "r.pdf");
    expect(readFileSync(stored)).toEqual(pdfBytes);
    expect(repo.documents.read(app.id, pdf.id)?.body).toEqual(pdfBytes);
    expect(repo.documents.getNote(app.id, pdf.id)).toBeUndefined();
    expect(() => repo.documents.saveNote(app.id, "resume/r.pdf", "x")).toThrow("notes must be");

    // Re-attaching replaces in place.
    repo.documents.attachFile(app.id, write("ws/r2.pdf", "%PDF-2"), "resume/r.pdf");
    expect(repo.documents.list(app.id)).toHaveLength(2);
    expect(readFileSync(stored, "utf8")).toBe("%PDF-2");

    // A file missing on disk reads as gone; removing deletes the stored copy.
    expect(repo.documents.remove(app.id, pdf.id)).toBe(true);
    expect(existsSync(stored)).toBe(false);
  });

  it("refuses to save a note over a file of the same name", () => {
    const app = repo.applications.add({ company: "Acme", role: "Eng" });
    repo.documents.attachFile(app.id, write("ws/a.pdf"), "a.pdf");
    // Same name as a note is impossible by extension; simulate a tampered kind instead.
    repo.connection.prepare("UPDATE application_documents SET name = 'a.md'").run();
    expect(() => repo.documents.saveNote(app.id, "a.md", "x")).toThrow("is a file, not a note");
  });

  it("never reads or deletes a stored path outside docsDir", () => {
    const app = repo.applications.add({ company: "Acme", role: "Eng" });
    const doc = repo.documents.attachFile(app.id, write("ws/a.pdf"), "a.pdf");
    const outside = write("secret.pdf", "secret");
    repo.connection.prepare("UPDATE application_documents SET file_path = ?").run(outside);
    expect(repo.documents.read(app.id, doc.id)).toBeUndefined();
    repo.documents.remove(app.id, doc.id);
    expect(existsSync(outside)).toBe(true);
  });

  it("deleting an application removes its documents and stored files", () => {
    const app = repo.applications.add({ company: "Acme", role: "Eng" });
    repo.documents.saveNote(app.id, "prep.md", "x");
    repo.documents.attachFile(app.id, write("ws/a.pdf"), "a.pdf");
    expect(repo.applications.remove(app.id)).toBe(true);
    expect(repo.documents.list(app.id)).toEqual([]);
    expect(existsSync(join(docsDir, String(app.id)))).toBe(false);
  });

  it("without a docsDir, stores notes but refuses files", () => {
    const bare = new Repository(":memory:");
    const app = bare.applications.add({ company: "Acme", role: "Eng" });
    expect(bare.documents.saveNote(app.id, "n.md", "x").kind).toBe("note");
    expect(() => bare.documents.attachFile(app.id, write("ws/a.pdf"), "a.pdf")).toThrow(
      "need a data directory",
    );
    bare.documents.removeAll(app.id);
    bare.close();
  });
});

describe("importJobHuntDocs", () => {
  function makeCheckout(): string {
    write("hunt/solace/prep.md", "# Solace prep");
    write("hunt/solace/shot.png", "png");
    write("hunt/solace/.DS_Store", "junk");
    write("hunt/inspiren/sys-design/data/report.md", "# Report");
    write("hunt/inspiren/resume/r.pdf", "%PDF");
    write("hunt/archive/socket/CLAUDE.md", "# Socket");
    write("hunt/archive/socket/.claude/settings.local.json", "{}");
    write("hunt/archive/loancrate/prep.md", "# Loancrate");
    write("hunt/src/jobtrack/cli.py", "code");
    write("hunt/docs/plan.md", "dev notes");
    write("hunt/README.md", "root file");
    return join(dir, "hunt");
  }

  it("matches company folders (active and archived) and attaches their files", () => {
    const solace = repo.applications.add({ company: "Solace", role: "Eng" });
    const inspiren = repo.applications.add({ company: "Inspiren", role: "Eng" });
    const socket = repo.applications.add({ company: "Socket", role: "Eng" });
    repo.applications.setStatus(socket.id, "rejected");
    repo.applications.archive(socket.id);

    const result = importJobHuntDocs(repo, makeCheckout());
    expect(result.workspaces.map((w) => [w.company, w.imported, w.skipped])).toEqual([
      ["Inspiren", 2, 0],
      ["Solace", 2, 0],
      ["Socket", 1, 0],
    ]);
    expect(result.unmatched).toEqual([join(dir, "hunt", "archive", "loancrate")]);
    expect(repo.documents.list(solace.id).map((d) => d.name)).toEqual(["prep.md", "shot.png"]);
    expect(repo.documents.list(inspiren.id).map((d) => d.name)).toEqual([
      "resume/r.pdf",
      "sys-design/data/report.md",
    ]);

    // Re-running skips what's there; --overwrite replaces.
    const again = importJobHuntDocs(repo, join(dir, "hunt"));
    expect(again.workspaces.every((w) => w.imported === 0 && w.skipped > 0)).toBe(true);
    write("hunt/solace/prep.md", "# Solace prep v2");
    importJobHuntDocs(repo, join(dir, "hunt"), { overwrite: true });
    const prep = repo.documents.getByName(solace.id, "prep.md");
    expect(prep && repo.documents.getNote(solace.id, prep.id)?.content).toBe("# Solace prep v2");
  });

  it("imports a single folder into a chosen application", () => {
    const app = repo.applications.add({ company: "LoanCrate Inc", role: "Eng" });
    const checkout = makeCheckout();
    const result = importWorkspace(repo, join(checkout, "archive", "loancrate"), app);
    expect(result).toMatchObject({ applicationId: app.id, imported: 1, skipped: 0 });
  });

  it("rejects a path that isn't a folder", () => {
    expect(() => importJobHuntDocs(repo, join(dir, "missing"))).toThrow("not a folder");
    expect(() => importWorkspace(repo, write("file.md"), { id: 1, company: "x" })).toThrow(
      "not a folder",
    );
  });
});
