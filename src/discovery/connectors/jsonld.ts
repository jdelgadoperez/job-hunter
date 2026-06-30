import type { JobPosting } from "@app/domain/types";
import { makePostingId } from "../posting-id";

const SCRIPT_BLOCK = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

type JsonLdNode = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function hasType(node: JsonLdNode, type: string): boolean {
  const t = node["@type"];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

/** Resolve a JSON-LD url against the page it was found on, so relative hrefs become absolute. */
function resolveUrl(raw: string | undefined, pageUrl: string): string {
  if (!raw) {
    return pageUrl;
  }
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return pageUrl;
  }
}

/** Read schema.org jobLocationType; "TELECOMMUTE" → true; other present value → false; absent → undefined. */
function readJobLocationType(node: JsonLdNode): boolean | undefined {
  const value = asString(node.jobLocationType);
  if (value === undefined) return undefined;
  // Case/whitespace-insensitive: feeds emit "TELECOMMUTE", "Telecommute", " telecommute ", etc.
  return value.trim().toUpperCase() === "TELECOMMUTE";
}

/** Pull the human-readable locality out of schema.org's nested jobLocation shape. */
function readLocation(node: JsonLdNode): string | undefined {
  const location = node.jobLocation;
  const place = Array.isArray(location) ? location[0] : location;
  if (place && typeof place === "object") {
    const address = (place as JsonLdNode).address;
    if (address && typeof address === "object") {
      return asString((address as JsonLdNode).addressLocality);
    }
  }
  return undefined;
}

/**
 * Recursively collect every JobPosting node — whether top-level, in `@graph`, in an
 * `itemListElement`/`mainEntity`, or any other nesting — by descending into every array
 * and object value. A JobPosting's own fields are not traversed further.
 */
function collectJobPostings(value: unknown, out: JsonLdNode[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJobPostings(item, out);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const node = value as JsonLdNode;
  if (hasType(node, "JobPosting")) {
    out.push(node);
    return;
  }
  for (const child of Object.values(node)) {
    collectJobPostings(child, out);
  }
}

/** Collect every JobPosting JSON-LD node embedded in a page (shared by the helpers below). */
function jobPostingNodes(html: string): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    const block = match[1];
    if (!block) {
      continue;
    }
    try {
      collectJobPostings(JSON.parse(block), nodes);
    } catch {
      // A malformed JSON-LD block is skipped, never fatal.
    }
  }
  return nodes;
}

/**
 * Pull just the `description` from the first JobPosting JSON-LD node on a page. Used by connectors
 * (e.g. Breezy) whose JSON list omits the description but whose position pages embed it as JSON-LD,
 * so the description can be read over plain HTTP instead of a full browser render. Returns undefined
 * when no JobPosting / description is present.
 */
export function extractJsonLdDescription(html: string): string | undefined {
  for (const node of jobPostingNodes(html)) {
    const description = asString(node.description)?.trim();
    if (description) {
      return description;
    }
  }
  return undefined;
}

/**
 * Deterministic, network-free core of the browser fallback: find every
 * `schema.org/JobPosting` embedded as JSON-LD in a page and normalize it. A block with
 * malformed JSON, or a posting missing a title, is skipped without throwing.
 */
export function extractJsonLdPostings(
  html: string,
  pageUrl: string,
  company: string,
): JobPosting[] {
  const fetchedAt = new Date();
  const postings: JobPosting[] = [];
  for (const node of jobPostingNodes(html)) {
    const title = asString(node.title);
    if (!title) {
      continue;
    }
    const url = resolveUrl(asString(node.url), pageUrl);
    const remote = readJobLocationType(node);
    postings.push({
      id: makePostingId({ company, title, url }),
      company,
      title,
      url,
      source: "browser",
      description: asString(node.description) ?? "",
      location: readLocation(node),
      ...(remote !== undefined ? { remote } : {}),
      fetchedAt,
    });
  }
  return postings;
}
