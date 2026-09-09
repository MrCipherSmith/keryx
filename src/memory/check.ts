import path from "node:path";
import { pathExists } from "../lib/fs";
import { collectEntries } from "./store";
import { checkMemoryCrossLayer, isDangling } from "./cross-layer";
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

  // Cross-layer references (flow 242, lane E).
  //
  // Until this, `checkMemory` validated exactly one outbound relation — the
  // `Related Scopes` → `Files:` list above — and nothing an entry said in its
  // prose. Measured: an entry linking a deleted wiki page and citing its
  // section identity produced `All checks passed`. Memory had no cross-layer
  // validation at all, so the layer could not answer a reference into deleted
  // knowledge; it did not know it held one.
  //
  // Reported at the same severity as the existing `link` issues, and with the
  // wiki's own verdict carried through verbatim — `removed` names when and why,
  // `pending-removal` says the tombstone has not been written, `undecidable`
  // says the registry could not be read. Flattening those into "broken link"
  // would put this check back in the same position `wiki check-links` is still
  // in one layer over, where a deleted page and a page that never existed read
  // identically.
  for (const finding of await checkMemoryCrossLayer(cwd, entries)) {
    if (!isDangling(finding)) {
      continue;
    }
    issues.push({
      path: finding.reference.entry,
      kind: "cross-layer",
      // Line 0 is not a line: it is how `checkMemoryCrossLayer` reports a
      // finding about the ENTRY rather than about a reference inside it (an
      // entry it could not read at all). Printing "line 0" there would invite
      // the reader to go look at a line that does not exist.
      message:
        finding.reference.line > 0
          ? `line ${finding.reference.line} ${finding.detail}`
          : finding.detail,
    });
  }

  // The generated catalog is disposable and not an integrity prerequisite.
  // Canonical Markdown is always checked directly, even when index.json is
  // absent, stale, or corrupt.

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
