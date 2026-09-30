import path from "node:path";
import { pathExists } from "../lib/fs";

/**
 * Rules a skill names as its standard — `core/reviewing.mdc`,
 * `rules/core/styling.mdc` — normalised to the path under `.metaproject/rules/`.
 *
 * Only backticked `.mdc` references count. That is the shape every skill tree
 * keryx imports uses for "read this rule", and it keeps prose (`src/core/flow/
 * CLAUDE.md`, a bare `core/` directory) from being mistaken for a rule the
 * skill cannot work without.
 *
 * Importing a skill copied its SKILL.md and nothing it pointed at, so a
 * reviewer whose round contract lived in `core/reviewing.mdc` arrived in a
 * project that had no such file — and nothing said so. This is the list both
 * sides check: `keryx skills import` to fetch what is missing, and
 * `keryx review reviewers` to report what is still missing.
 */
export function ruleReferences(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(/`(?:\.metaproject\/)?(?:rules\/)?([a-z0-9_-]+\/[a-z0-9._-]+\.mdc)`/gi)) {
    if (match[1]) refs.add(match[1]);
  }
  return [...refs].sort();
}

/**
 * The directory under `.metaproject/rules/` that holds a project's own version
 * of a rule. `keryx init`, `keryx update` and `keryx skills install` force-copy
 * the bundled rules over `rules/core/` and touch nothing else under `rules/`,
 * so an overlay's rule that shares a name with one keryx ships survives only
 * outside `core/`.
 */
export const PROJECT_RULES_DIR = "project";

/**
 * Project-relative posix path of the project's own slot for a reference:
 * `.metaproject/rules/project/<ref>`, the whole reference kept —
 * `core/x.mdc` → `.metaproject/rules/project/core/x.mdc`.
 *
 * The slot used to be keyed on the basename, so `core/x.mdc` and `house/x.mdc`
 * shared one file: the second rule an import met was reported as differing
 * from the first and installed nowhere. A file lying directly in
 * `rules/project/` is nobody's slot now; it answers only a reference that
 * names it, `project/<name>.mdc`, as the literal file it is.
 */
export function projectRulePath(ref: string): string {
  return path.posix.join(".metaproject", "rules", PROJECT_RULES_DIR, ref);
}

/** Project-relative posix path of the file a reference names literally. */
export function literalRulePath(ref: string): string {
  return path.posix.join(".metaproject", "rules", ref);
}

export type RuleResolution = {
  ref: string;
  /** The project slot, {@link projectRulePath}: the first candidate. */
  project: string;
  /** The file the reference spells out, {@link literalRulePath}: the second candidate. */
  literal: string;
  /** Whichever candidate exists, the project slot first; absent when neither does. */
  resolved?: string;
  /**
   * True when the reference resolves to its project slot — the reviewer reads a
   * different file than the one its text spells out.
   */
  shadowed: boolean;
};

/**
 * Where a rule reference resolves in this project:
 * `.metaproject/rules/project/<ref>` first, then `.metaproject/rules/<ref>`.
 *
 * The one owner of that order. `keryx review reviewers` reports through it and
 * `keryx skills import` decides through it, so the two cannot disagree about
 * which file a reviewer reads.
 */
export async function resolveRuleReference(projectRoot: string, ref: string): Promise<RuleResolution> {
  const project = projectRulePath(ref);
  const literal = literalRulePath(ref);
  const candidates = { ref, project, literal };
  if (await pathExists(path.join(projectRoot, project))) {
    return { ...candidates, resolved: project, shadowed: true };
  }
  if (await pathExists(path.join(projectRoot, literal))) {
    return { ...candidates, resolved: literal, shadowed: false };
  }
  return { ...candidates, shadowed: false };
}

/** The subset of {@link ruleReferences} that resolves to no file, in either location. */
export async function unresolvedRuleReferences(projectRoot: string, content: string): Promise<string[]> {
  const missing: string[] = [];
  for (const ref of ruleReferences(content)) {
    if ((await resolveRuleReference(projectRoot, ref)).resolved === undefined) {
      missing.push(ref);
    }
  }
  return missing;
}

export type ShadowedRule = { ref: string; resolved: string };

/** The subset of {@link ruleReferences} that a `rules/project/<ref>` copy answers instead of the named file. */
export async function shadowedRuleReferences(projectRoot: string, content: string): Promise<ShadowedRule[]> {
  const shadowed: ShadowedRule[] = [];
  for (const ref of ruleReferences(content)) {
    const resolution = await resolveRuleReference(projectRoot, ref);
    if (resolution.shadowed && resolution.resolved !== undefined) {
      shadowed.push({ ref, resolved: resolution.resolved });
    }
  }
  return shadowed;
}

/**
 * A reference a skill makes that {@link ruleReferences} does not cover.
 *
 * - `missing` — a backticked `skills/...` or `rules/...` path ending `.md` or
 *   `.json` with no file at `.metaproject/<path>`.
 * - `non-portable` — a rule cited by an absolute or `~` path. It may well exist
 *   on this machine; it is reported because it is true on exactly one.
 */
export type UnresolvedReference = { ref: string; reason: "missing" | "non-portable" };

export async function unresolvedReferences(projectRoot: string, content: string): Promise<UnresolvedReference[]> {
  const found = new Map<string, UnresolvedReference>();
  for (const match of content.matchAll(/`(?:\.metaproject\/)?((?:skills|rules)\/[^`\s]+\.(?:md|json))`/gi)) {
    const ref = match[1];
    if (!ref || found.has(ref) || ref.split("/").includes("..")) continue;
    if (!(await pathExists(path.join(projectRoot, ".metaproject", ref)))) {
      found.set(ref, { ref, reason: "missing" });
    }
  }
  for (const match of content.matchAll(/`((?:~\/|\/)[^`\s]+\.mdc)`/gi)) {
    const ref = match[1];
    if (ref && !found.has(ref)) found.set(ref, { ref, reason: "non-portable" });
  }
  return [...found.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}
