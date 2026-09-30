import { optionValue } from "../lib/args";
import {
  importProjectSkills,
  optionValues,
  renderImportProjectSkillsMarkdown,
  type ImportProjectSkillsResult,
} from "../gdskills/import-skills";
import { collectReviewers, PROJECT_REVIEWER_MODULE } from "./reviewers";

export type ImportReviewersOptions = {
  projectRoot: string;
  from: string;
  /** Globs over package directory names; required for a tree of several packages. */
  only?: string[];
  dryRun?: boolean;
  force?: boolean;
};

/**
 * `keryx review import` is the review-shaped spelling of
 * `keryx skills import --module review`: same importer, same selection rules,
 * module implied.
 *
 * It used to add a filter of its own — a hardcoded name prefix that was one
 * overlay's naming convention, not a keryx concept. A tree using any other
 * naming imported nothing, and a tree using that one imported everything under
 * it, deprecated aliases included. Which packages become reviewers is now said
 * with `--only`, by the person who knows the tree.
 */
export async function importOverlayReviewers(options: ImportReviewersOptions): Promise<ImportProjectSkillsResult> {
  return importProjectSkills({
    projectRoot: options.projectRoot,
    from: options.from,
    module: PROJECT_REVIEWER_MODULE,
    commandLabel: "keryx review import",
    ...(options.only !== undefined ? { only: options.only } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  });
}

export async function runImportReviewers(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printImportHelp();
    return;
  }
  const from = optionValue(args, "--from");
  if (!from) {
    printImportHelp();
    throw new Error("Usage: keryx review import --from <package-dir|tree> [--only <glob>]...");
  }
  const result = await importOverlayReviewers({
    projectRoot: process.cwd(),
    from,
    only: optionValues(args, "--only"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...result, inventory: await collectReviewers(process.cwd()) }, null, 2));
    return;
  }
  console.log(renderImportProjectSkillsMarkdown(result));
}

export function printImportHelp(): void {
  console.log(`keryx review import

The review-shaped spelling of:

  keryx skills import --from <dir> --module review

Same importer, same rules; the module is implied.

Usage:
  keryx review import --from <package-dir|tree> [--only <glob>]... [--dry-run] [--force] [--json]

--from:
  one reviewer package directory, or a tree that holds several (a directory of
  packages, or a parent that contains skills/).

--only:
  a glob (\`*\`, \`?\`) matched against the package directory name; repeatable.
  Required when --from holds more than one package: every package in module
  review is dispatched as a reviewer, so the import is refused with the list
  of candidates until you say which ones. A single package needs no --only.

In a tree import a package whose frontmatter says \`deprecated: true\` is
skipped; pass its own directory as --from to import it anyway. A name that
collides with a bundled keryx skill is skipped unless --force.

A reviewer with neither \`metadata.paths\` nor a glob in its description is
imported with a warning: it is dispatched on every round.

After import, \`keryx review reviewers\` must list the new names on the
project half. That is the same call review-orchestrator makes.

Examples:
  keryx review import --from ./overlay --only 'review-house-*' --dry-run
  keryx review import --from ./overlay/skills/review-house-api

For a non-review skill, or a GitHub SKILL.md, use \`keryx skills import\`
directly.
`);
}
