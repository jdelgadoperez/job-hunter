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

/** Recursively collect every JobPosting node, including those nested in `@graph`/arrays. */
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
  }
  if (Array.isArray(node["@graph"])) {
    collectJobPostings(node["@graph"], out);
  }
}

/**
 * Deterministic, network-free core of the browser fallback: find every
 * `schema.org/JobPosting` embedded as JSON-LD in a page and normalize it. A block
 * with malformed JSON, or a posting missing a title, is skipped without throwing.
 */
export function extractJsonLdPostings(
  html: string,
  pageUrl: string,
  company: string,
): JobPosting[] {
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

  const fetchedAt = new Date();
  const postings: JobPosting[] = [];
  for (const node of nodes) {
    const title = asString(node.title);
    if (!title) {
      continue;
    }
    const url = asString(node.url) ?? pageUrl;
    postings.push({
      id: makePostingId({ company, title, url }),
      company,
      title,
      url,
      source: "browser",
      description: asString(node.description) ?? "",
      location: readLocation(node),
      fetchedAt,
    });
  }
  return postings;
}
