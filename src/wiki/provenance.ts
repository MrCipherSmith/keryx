// Page provenance for LWG-4 (flow 223, phase 0).
//
// `VerifiedAt` (a git sha of the MAIN repository) and `VerifiedScope` (a
// content-hash snapshot of the page's describe-set) live in the page's own
// frontmatter, never in an external index. That is the whole point: a project
// may gitignore `.metaproject/` entirely, or have no git at all
// (`src/commands/init.no-git.test.ts` pins that as supported), and page
// versioning must not depend on either choice (specification §1.1).
//
// The two fields are not redundant. `VerifiedAt` is cheap, human-readable and
// yields "how many commits behind"; `VerifiedScope` is the fallback where git
// cannot answer, and is strictly coarser — changed or unchanged, with no
// commit count and no change classification.
//
// `VerifiedScope` deliberately reuses `computePageNodeHash` rather than adding
// a second hashing routine. The generalisation is the input, not the
// algorithm: today that function is called with a module's top-6 key files,
// which is exactly the defect that lets an edit to a seventh file go
// unnoticed (PRD P4). Here it is called with the whole resolved describe-set.

import { createHash } from "node:crypto";
import type { GraphData } from "../gdgraph/types";
import { parseDescribesField } from "./describes";
import { computePageNodeHash } from "./staleness";

export interface PageProvenance {
  /** Full 40-char git sha, or null when never verified / no git. */
  verifiedAt: string | null;
  /** "sha256:<64 hex>", or null when never computed. */
  verifiedScope: string | null;
  /** Raw `Describes:` patterns as written by a human, in order. */
  describes: string[];
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SCOPE_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Read provenance from a page's raw content. Malformed values are reported as
 * `null` rather than passed through: a `VerifiedAt` that is not a sha would
 * otherwise flow into a `git log` range and fail far from its cause.
 */
export function parseProvenance(content: string): PageProvenance {
  const verifiedAt = singleLineField(content, "VerifiedAt");
  const verifiedScope = singleLineField(content, "VerifiedScope");
  return {
    verifiedAt: verifiedAt && SHA_PATTERN.test(verifiedAt) ? verifiedAt : null,
    verifiedScope: verifiedScope && SCOPE_PATTERN.test(verifiedScope) ? verifiedScope : null,
    // Reuses `describes.ts`'s parser rather than keeping a second copy: two
    // readers of one field drift, and the drift shows up as a page silently
    // describing less than its author wrote.
    describes: parseDescribesField(content),
  };
}

/**
 * Hash the page's whole describe-set (LWG-4, flow 223 AC9).
 *
 * `knownPaths` membership is enforced by `computePageNodeHash` itself, which
 * hashes an unknown or unreadable path as a stable `"<missing>"` sentinel — so
 * a deleted file CHANGES the scope hash instead of silently preserving an
 * "unchanged" verdict. Preserved here on purpose.
 */
export async function computeVerifiedScope(
  cwd: string,
  describePaths: readonly string[],
  graph: GraphData,
): Promise<string> {
  if (describePaths.length === 0) {
    // An undecidable page gets a stable, explicitly-empty marker rather than
    // the hash of nothing, which would be indistinguishable from a real one.
    return `sha256:${createHash("sha256").update("<empty-describe-set>").digest("hex")}`;
  }
  return `sha256:${await computePageNodeHash(cwd, describePaths, graph)}`;
}

/**
 * Set or replace a single-line frontmatter field, returning the new content.
 *
 * Byte-preserving by construction (flow 223 AC8): an existing field is
 * rewritten in place, keeping every other line untouched; a new field is
 * inserted immediately after the last known frontmatter line so it lands in
 * the block rather than in the prose. Line endings are preserved.
 */
export function upsertFrontmatterField(content: string, name: string, value: string): string {
  const lines = content.split("\n");
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, "i");

  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? "")) {
      lines[index] = `${name}: ${value}`;
      return lines.join("\n");
    }
  }

  // Insert after the last contiguous frontmatter field following the H1.
  const known = /^(Version|Type|Status|VerifiedAt|VerifiedScope):/i;
  let anchor = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (known.test(lines[index] ?? "")) {
      anchor = index;
    } else if (anchor >= 0 && (lines[index] ?? "").trim().length === 0) {
      break;
    }
  }
  if (anchor < 0) {
    // No frontmatter at all: place it right after the H1, or at the very top.
    const heading = lines.findIndex((line) => line.startsWith("# "));
    anchor = heading >= 0 ? heading : -1;
  }
  lines.splice(anchor + 1, 0, `${name}: ${value}`);
  return lines.join("\n");
}

/** Convenience: stamp both provenance fields in one pass. */
export function writeProvenance(
  content: string,
  provenance: { verifiedAt?: string | null; verifiedScope?: string | null },
): string {
  let out = content;
  if (provenance.verifiedAt) {
    out = upsertFrontmatterField(out, "VerifiedAt", provenance.verifiedAt);
  }
  if (provenance.verifiedScope) {
    out = upsertFrontmatterField(out, "VerifiedScope", provenance.verifiedScope);
  }
  return out;
}

function singleLineField(content: string, name: string): string | null {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const match = content.match(pattern);
  return match?.[1] ? match[1].trim() : null;
}
