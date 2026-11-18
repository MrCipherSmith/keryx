// Related-page groups for `keryx wiki enrich --group related`.
//
// Enrich used to hand each worker one page in list order, so pages that
// describe the same code were rewritten without each other in view. This
// module partitions the selected pages into groups of related pages, so one
// worker takes a whole group and each page's prompt names its group mates.
//
// Pure and deterministic: the same pages and size range always give the same
// groups, every page lands in exactly one group, and no group is larger than
// the requested maximum. Relatedness comes from the page text alone:
//   - a markdown link between two pages, in either direction (a backlink is
//     the same edge seen from the other end);
//   - a source file both pages cite as a code span (`src/x.ts`);
//   - a source directory both pages cite files in.
// A file or directory cited by very many pages says little about any two of
// them, so such keys are ignored (see {@link MAX_SHARED_KEY_PAGES}).

import path from "node:path";
import { extractCodePaths, extractLinks, resolveLink } from "./backlinks";

/** The group size range a caller asks for (both bounds inclusive). */
export interface GroupSizeRange {
  min: number;
  max: number;
}

/** What clustering needs from a page: its wiki-relative path and its text. */
export interface GroupablePage {
  /** Wiki-relative path, e.g. `components/src-wiki.md`. */
  relativePath: string;
  content: string;
}

export const DEFAULT_GROUP_SIZE: GroupSizeRange = { min: 10, max: 20 };

/** Largest group a caller may ask for: one worker's prompt names every mate. */
export const MAX_GROUP_SIZE = 50;

/** A code file or directory shared by more pages than this is not a signal. */
export const MAX_SHARED_KEY_PAGES = 40;

const LINK_WEIGHT = 4;
const SHARED_FILE_WEIGHT = 2;
const SHARED_DIR_WEIGHT = 1;

/**
 * Parse `--group-size`: `N` (exactly N, last group may be smaller) or `MIN-MAX`.
 * Throws with a message naming the accepted forms on anything else.
 */
export function parseGroupSize(raw: string): GroupSizeRange {
  const text = raw.trim();
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(text);
  if (match === null) {
    throw new Error(`--group-size must be N or MIN-MAX (e.g. 10-20), got "${raw}"`);
  }
  const min = Number.parseInt(match[1]!, 10);
  const max = match[2] !== undefined ? Number.parseInt(match[2], 10) : min;
  if (min < 1 || max < min) {
    throw new Error(`--group-size needs 1 <= MIN <= MAX, got "${raw}"`);
  }
  if (max > MAX_GROUP_SIZE) {
    throw new Error(`--group-size MAX is capped at ${MAX_GROUP_SIZE}, got ${max}`);
  }
  return { min, max };
}

/** Undirected weighted affinity between pages, keyed by relative path. */
export function buildPageAffinity(pages: readonly GroupablePage[]): Map<string, Map<string, number>> {
  const known = new Set(pages.map((p) => p.relativePath));
  const affinity = new Map<string, Map<string, number>>();
  for (const page of pages) affinity.set(page.relativePath, new Map());

  const add = (a: string, b: string, weight: number): void => {
    if (a === b) return;
    const ra = affinity.get(a)!;
    const rb = affinity.get(b)!;
    ra.set(b, (ra.get(b) ?? 0) + weight);
    rb.set(a, (rb.get(a) ?? 0) + weight);
  };

  const byFile = new Map<string, Set<string>>();
  const byDir = new Map<string, Set<string>>();
  const index = (map: Map<string, Set<string>>, key: string, page: string): void => {
    const set = map.get(key) ?? new Set<string>();
    set.add(page);
    map.set(key, set);
  };

  for (const page of pages) {
    const from = page.relativePath;
    const linked = new Set<string>();
    for (const raw of extractLinks(page.content)) {
      const target = resolveLink(from, raw);
      if (known.has(target) && target !== from) linked.add(target);
    }
    // One edge per linked pair per direction; a mutual link counts twice.
    for (const target of linked) add(from, target, LINK_WEIGHT);

    for (const code of new Set(extractCodePaths(page.content).map((p) => path.posix.normalize(p)))) {
      index(byFile, code, from);
      index(byDir, path.posix.dirname(code), from);
    }
  }

  const addShared = (map: Map<string, Set<string>>, weight: number): void => {
    for (const members of map.values()) {
      if (members.size < 2 || members.size > MAX_SHARED_KEY_PAGES) continue;
      const list = [...members].sort();
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) add(list[i]!, list[j]!, weight);
      }
    }
  };
  addShared(byFile, SHARED_FILE_WEIGHT);
  addShared(byDir, SHARED_DIR_WEIGHT);
  return affinity;
}

/**
 * Partition pages into groups of related pages.
 *
 * 1. Seed a group with the first unassigned page (path order) and grow it with
 *    the unassigned page most related to the group so far (ties: path order)
 *    until it reaches `max` or nothing unassigned is related to it.
 * 2. Groups that ended below `min` are pooled, kept in the order they were
 *    built (so related remnants stay adjacent, then path order does), and
 *    re-cut into the fewest groups of at most `max`, sized as evenly as possible.
 *
 * Every group has at most `max` pages. When the range leaves room
 * (`min <= max / 2 + 1`, which `10-20` does) every re-cut group also has at
 * least `min`; the only group that can be smaller is the one left when fewer
 * than `min` pages remain to share out, or when there are fewer pages than `min` overall.
 */
export function groupRelatedPages(pages: readonly GroupablePage[], range: GroupSizeRange): string[][] {
  const min = Math.max(1, Math.floor(range.min));
  const max = Math.max(min, Math.floor(range.max));
  const byPath = new Map<string, GroupablePage>();
  for (const page of pages) if (!byPath.has(page.relativePath)) byPath.set(page.relativePath, page);
  const order = [...byPath.keys()].sort();
  if (order.length === 0) return [];
  const affinity = buildPageAffinity(order.map((relativePath) => byPath.get(relativePath)!));

  const unassigned = new Set(order);
  const built: string[][] = [];
  for (const seed of order) {
    if (!unassigned.has(seed)) continue;
    unassigned.delete(seed);
    const group = [seed];
    const score = new Map<string, number>();
    const absorb = (member: string): void => {
      for (const [other, weight] of affinity.get(member) ?? []) {
        if (unassigned.has(other)) score.set(other, (score.get(other) ?? 0) + weight);
      }
    };
    absorb(seed);
    while (group.length < max) {
      let best: string | undefined;
      let bestScore = 0;
      for (const [candidate, value] of score) {
        if (!unassigned.has(candidate)) continue;
        if (value > bestScore || (value === bestScore && best !== undefined && candidate < best)) {
          best = candidate;
          bestScore = value;
        }
      }
      if (best === undefined) break;
      unassigned.delete(best);
      score.delete(best);
      group.push(best);
      absorb(best);
    }
    built.push(group);
  }

  const full = built.filter((g) => g.length >= min);
  const remnants = built.filter((g) => g.length < min).flat();
  return [...full, ...cutEvenly(remnants, max)];
}

/** Cut a list into the fewest chunks of at most `max`, sizes differing by at most one. */
function cutEvenly(items: readonly string[], max: number): string[][] {
  if (items.length === 0) return [];
  const count = Math.ceil(items.length / max);
  const base = Math.floor(items.length / count);
  let extra = items.length % count;
  const out: string[][] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * Parse `--pages`: a comma/newline-separated list, a file holding such a list,
 * or a file holding a JSON array of strings. `readFile` returns null when the
 * argument is not a readable file, in which case it is read as the list itself.
 */
export function parsePagesArgument(raw: string, readFile: (file: string) => string | null): string[] {
  const fromFile = readFile(raw);
  const text = fromFile ?? raw;
  const trimmed = text.trim();
  if (fromFile !== null && trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
      throw new Error(`--pages file ${raw} must hold a JSON array of strings`);
    }
    return dedupe(parsed.map((v) => v.trim()).filter((v) => v.length > 0));
  }
  return dedupe(
    trimmed
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && !v.startsWith("#")),
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
