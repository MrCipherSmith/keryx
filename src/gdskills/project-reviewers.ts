import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_SKILLS_DIR } from "./project-skills";
import { reviewerFlags } from "./reviewer-triggers";

// The one owner of what makes a project skill a reviewer and how its flags
// select it. `keryx review reviewers` (src/review/reviewers.ts) reports it and
// `keryx skills import` (import-skills.ts) warns about changes to it; both read
// it from here, so the import cannot describe a family the inventory does not
// report (flow 360, G-009). It lives in gdskills, the lower layer, because
// gdskills must not import review.

/**
 * The module review-orchestrator dispatches wholesale: a project reviewer is a
 * project skill whose module is `review`, at `.metaproject/project-skills/review/<name>/`.
 */
export const PROJECT_REVIEWER_MODULE = "review";

/** Absolute path of the directory project reviewers live in. */
export function projectReviewersRoot(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_SKILLS_DIR, PROJECT_REVIEWER_MODULE);
}

/**
 * The directories under `root` that hold a readable `SKILL.md`, sorted.
 *
 * Never throws. A missing root is an empty list, not a failure: a project with
 * no project skills is the common case. A directory without a SKILL.md is not
 * a skill — the shape a half-written package has — and is skipped silently.
 */
export async function skillPackageNames(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(path.join(root, entry.name, "SKILL.md"), "utf8");
      names.push(entry.name);
    } catch {
      // Not a skill.
    }
  }
  return names.sort();
}

/** The selection flags of every project reviewer on disk, by reviewer name. */
export async function projectReviewerFlags(projectRoot: string): Promise<Map<string, string[]>> {
  const root = projectReviewersRoot(projectRoot);
  const flags = new Map<string, string[]>();
  for (const name of await skillPackageNames(root)) {
    const content = await readFile(path.join(root, name, "SKILL.md"), "utf8").catch(() => undefined);
    if (content !== undefined) flags.set(name, reviewerFlags(content));
  }
  return flags;
}

/** The reviewers in `flagsByReviewer` that carry `flag`, in map order. */
export function flagCarriers(flag: string, flagsByReviewer: ReadonlyMap<string, readonly string[]>): string[] {
  return [...flagsByReviewer].filter(([, flags]) => flags.includes(flag)).map(([name]) => name);
}

/**
 * What a flag carried by `carriers` reviewers does when it is passed.
 *
 * - `own` — exactly one carrier: the flag dispatches that reviewer outright,
 *   without its path gate.
 * - `family` — two or more: the flag selects each of them and leaves each
 *   path-gated.
 * - `none` — nobody carries it.
 */
export function flagStatus(carriers: number): "none" | "own" | "family" {
  return carriers === 0 ? "none" : carriers === 1 ? "own" : "family";
}

/** Each reviewer's family flags: the flags of its that {@link flagStatus} calls `family`. */
export function familyFlagsByReviewer(flagsByReviewer: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const family = new Map<string, string[]>();
  for (const [name, flags] of flagsByReviewer) {
    family.set(name, flags.filter((flag) => flagStatus(flagCarriers(flag, flagsByReviewer).length) === "family"));
  }
  return family;
}
