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

/** The subset of {@link ruleReferences} with no file under `.metaproject/rules/`. */
export async function unresolvedRuleReferences(projectRoot: string, content: string): Promise<string[]> {
  const missing: string[] = [];
  for (const ref of ruleReferences(content)) {
    if (!(await pathExists(path.join(projectRoot, ".metaproject", "rules", ref)))) {
      missing.push(ref);
    }
  }
  return missing;
}
