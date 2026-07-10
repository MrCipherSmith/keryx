import { jaccard, titleSimilarity, tokenSet } from "./text";
import type {
  ConflictHint,
  DuplicateHint,
  MemoryConfig,
  MemoryEntry,
} from "./types";

export type Candidate = {
  title: string;
  summary: string;
  type: string;
  tags: string[];
  scopes: { module: string | null; entity: string | null; files: string[] };
};

export function findDuplicates(
  candidate: Candidate,
  entries: MemoryEntry[],
  config: MemoryConfig,
): DuplicateHint[] {
  const candSummary = tokenSet(candidate.summary);
  const hints: DuplicateHint[] = [];

  for (const entry of entries) {
    const titleSim = titleSimilarity(candidate.title, entry.title);
    const summaryJac = jaccard(candSummary, tokenSet(entry.summary));
    const shared = sharedScopeOrTags(candidate, entry);

    const isDup =
      titleSim >= config.dedup.titleSimilarity ||
      (summaryJac >= config.dedup.summaryJaccard &&
        shared >= config.dedup.minSharedScopeOrTags);

    if (isDup) {
      hints.push({
        path: entry.relativePath,
        title: entry.title,
        titleSimilarity: round(titleSim),
        summaryJaccard: round(summaryJac),
      });
    }
  }

  return hints.sort(
    (a, b) =>
      b.titleSimilarity + b.summaryJaccard - (a.titleSimilarity + a.summaryJaccard),
  );
}

export function findConflicts(
  candidate: Candidate,
  entries: MemoryEntry[],
): ConflictHint[] {
  if (candidate.type !== "decision" && candidate.type !== "constraint") {
    return [];
  }

  const hints: ConflictHint[] = [];
  for (const entry of entries) {
    if (entry.status !== "accepted") {
      continue;
    }
    if (entry.type !== "decision" && entry.type !== "constraint") {
      continue;
    }
    if (sharedScopeOrTags(candidate, entry) >= 1) {
      hints.push({
        path: entry.relativePath,
        title: entry.title,
        reason: `overlaps accepted ${entry.type} in the same scope; review for contradiction`,
      });
    }
  }
  return hints;
}

function sharedScopeOrTags(candidate: Candidate, entry: MemoryEntry): number {
  let count = 0;
  if (
    candidate.scopes.module &&
    entry.scopes.module &&
    candidate.scopes.module === entry.scopes.module
  ) {
    count += 1;
  }
  if (
    candidate.scopes.entity &&
    entry.scopes.entity &&
    candidate.scopes.entity === entry.scopes.entity
  ) {
    count += 1;
  }
  const entryTags = new Set(entry.tags.map((tag) => tag.toLowerCase()));
  for (const tag of candidate.tags) {
    if (entryTags.has(tag.toLowerCase())) {
      count += 1;
    }
  }
  const entryFiles = new Set(entry.scopes.files);
  for (const file of candidate.scopes.files) {
    if (entryFiles.has(file)) {
      count += 1;
    }
  }
  return count;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
