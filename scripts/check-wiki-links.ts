#!/usr/bin/env node
/**
 * Validate that every link from this repo into its GitHub wiki resolves to a real page (and, when
 * present, a real heading anchor). The wiki is a *separate* git repo (`<origin>.wiki.git`), so its
 * pages never show up in a PR diff — the failure mode this guards against is a repo doc (README,
 * INSTALL, …) pointing at a wiki page that was renamed or deleted, leaving a dead link.
 *
 * Usage:  node --import tsx scripts/check-wiki-links.ts <wiki-dir>
 *         WIKI_DIR=<wiki-dir> node --import tsx scripts/check-wiki-links.ts
 *
 * <wiki-dir> is a checkout of the wiki repo (CI clones `<repo>.wiki.git`). Exit code is 0 when all
 * links resolve, 1 when any is broken, 2 on a usage/setup error (missing wiki dir, etc.).
 *
 * Deliberately deterministic — no network, no LLM. Semantic "is the wiki content still accurate"
 * checks are a judgement call and live in the `doc-currency-audit` skill, not this gate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

/** Repo doc surfaces we scan for wiki links. Dev scratch (`docs/superpowers/**`) is skipped. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".vite",
  "superpowers", // docs/superpowers — plan/spec scratch, not user-facing docs
]);

function ownerRepo(): string {
  const fromEnv = process.env.GITHUB_REPOSITORY; // "owner/repo" in GitHub Actions
  if (fromEnv?.includes("/")) return fromEnv;
  const origin = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const slug = origin
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\/[^/]*github\.com\//, "")
    .replace(/^https?:\/\/[^/]+\/git\//, "") // proxy form: http://host/git/owner/repo
    .replace(/\.git$/, "");
  return slug;
}

function walkMarkdown(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(join(dir, entry.name));
    }
  }
}

/** GitHub's heading-anchor slug: lowercase, drop punctuation, collapse spaces to hyphens. */
function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function headingAnchors(pageFile: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of readFileSync(pageFile, "utf8").split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading) anchors.add(slugifyHeading(heading));
  }
  return anchors;
}

type BrokenLink = { file: string; line: number; url: string; reason: string };

function main(): void {
  const wikiDir = process.argv[2] ?? process.env.WIKI_DIR;
  if (!wikiDir) {
    console.error(
      "usage: check-wiki-links.ts <wiki-dir>  (or set WIKI_DIR)\n" +
        "  <wiki-dir> is a checkout of the repo's <origin>.wiki.git",
    );
    process.exit(2);
  }
  if (!existsSync(wikiDir) || !statSync(wikiDir).isDirectory()) {
    console.error(`error: wiki dir not found: ${wikiDir}`);
    process.exit(2);
  }

  const slug = ownerRepo();
  // Match https://github.com/<owner>/<repo>/wiki, optional /<Page-Slug> and optional #anchor.
  const linkRe = new RegExp(
    `https?://github\\.com/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/wiki` +
      `(?:/([^)\\s#"'\`]+))?(?:#([^)\\s"'\`]+))?`,
    "g",
  );

  const files: string[] = [];
  walkMarkdown(repoRoot, files);

  const broken: BrokenLink[] = [];
  let checked = 0;

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      for (const match of text.matchAll(linkRe)) {
        const url = match[0];
        if (url === undefined) continue;
        checked++;
        const rawSlug = match[1];
        const anchor = match[2];
        // Bare .../wiki (directory root) resolves to the Home page.
        const pageSlug = rawSlug ? decodeURIComponent(rawSlug) : "Home";
        const pageFile = join(wikiDir, `${pageSlug}.md`);
        if (!existsSync(pageFile)) {
          broken.push({
            file: relative(repoRoot, file),
            line: i + 1,
            url,
            reason: `no wiki page "${pageSlug}.md"`,
          });
          continue;
        }
        if (anchor) {
          const wanted = slugifyHeading(decodeURIComponent(anchor));
          if (!headingAnchors(pageFile).has(wanted)) {
            broken.push({
              file: relative(repoRoot, file),
              line: i + 1,
              url,
              reason: `page "${pageSlug}" has no heading anchor "#${anchor}"`,
            });
          }
        }
      }
    });
  }

  if (broken.length > 0) {
    console.error(`✖ ${broken.length} broken wiki link(s) of ${checked} checked:\n`);
    for (const b of broken) {
      console.error(`  ${b.file}:${b.line}\n    ${b.url}\n    → ${b.reason}\n`);
    }
    console.error(
      "Fix the link, or update the wiki page/heading it points at " +
        `(wiki repo: https://github.com/${slug}/wiki).`,
    );
    process.exit(1);
  }

  console.log(`✓ all ${checked} wiki link(s) resolve to real pages/anchors.`);
}

main();
