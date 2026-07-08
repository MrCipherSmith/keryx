import path from "node:path";
import { pathExists } from "../lib/fs";
import { collectEntries } from "./store";
import { findConflicts, findDuplicates, type Candidate } from "./dedup";
import { MEMORY_TYPE_VALUES } from "./types";
import type {
  MemoryCheckIssue,
  MemoryCheckResult,
  MemoryConfig,
  MemoryEntry,
} from "./types";

export async function checkMemory(
  cwd: string,
  config: MemoryConfig,
): Promise<MemoryCheckResult> {
  const entries = await collectEntries(cwd);
  const issues: MemoryCheckIssue[] = [];

  for (const entry of entries) {
    if (!entry.version) {
      issues.push({ path: entry.relativePath, kind: "version", message: "missing Version field" });
    }
    if (!MEMORY_TYPE_VALUES.includes(entry.type)) {
      issues.push({ path: entry.relativePath, kind: "metadata", message: `unknown type "${entry.type}"` });
    }
    if (!entry.summary) {
      issues.push({ path: entry.relativePath, kind: "metadata", message: "empty Summary section" });
    }
    for (const file of entry.scopes.files) {
      const clean = file.replace(/^`|`$/g, "");
      if (!(await pathExists(path.resolve(cwd, clean)))) {
        issues.push({ path: entry.relativePath, kind: "link", message: `related file not found: ${clean}` });
      }
    }
  }

  // Pairwise dedup warnings.
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const dupes = findDuplicates(candidateOf(entry), entries.slice(i + 1), config);
    for (const dupe of dupes) {
      issues.push({ path: entry.relativePath, kind: "dedup", message: `near-duplicate of ${dupe.path}` });
    }
  }

  // Conflict warnings for decisions/constraints.
  for (const entry of entries) {
    if (entry.type !== "decision" && entry.type !== "constraint") continue;
    const others = entries.filter((o) => o.relativePath !== entry.relativePath);
    for (const conflict of findConflicts(candidateOf(entry), others)) {
      if (entry.status !== "conflict") {
        issues.push({ path: entry.relativePath, kind: "conflict", message: `potential conflict with accepted ${conflict.path}` });
      }
    }
  }

  const indexFile = path.join(cwd, ".metaproject", "data", "memory", "index", "index.json");
  if (entries.length > 0 && !(await pathExists(indexFile))) {
    issues.push({ path: "index", kind: "index", message: "index missing; run `keryx memory index`" });
  }

  return { ok: issues.length === 0, issues };
}

function candidateOf(entry: MemoryEntry): Candidate {
  return {
    title: entry.title,
    summary: entry.summary,
    type: entry.type,
    tags: entry.tags,
    scopes: { module: entry.scopes.module, entity: entry.scopes.entity, files: entry.scopes.files },
  };
}
