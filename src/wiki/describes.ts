// Describe-set resolution for LWG-1 (flow 223, phase 0).
//
// Answers "which code does this wiki page document?" — the relation the
// `describes` graph edge is built from, and the scope `VerifiedScope` hashes.
// Three sources, highest precedence first (specification §3.3):
//
//   frontmatter   `Describes:` list — REPLACES the derived set for that page.
//                 A human naming the files is correcting the derivation, not
//                 supplementing it, so a frontmatter list of one path means
//                 exactly one path, not one plus six derived ones.
//   related-code  paths linked from the page's `## Related Code` section.
//   key-files     `computeModuleKeyFiles` (`./collect`) — today's derived
//                 top-6-by-connectivity, and the only source that exists
//                 before anyone edits a page.
//
// Pure over its inputs (no I/O), mirroring `collect.ts`'s and `classify.ts`'s
// purity contract: callers read the file and the graph, this module decides.
//
// An empty result is a legitimate outcome, not a failure: an `architecture/*`
// page has no module of its own, and eleven of this repository's fifty-three
// pages are in that position. Callers must treat an empty set as
// "undecidable" — never as "fresh" and never as "orphaned" (specification
// §4.4.1).

import type { DescribesOrigin } from "../gdgraph/types";
import { keyFilesForPage } from "./collect";
import type { WikiPage } from "./types";

export interface DescribeEntry {
  /** Repository-relative path or glob, exactly as written or derived. */
  pattern: string;
  origin: DescribesOrigin;
  /** Known graph paths this pattern matched. Empty when it matched nothing. */
  resolvedPaths: string[];
}

export interface PageDescribeSet {
  /** Wiki-relative page path, e.g. `components/src-ctx.md`. */
  page: string;
  entries: DescribeEntry[];
  /** Union of every entry's `resolvedPaths`, deduplicated and sorted. */
  paths: string[];
  /** The source that won precedence, or `undefined` when nothing resolved. */
  origin: DescribesOrigin | undefined;
  /**
   * True when no pattern resolved to a known path. The page cannot be scored
   * for freshness — which is NOT the same as being fresh.
   */
  undecidable: boolean;
}

/**
 * Parse a `Describes:` frontmatter field. Accepts both a block list
 *
 *     Describes:
 *       - src/core/flow/**
 *       - src/core/flow/canvas/FlowCanvas.tsx
 *
 * and a single inline value (`Describes: src/ctx`). Stops at the first line
 * that is neither blank nor a list item, so a `Describes:` field followed by
 * ordinary prose cannot swallow the document.
 */
export function parseDescribesField(content: string): string[] {
  const lines = content.split("\n");
  const patterns: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = (lines[index] ?? "").match(/^Describes:\s*(.*)$/i);
    if (!match) {
      continue;
    }
    const inline = (match[1] ?? "").trim();
    if (inline.length > 0) {
      // `Describes: a, b` — comma-separated inline form.
      for (const part of inline.split(",")) {
        const value = stripDecoration(part);
        if (value) patterns.push(value);
      }
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.trim().length === 0) {
        break;
      }
      const item = line.match(/^\s+-\s+(.+)$/);
      if (!item) {
        break;
      }
      const value = stripDecoration(item[1] ?? "");
      if (value) patterns.push(value);
    }
    break;
  }

  return dedupe(patterns);
}

/**
 * Extract code paths linked from the page's `## Related Code` section.
 * Recognises backticked paths, markdown links, and bare paths; ignores the
 * generated placeholder line and anything without a path separator or file
 * extension, so prose in that section does not become a phantom edge.
 */
export function parseRelatedCodePaths(content: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => /^##\s+Related Code\s*$/i.test(line));
  if (start < 0) {
    return [];
  }

  const found: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s/.test(line)) {
      break;
    }
    if (/\(none recorded/i.test(line)) {
      continue;
    }
    for (const raw of extractCandidates(line)) {
      const value = stripDecoration(raw);
      if (value && looksLikePath(value)) {
        found.push(value);
      }
    }
  }

  return dedupe(found);
}

/**
 * Resolve one page's describe-set against the paths the graph actually knows.
 *
 * `knownPaths` is the authority for what exists: a pattern that matches
 * nothing contributes no resolved paths but is still reported, so a caller
 * can tell "this page names files that are gone" apart from "this page names
 * nothing" — the first is a stale reference, the second is an undecidable
 * page, and collapsing them would hide a real signal.
 */
export function resolveDescribeSet(input: {
  page: Pick<WikiPage, "relativePath">;
  content: string;
  knownPaths: ReadonlySet<string>;
  keyFilesIndex: ReadonlyMap<string, string[]>;
}): PageDescribeSet {
  const { page, content, knownPaths, keyFilesIndex } = input;

  const sources: Array<{ origin: DescribesOrigin; patterns: string[] }> = [
    { origin: "frontmatter", patterns: parseDescribesField(content) },
    { origin: "related-code", patterns: parseRelatedCodePaths(content) },
    { origin: "key-files", patterns: keyFilesForPage(keyFilesIndex, page) },
  ];

  for (const source of sources) {
    if (source.patterns.length === 0) {
      continue;
    }
    const entries = source.patterns.map((pattern) => ({
      pattern,
      origin: source.origin,
      resolvedPaths: matchPattern(pattern, knownPaths),
    }));
    const paths = dedupe(entries.flatMap((entry) => entry.resolvedPaths)).sort();

    // A source that produced patterns but resolved nothing still WINS
    // precedence — falling through to key-files would silently override an
    // author's explicit (if now-broken) list with a derived one, hiding the
    // breakage behind a plausible answer.
    return {
      page: page.relativePath,
      entries,
      paths,
      origin: source.origin,
      undecidable: paths.length === 0,
    };
  }

  return {
    page: page.relativePath,
    entries: [],
    paths: [],
    origin: undefined,
    undecidable: true,
  };
}

/**
 * Expand one pattern against known paths. A pattern with no wildcard is an
 * exact path match (or a directory prefix, so `src/ctx` covers `src/ctx/a.ts`
 * the way a reader expects). `*` does not cross `/`; `**` does.
 */
export function matchPattern(pattern: string, knownPaths: ReadonlySet<string>): string[] {
  const normalized = normalizePath(pattern);
  if (normalized.length === 0) {
    return [];
  }

  if (!normalized.includes("*")) {
    if (knownPaths.has(normalized)) {
      return [normalized];
    }
    const prefix = `${normalized}/`;
    return [...knownPaths].filter((candidate) => candidate.startsWith(prefix)).sort();
  }

  const regex = globToRegExp(normalized);
  return [...knownPaths].filter((candidate) => regex.test(candidate)).sort();
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` should also match zero directories, so `a/**/b.ts` matches
        // `a/b.ts` — otherwise the most natural way to write "anything under
        // a" silently misses the files directly in it.
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
          continue;
        }
        source += ".*";
        index += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function normalizePath(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function stripDecoration(value: string): string {
  let out = value.trim();
  // markdown link: [text](target) — the target is the path
  const link = out.match(/\[[^\]]*\]\(([^)]+)\)/);
  if (link?.[1]) {
    out = link[1];
  }
  out = out.replace(/^`+|`+$/g, "").trim();
  // trailing prose after a path ("`src/a.ts` - does things")
  out = out.split(/\s+[-–—]\s+/)[0] ?? out;
  return normalizePath(out);
}

function extractCandidates(line: string): string[] {
  const backticked = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
  if (backticked.length > 0) {
    return backticked;
  }
  const item = line.match(/^\s*[-*]\s+(.+)$/);
  return item?.[1] ? [item[1]] : [];
}

function looksLikePath(value: string): boolean {
  if (value.includes(" ")) {
    return false;
  }
  return value.includes("/") || /\.[a-z0-9]+$/i.test(value);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
