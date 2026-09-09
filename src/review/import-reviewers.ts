import { optionValue } from "../lib/args";
import {
  importProjectSkills,
  renderImportProjectSkillsMarkdown,
  type ImportProjectSkillsResult,
} from "../gdskills/import-skills";
import { collectReviewers, PROJECT_REVIEWER_MODULE } from "./reviewers";

/**
 * Overlay reviewers a Vantage (or similar) skill tree ships for a product
 * codebase. Generic copies of keryx reviewers (`review-logic`, `review-frontend`,
 * …) are NOT overlays: importing those would shadow the bundled engine.
 *
 * The prefix is the whole convention `vantage-review` already uses.
 */
export const OVERLAY_REVIEWER_PREFIX = "review-vantage-";

export type ImportReviewersOptions = {
  projectRoot: string;
  from: string;
  dryRun?: boolean;
  force?: boolean;
};

/**
 * `keryx review import` is the review-shaped spelling of
 * `keryx skills import --module review` with the overlay prefix applied.
 */
export async function importOverlayReviewers(options: ImportReviewersOptions): Promise<ImportProjectSkillsResult> {
  return importProjectSkills({
    projectRoot: options.projectRoot,
    from: options.from,
    module: PROJECT_REVIEWER_MODULE,
    namePrefix: OVERLAY_REVIEWER_PREFIX,
    dryRun: options.dryRun,
    force: options.force,
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
    throw new Error("Usage: keryx review import --from <overlay-home-or-skills-dir>");
  }
  const result = await importOverlayReviewers({
    projectRoot: process.cwd(),
    from,
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

Alias for:

  keryx skills import --from <dir> --module review

with an extra filter: only packages named ${OVERLAY_REVIEWER_PREFIX}* are
imported, so generic copies of bundled reviewers cannot shadow the engine.

Usage:
  keryx review import --from <dir> [--dry-run] [--force] [--json]

After import, \`keryx review reviewers\` must list the new names on the
project half. That is the same call review-orchestrator makes.

For a non-review skill, or a GitHub SKILL.md, use \`keryx skills import\`
directly.
`);
}
