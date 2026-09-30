import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { optionValue, optionValues } from "../lib/args";
import { ContainedWriteError, writeContained } from "../lib/contained-write";
import { pathExists, toPosix } from "../lib/fs";
import { BUNDLED_GDSKILLS } from "./catalog";
import { bundledRulesSourcePath } from "./install";
import {
  isRegularFile,
  KERYX_RULES_DIR,
  literalRulePath,
  projectRulePath,
  resolveRuleReference,
  ruleReferences,
} from "./rule-references";
import { frontmatterScalar, parseSkillFrontmatter } from "./skill-frontmatter";
import {
  assertProjectWritesContained,
  createProjectSkill,
  hasProjectSkillSlug,
  PROJECT_SKILLS_MANIFEST_PATH,
  projectSkillKey,
  projectSkillPackagePath,
  projectSkillSlug,
  projectSkillWritePaths,
  resolveOriginPath,
  type CreateProjectSkillResult,
} from "./project-skills";
import { flagCarriers, flagStatus, PROJECT_REVIEWER_MODULE, projectReviewerFlags } from "./project-reviewers";
import { reviewerFlagReport, reviewerFlags, reviewerPathGate, type PathTriggerSource } from "./reviewer-triggers";
import { guardOutput, prepareOutputForPersistence } from "../security/guard";

const BUNDLED_NAMES = new Set(BUNDLED_GDSKILLS.map((entry) => entry.name));

export type SkillFetcher = (url: string) => Promise<{ ok: boolean; status: number; text: string }>;

export type ImportProjectSkillsOptions = {
  projectRoot: string;
  from: string;
  module?: string;
  name?: string;
  /**
   * Globs (`*`, `?`) matched against a package's directory name; a package is
   * selected when any of them matches. Required when `--from` is a tree of
   * several packages and any of them lands in module `review`: that module is
   * dispatched wholesale by review-orchestrator, so which reviewers a project
   * gets is a choice the operator makes, not a naming convention keryx guesses.
   */
  only?: string[];
  /** The spelling the operator typed, for refusals. Default `keryx skills import`. */
  commandLabel?: string;
  dryRun?: boolean;
  force?: boolean;
  fetcher?: SkillFetcher;
};

export type ImportedProjectSkill = {
  name: string;
  module: string;
  status: "imported" | "overwritten" | "skipped" | "would-import" | "would-overwrite" | "updated";
  path: string;
  origin: string;
  reason?: string;
  wired?: string;
  /**
   * Where a review package's path triggers come from, for a package that is
   * (or would be) written. Absent for another module and for a skipped row.
   */
  pathsSource?: PathTriggerSource;
  /** Things the importer did that the operator should read; one line each. */
  warnings?: string[];
};

/**
 * The warning a review package gets when nothing gates it on the diff. The
 * first clause is the same text `keryx review reviewers` prints for it.
 */
export const PATHS_NONE_WARNING =
  'paths: none — dispatched on every round. Declare `metadata.paths: "<glob>, <glob>"` in its frontmatter to gate it on the diff.';

function emptyOnlyError(label: string): Error {
  return new Error(
    `${label}: --only needs a glob; an empty value selects nothing. Pass a package directory name or a glob over them (\`*\`, \`?\`), or drop --only.`,
  );
}

/**
 * Every `--only` glob on the command line, for the command spelled `label`.
 *
 * An `--only` that carries no glob — `--only ""`, `--only=`, or a bare
 * `--only` — is refused rather than ignored. Ignored, it read as "no
 * selection", and outside module `review` that imports the whole tree.
 */
export function onlyOption(args: readonly string[], label: string): string[] {
  const values = optionValues(args, "--only");
  const occurrences = args.filter((argument) => argument === "--only" || argument.startsWith("--only=")).length;
  if (values.length !== occurrences || values.some((value) => value.trim().length === 0)) {
    throw emptyOnlyError(label);
  }
  return values;
}

/**
 * A rule an imported skill names as its standard.
 *
 * A reference resolves to its project slot, `.metaproject/rules/project/<ref>`,
 * first and then to `.metaproject/rules/<ref>` — `resolveRuleReference`'s
 * order, which is also what `keryx review reviewers` reports.
 *
 * - `present` — the project already has it, and it is the overlay's version
 *   byte for byte (or the overlay has no version to compare with).
 * - `differs` — the project has a file for that reference with other content
 *   than the overlay's. Never reported as `present`: keryx ships generic rules
 *   under common filenames, and a reviewer reading one of those in place of its
 *   overlay's rule is reviewing against the wrong standard. The overlay's
 *   version goes to the project slot (`target`); `written` says whether it did.
 * - `imported` / `would-import` — found beside the skill's source tree
 *   (`<overlay>/rules/<ref>`) and copied to `.metaproject/rules/<ref>`.
 * - `imported-project` / `would-import-project` — the same, for a name keryx
 *   itself ships under `rules/core/`: copied to the project slot, because
 *   `keryx init`, `keryx update` and `keryx skills install` overwrite
 *   `rules/core/<name>`.
 * - `unresolved` — nowhere to take it from; the skill will cite a rule the
 *   project does not have, and `keryx review reviewers` keeps saying so.
 */
export type ImportedRule = {
  ref: string;
  status:
    | "present"
    | "differs"
    | "imported"
    | "would-import"
    | "imported-project"
    | "would-import-project"
    | "unresolved";
  /** The skills that cite it. */
  citedBy: string[];
  origin?: string;
  reason?: string;
  /** Project-relative path of the file the project already had for this reference. */
  existing?: string;
  /** Project-relative path the overlay's version was, or would be, written to. */
  target?: string;
  /** For `differs`: whether the overlay's version is now at `target`. */
  written?: boolean;
};

export type ImportProjectSkillsResult = {
  from: string;
  /** The `--only` globs the selection was made with; empty when none were given. */
  only: string[];
  imported: ImportedProjectSkill[];
  rules: ImportedRule[];
  dryRun: boolean;
  force: boolean;
};

const DEFAULT_FETCHER: SkillFetcher = async (url) => {
  const response = await fetch(url);
  return { ok: response.ok, status: response.status, text: await response.text() };
};

/**
 * Copy one or more SKILL.md packages into `.metaproject/project-skills/<module>/<name>/`.
 *
 * `--from` is a directory of packages, a SKILL.md file, or an https GitHub URL
 * to a SKILL.md. Origin is stored and hashed so `keryx skills update` /
 * `keryx review reviewers` can later report drift.
 *
 * A skill whose name collides with a bundled gdskill is skipped unless
 * `--force` — otherwise it would shadow the engine.
 *
 * `module=review` is the only module `review-orchestrator` auto-dispatches.
 * Other modules land in the registry and `keryx skills route`, but are not
 * injected into flow-orchestrator's fixed pipeline.
 */
export async function importProjectSkills(options: ImportProjectSkillsOptions): Promise<ImportProjectSkillsResult> {
  const label = importLabel(options);
  if ((options.only ?? []).some((glob) => glob.trim().length === 0)) {
    throw emptyOnlyError(label);
  }
  if (options.module !== undefined && !hasProjectSkillSlug(options.module)) {
    throw new Error(`${label}: --module ${JSON.stringify(options.module)} has no letter or digit to name a module by.`);
  }
  const sources = await resolveImportSources(options);
  if (sources.length === 0) {
    throw new Error(
      `keryx skills import: nothing to import from ${options.from}. Pass a SKILL.md, a directory of skill packages, or an https GitHub URL to a SKILL.md.`,
    );
  }

  // Everything is decided before anything is written: which packages are
  // written, and where every cited rule goes. Then every destination is
  // checked for a symlink out of the project, and only then is the first file
  // written — so a refusal leaves the project as it was, and a dry run refuses
  // exactly what the real run would, in the same words.
  //
  // The reviewers on disk are read now too, so a dry run and a real run
  // compare the incoming packages with the same set.
  const existingFlags = await projectReviewerFlags(options.projectRoot);
  const plans = await Promise.all(sources.map((source) => planOne(options, source)));
  // Rules are resolved for skipped skills too: re-running an import over a
  // project that already has the skills is how a project imported before this
  // step existed gets the rules its reviewers cite.
  const ruleDecisions = await decideReferencedRules(
    options,
    sources
      .filter((source) => !skippedAsDeprecated(source))
      .filter((source) => options.force === true || !BUNDLED_NAMES.has(source.name)),
  );
  await refuseUncontainedWrites(label, options.projectRoot, [
    ...plans.flatMap((plan) => ("write" in plan ? projectSkillWritePaths(plan.write.module, plan.write.name, "single") : [])),
    ...ruleDecisions.flatMap((decision) => ("placement" in decision ? [decision.placement.target] : [])),
  ]);

  const imported: ImportedProjectSkill[] = [];
  for (const plan of plans) {
    imported.push("row" in plan ? plan.row : await writeOne(options, plan));
  }
  addFlagWarnings(imported, sources, existingFlags);
  const rules: ImportedRule[] = [];
  for (const decision of ruleDecisions) {
    rules.push(
      "row" in decision
        ? decision.row
        : options.dryRun
          ? unwrittenRow(decision.placement, decision.dryRunReason)
          : await writePlacedRule(options, decision.placement),
    );
  }
  return {
    from: options.from,
    only: options.only ?? [],
    imported,
    rules,
    dryRun: options.dryRun === true,
    force: options.force === true,
  };
}

function importLabel(options: ImportProjectSkillsOptions): string {
  return options.commandLabel ?? "keryx skills import";
}

/**
 * Refuse the whole run when any of `paths` (project-relative files) would be
 * written through a symlink that leaves the project — checked by the same
 * helper every write below goes through, before the first of them.
 */
async function refuseUncontainedWrites(label: string, projectRoot: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await assertProjectWritesContained(projectRoot, paths);
  } catch (error) {
    if (error instanceof ContainedWriteError) {
      throw new Error(`${label}: ${error.message}. Nothing was written.`, { cause: error });
    }
    throw error;
  }
}

export type UpdateProjectSkillsOptions = {
  projectRoot: string;
  skill?: string;
  all?: boolean;
  from?: string;
  dryRun?: boolean;
  fetcher?: SkillFetcher;
};

/**
 * Re-read each selected skill's Origin and overwrite SKILL.md when the source
 * moved on. A skill with no Origin is skipped, not guessed.
 */
export async function updateProjectSkills(options: UpdateProjectSkillsOptions): Promise<ImportProjectSkillsResult> {
  const registry = await readRegistry(options.projectRoot);
  const selected = selectForUpdate(registry, options);
  if (selected.length === 0) {
    throw new Error(
      options.skill
        ? `keryx skills update: project skill not found: ${options.skill}`
        : "keryx skills update: no project skills with an Origin. Pass --all after an import, or name module/skill.",
    );
  }

  // Every origin is read first, then every destination is checked, then the
  // first file is written — as in the import.
  const plans: UpdatePlan[] = [];
  for (const entry of selected) {
    plans.push(await planUpdate(options, entry));
  }
  await refuseUncontainedWrites(
    "keryx skills update",
    options.projectRoot,
    // createProjectSkill writes under the slugs of the registered module and name.
    plans.flatMap((plan) =>
      "content" in plan
        ? projectSkillWritePaths(projectSkillSlug(plan.entry.module), projectSkillSlug(plan.entry.name), "single")
        : [],
    ),
  );
  const imported: ImportedProjectSkill[] = [];
  for (const plan of plans) {
    imported.push("row" in plan ? plan.row : await writeUpdate(options, plan));
  }
  return {
    from: options.from ?? "(each skill Origin)",
    only: [],
    imported,
    rules: [],
    dryRun: options.dryRun === true,
    force: true,
  };
}

export function renderImportProjectSkillsMarkdown(result: ImportProjectSkillsResult): string {
  const counts = countByStatus(result.imported);
  const lines = [
    "# skills import",
    "",
    `from: ${result.from}`,
    `dry-run: ${result.dryRun ? "yes" : "no"}`,
    `force: ${result.force ? "yes" : "no"}`,
    `imported: ${counts.imported} overwritten: ${counts.overwritten} updated: ${counts.updated} skipped: ${counts.skipped} would-import: ${counts["would-import"]} would-overwrite: ${counts["would-overwrite"]}`,
    "",
  ];
  if (result.dryRun) {
    // A dry run exists to answer one question — what would land — and the
    // per-package rows below bury it among skips and wiring notes.
    const planned = result.imported.filter((row) => row.status === "would-import" || row.status === "would-overwrite");
    lines.push(`## would import (${planned.length}) — dry run, nothing written`, "");
    if (planned.length === 0) {
      lines.push("- nothing");
    }
    for (const row of planned) {
      lines.push(`- ${row.module}/${row.name}${row.status === "would-overwrite" ? " (overwrites the existing one)" : ""}`);
    }
    lines.push("", "## packages", "");
  }
  for (const row of result.imported) {
    const extra = [row.reason, row.wired].filter(Boolean).join(" — ");
    lines.push(`- ${row.module}/${row.name}: ${row.status}${extra ? ` — ${extra}` : ""}`);
    for (const warning of row.warnings ?? []) {
      lines.push(`  - warning: ${warning}`);
    }
  }
  lines.push("");
  if (result.imported.some((row) => row.status === "skipped" && row.reason === DEPRECATED_REASON)) {
    lines.push(
      "A package whose frontmatter says `deprecated: true` is skipped in a tree import. To import one anyway, pass its own directory as --from.",
      "",
    );
  }
  if (result.rules.length > 0) {
    lines.push("## rules the skills cite", "");
    for (const rule of result.rules) {
      const detail = [ruleOutcomeNote(rule, result.dryRun), rule.origin ? `from ${rule.origin}` : undefined, rule.reason]
        .filter(Boolean)
        .join(" — ");
      lines.push(`- ${rule.ref}: ${rule.status}${detail ? ` — ${detail}` : ""} (cited by ${rule.citedBy.join(", ")})`);
    }
    lines.push("");
    if (result.rules.some((rule) => rule.target === projectRulePath(rule.ref))) {
      lines.push(
        "A reviewer that cites `<dir>/<name>.mdc` reads `.metaproject/rules/project/<dir>/<name>.mdc` when that file exists,",
        "and `.metaproject/rules/<dir>/<name>.mdc` otherwise. `keryx init`, `keryx update` and `keryx skills install` overwrite",
        "rules/core with keryx's own rules and leave rules/project alone. `keryx review reviewers` lists each such reference",
        "under `shadowedRules`.",
        "",
      );
    }
  }
  if (result.imported.some((row) => row.module === PROJECT_REVIEWER_MODULE && row.status !== "skipped")) {
    lines.push(
      `Reviewers: \`keryx review reviewers\` must list every imported ${PROJECT_REVIEWER_MODULE}/* name. That is the same call review-orchestrator makes.`,
    );
  }
  if (result.imported.some((row) => row.module !== PROJECT_REVIEWER_MODULE && row.status !== "skipped")) {
    lines.push(
      "Non-review modules are registered for `keryx skills route`. They are NOT injected into flow-orchestrator's fixed pipeline — name the skill in a dispatch if you want it there.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Which file the reviewer ends up reading, for the rows where that is not obvious from the status. */
function ruleOutcomeNote(rule: ImportedRule, dryRun: boolean): string | undefined {
  if (rule.status === "differs") {
    const where =
      rule.existing !== undefined && rule.existing !== rule.target
        ? `${rule.existing} is not the overlay's version`
        : `${rule.target} is not the overlay's version`;
    if (rule.written === true) {
      return rule.existing === rule.target
        ? `${where}; replaced with the overlay's (--force) — that is the file the reviewer reads`
        : `${where}; the overlay's was written to ${rule.target}, which is the file the reviewer reads`;
    }
    if (dryRun && rule.existing !== rule.target) {
      return `${where}; the overlay's would be written to ${rule.target}, which is the file the reviewer would read`;
    }
    return `${where}; the reviewer reads ${rule.existing ?? rule.target}`;
  }
  if (rule.status === "imported-project") {
    return `keryx ships a rule under this name; the overlay's was written to ${rule.target}, which is the file the reviewer reads`;
  }
  if (rule.status === "would-import-project") {
    return `keryx ships a rule under this name; the overlay's would be written to ${rule.target}, which is the file the reviewer would read`;
  }
  // Present, but not at the path the reference spells out: its project slot answers.
  if (rule.status === "present" && rule.existing !== undefined && rule.existing !== literalRulePath(rule.ref)) {
    return `the reviewer reads ${rule.existing}`;
  }
  return undefined;
}

export function githubBlobToRaw(url: string): string {
  const trimmed = url.trim();
  const blob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(trimmed);
  if (blob?.[1] && blob[2] && blob[3] && blob[4]) {
    return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4].split("?")[0]}`;
  }
  const rawGh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/.exec(trimmed);
  if (rawGh?.[1] && rawGh[2] && rawGh[3] && rawGh[4]) {
    return `https://raw.githubusercontent.com/${rawGh[1]}/${rawGh[2]}/${rawGh[3]}/${rawGh[4].split("?")[0]}`;
  }
  return trimmed.split("?")[0] ?? trimmed;
}

export function isHttpsSkillUrl(from: string): boolean {
  return /^https:\/\//i.test(from.trim());
}

// A source's name and module are slugged with the writer's own
// `projectSkillSlug` when the source is built, so the name a guard tests is the
// name that gets written. The guards used to test the raw name: `review_logic`
// passed the bundled-name guard and was registered as `review-logic`, and
// `review_house_api` passed the exists guard and overwrote `review-house-api`.

/** `--module`, as the directory it names; nothing when the option was not given. */
function requestedModule(options: ImportProjectSkillsOptions): string | undefined {
  return options.module ? projectSkillSlug(options.module) : undefined;
}

type ImportSource = {
  /** The package's name as it is written and registered: already a slug. */
  name: string;
  /** Likewise a slug. */
  module: string;
  origin: string;
  content: string;
  /** Absolute path of a local source SKILL.md; absent for a URL. */
  sourcePath?: string;
  /**
   * True when the package was found by listing a directory of packages rather
   * than named by its own path. Only a listed package can be skipped for being
   * deprecated: naming one is the operator asking for it.
   */
  fromTree?: boolean;
};

const DEPRECATED_REASON = "deprecated";

/** `deprecated: true` in the frontmatter, top-level or under `metadata:`. */
function isDeprecated(content: string): boolean {
  const value = frontmatterScalar(content, "deprecated", "top") ?? frontmatterScalar(content, "deprecated", "metadata");
  return value !== undefined && /^true$/i.test(value);
}

/** The frontmatter's own `name`. */
function frontmatterName(content: string): string | undefined {
  return frontmatterScalar(content, "name", "top") || undefined;
}

const KNOWN_CATEGORIES = new Set(["review", "quality", "orchestration", "planning", "platform", "core"]);

/** `metadata.category`, else a top-level `category`, when it is a module keryx knows. */
function frontmatterCategory(content: string): string | undefined {
  const value = frontmatterScalar(content, "category", "metadata") ?? frontmatterScalar(content, "category", "top");
  return value !== undefined && KNOWN_CATEGORIES.has(value) ? value : undefined;
}

function skippedAsDeprecated(source: ImportSource): boolean {
  return source.fromTree === true && isDeprecated(source.content);
}

/**
 * What would gate a review package on the diff once it is imported — the same
 * precedence `keryx review reviewers` applies: `metadata.paths`, then globs in
 * the description, then nothing.
 *
 * Computed from the source text, not read back from the inventory, so a dry
 * run can say it too — through the inventory's own reader, so the warning
 * below and `keryx review reviewers` cannot disagree about a package.
 */
function pathTriggerSource(content: string): PathTriggerSource {
  return reviewerPathGate(content).pathsSource;
}

/** What the operator should read about a package that is, or would be, written. */
function importNotes(source: ImportSource): Pick<ImportedProjectSkill, "pathsSource" | "warnings"> {
  const warnings: string[] = [];
  if (isDeprecated(source.content)) {
    warnings.push("deprecated: true in its frontmatter — imported because it was named by its own path; a tree import skips it.");
  }
  if (source.module !== PROJECT_REVIEWER_MODULE) {
    return warnings.length > 0 ? { warnings } : {};
  }
  const pathsSource = pathTriggerSource(source.content);
  if (pathsSource === "none") warnings.push(PATHS_NONE_WARNING);
  // The `metadata.flags` entries `keryx review reviewers` will drop, in its words.
  warnings.push(...reviewerFlagReport(source.content).warnings);
  return { pathsSource, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * The warning an imported review package gets for a flag that exactly one
 * other project reviewer carries.
 *
 * A flag one reviewer carries is its own: passing it dispatches that reviewer
 * outright, without the path gate. The moment a second reviewer carries it, it
 * is a family flag for both — it selects them and leaves each path-gated. So
 * this import changes how an existing reviewer is dispatched, and nothing else
 * would say so.
 */
function flagCollisionWarning(flag: string, existing: string): string {
  return `flag ${flag} is carried by one existing project reviewer, ${existing}: it becomes a family flag for both, so ${flag} now selects ${existing} path-gated instead of dispatching it outright.`;
}

/**
 * The reverse: an overwrite drops a family flag its installed copy carried,
 * and one reviewer is left carrying it. The flag is that reviewer's own from
 * now on — passing it dispatches the reviewer outright, past its path gate.
 */
function soleCarrierWarning(flag: string, overwritten: string, remaining: string): string {
  return `flag ${flag} is dropped by this version of ${overwritten}, which leaves ${remaining} its only carrier: ${flag} now dispatches ${remaining} outright instead of selecting it path-gated.`;
}

/**
 * Add the flag warnings to each written (or would-be-written) review row.
 * `rows[i]` is the outcome of `sources[i]`. Both warnings are about a change
 * of {@link flagStatus} for a reviewer this row does not replace.
 *
 * {@link flagCollisionWarning}: the carriers are counted as they were on disk
 * before this import — the copies this import replaces included. A flag two or
 * more of them shared was a family flag already: overwriting one of them
 * changes nothing for the other. It fires when there was exactly one carrier
 * and this import leaves that reviewer alone: a package being overwritten does
 * not collide with its own earlier copy, and two packages arriving together
 * that share a flag are an overlay's family, not a change to anything the
 * project had.
 *
 * {@link soleCarrierWarning}: for a flag the replaced copy carried and this
 * version does not, the carriers after the import — every reviewer on disk
 * this import does not replace, and every written package as it now reads. It
 * fires when the flag was a family flag and one of its carriers is left alone
 * with it.
 */
function addFlagWarnings(rows: ImportedProjectSkill[], sources: ImportSource[], existingFlags: Map<string, string[]>): void {
  const isWritten = (row: ImportedProjectSkill): boolean =>
    row.module === PROJECT_REVIEWER_MODULE && row.status !== "skipped";
  const replaced = new Set(rows.filter(isWritten).map((row) => row.name));
  const flagsAfter = new Map(existingFlags);
  for (const [index, row] of rows.entries()) {
    const source = sources[index];
    if (source !== undefined && isWritten(row)) flagsAfter.set(row.name, reviewerFlags(source.content));
  }
  for (const [index, row] of rows.entries()) {
    const source = sources[index];
    if (source === undefined || !isWritten(row)) continue;
    const incoming = reviewerFlags(source.content);
    const warnings: string[] = [];
    for (const flag of incoming) {
      const carriers = flagCarriers(flag, existingFlags);
      const [only] = carriers;
      if (flagStatus(carriers.length) === "own" && only !== undefined && !replaced.has(only)) {
        warnings.push(flagCollisionWarning(flag, only));
      }
    }
    for (const flag of (existingFlags.get(row.name) ?? []).filter((flag) => !incoming.includes(flag))) {
      const before = flagCarriers(flag, existingFlags);
      const after = flagCarriers(flag, flagsAfter);
      const [remaining] = after;
      if (
        flagStatus(before.length) === "family" &&
        flagStatus(after.length) === "own" &&
        remaining !== undefined &&
        before.includes(remaining)
      ) {
        warnings.push(soleCarrierWarning(flag, row.name, remaining));
      }
    }
    if (warnings.length > 0) row.warnings = [...(row.warnings ?? []), ...warnings];
  }
}

/** `*` any run of characters, `?` one; everything else literal. Package names hold no `/`. */
function onlyMatcher(glob: string): (name: string) => boolean {
  const source = glob
    .split("")
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  const regex = new RegExp(`^${source}$`);
  return (name) => regex.test(name);
}

/**
 * A package directory found in a tree.
 *
 * `name` is the directory name as it is on disk: what the operator sees, so
 * what `--only` is matched against and what a refusal lists. `slug` is what
 * that package is written as, and is what every guard tests.
 */
type PackageCandidate = { name: string; slug: string; skillMd: string; content: string };

function candidateList(candidates: PackageCandidate[]): string {
  return candidates
    .map((candidate) => {
      const note = isDeprecated(candidate.content)
        ? " (deprecated — skipped in a tree import)"
        : BUNDLED_NAMES.has(candidate.slug)
          ? " (bundled keryx skill name — skipped unless --force)"
          : "";
      return `  - ${candidate.name}${note}`;
    })
    .join("\n");
}

/** The module a package would pick for itself, or nothing when it cannot be inferred. */
function ownModule(candidate: PackageCandidate): string | undefined {
  try {
    return inferModule(candidate.slug, candidate.content);
  } catch {
    return undefined;
  }
}

function moduleOrUndefined(options: ImportProjectSkillsOptions, candidate: PackageCandidate): string | undefined {
  return requestedModule(options) ?? ownModule(candidate);
}

/**
 * Two selected directories that would be written to one place: the second
 * would be reported as "already exists" against the first, or overwrite it
 * under --force. Refused before anything is written.
 */
function refuseSharedDestinations(label: string, picked: { directory: string; source: ImportSource }[]): void {
  const byDestination = new Map<string, string[]>();
  for (const { directory, source } of picked) {
    const destination = projectSkillKey(source);
    byDestination.set(destination, [...(byDestination.get(destination) ?? []), directory]);
  }
  for (const [destination, directories] of byDestination) {
    if (directories.length > 1) {
      throw new Error(
        `${label}: ${directories.sort().join(" and ")} both import as ${destination}. Narrow --only to one of them, or rename one directory.`,
      );
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The Origin to record for a local source: project-relative when the file is
 * in the project, `~/…` when it is under the home directory, absolute only
 * otherwise.
 *
 * An absolute `/Users/<name>/…` origin is true on exactly one machine. Checked
 * in, it made every reviewer read as drift `missing` on a teammate's laptop
 * and in CI — a provenance record that is wrong everywhere but its author's.
 */
export function portableOriginRef(absolute: string, projectRoot: string, home: string = homedir()): string {
  const resolved = path.resolve(absolute);
  const root = path.resolve(projectRoot);
  if (isInside(root, resolved)) {
    return toPosix(path.relative(root, resolved));
  }
  if (isInside(home, resolved)) {
    return `~/${toPosix(path.relative(home, resolved))}`;
  }
  return resolved;
}

async function resolveImportSources(options: ImportProjectSkillsOptions): Promise<ImportSource[]> {
  if (isHttpsSkillUrl(options.from)) {
    return [await sourceFromUrl(options)];
  }
  const resolved = resolveOriginPath(options.from, options.projectRoot);
  if (!(await pathExists(resolved))) {
    throw new Error(`keryx skills import: --from ${options.from} does not exist (resolved to ${resolved})`);
  }
  const stats = await stat(resolved);
  if (stats.isFile()) {
    return [await sourceFromFile(options, resolved)];
  }
  if (!stats.isDirectory()) {
    throw new Error(`keryx skills import: --from ${options.from} is not a file or directory`);
  }
  return sourceFromDirectory(options, resolved);
}

async function sourceFromUrl(options: ImportProjectSkillsOptions): Promise<ImportSource> {
  const url = options.from.trim();
  if (!/^https:\/\/(github\.com|raw\.githubusercontent\.com)\//i.test(url)) {
    throw new Error(
      "keryx skills import: a remote --from must be an https GitHub URL to a SKILL.md (github.com/.../blob/... or raw.githubusercontent.com). Other hosts are refused.",
    );
  }
  if (/\/tree\//.test(url)) {
    throw new Error(
      "keryx skills import: a GitHub tree URL cannot be listed. Point --from at a SKILL.md file (blob or raw), not a directory.",
    );
  }
  const raw = githubBlobToRaw(url);
  const fetcher = options.fetcher ?? DEFAULT_FETCHER;
  const response = await fetcher(raw);
  if (!response.ok) {
    throw new Error(`keryx skills import: failed to fetch ${raw}: HTTP ${response.status}`);
  }
  const name = sourceName(options, inferNameFromUrl(raw));
  const moduleName = requestedModule(options) ?? inferModule(name, response.text);
  return { name, module: moduleName, origin: url, content: response.text };
}

/**
 * The slug a single-file or URL source is written under: `--name`, else the
 * name inferred from the source. A name with no letter or digit is refused —
 * its slug would be the writer's fallback, a name nobody chose (G-012).
 */
function sourceName(options: ImportProjectSkillsOptions, inferred: string): string {
  const raw = options.name ?? inferred;
  if (!hasProjectSkillSlug(raw)) {
    throw new Error(
      options.name !== undefined
        ? `${importLabel(options)}: --name ${JSON.stringify(raw)} has no letter or digit to name a package by.`
        : `${importLabel(options)}: the name ${JSON.stringify(raw)} has no letter or digit to name a package by. Pass --name <name>.`,
    );
  }
  return projectSkillSlug(raw);
}

/**
 * What to do about a single package directory with no name of its own, in
 * words that work under the command that printed them. `--name` belongs to
 * `keryx skills import`; a command that imports under another label (`keryx
 * review import`) rejects it as an unknown option, so it is pointed at the
 * `keryx skills import` form that takes one.
 */
function renameOrNameAdvice(options: ImportProjectSkillsOptions): string {
  if (options.commandLabel === undefined) {
    return "Rename the directory, or import its SKILL.md with --name <name>.";
  }
  const skillMd = `${options.from.replace(/[\\/]+$/, "")}/SKILL.md`;
  return `Rename the directory, or import its SKILL.md under a name you choose: keryx skills import --from ${skillMd} --module ${options.module ?? "<module>"} --name <name>`;
}

async function sourceFromFile(
  options: ImportProjectSkillsOptions,
  absolute: string,
): Promise<ImportSource> {
  const content = await readFile(absolute, "utf8");
  const name = sourceName(options, inferNameFromPath(absolute, content));
  const moduleName = requestedModule(options) ?? inferModule(name, content);
  return { name, module: moduleName, origin: portableOriginRef(absolute, options.projectRoot), content, sourcePath: absolute };
}

async function sourceFromDirectory(
  options: ImportProjectSkillsOptions,
  absolute: string,
): Promise<ImportSource[]> {
  const { dirs, tree } = await skillPackageDirs(absolute);
  const candidates: PackageCandidate[] = [];
  for (const dir of dirs) {
    const skillMd = path.join(dir, "SKILL.md");
    const name = path.basename(dir);
    candidates.push({ name, slug: projectSkillSlug(name), skillMd, content: await readFile(skillMd, "utf8") });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  const label = importLabel(options);
  const only = options.only ?? [];
  let selected = options.name ? candidates.filter((candidate) => candidate.name === options.name) : candidates;
  if (only.length > 0) {
    const matchers = only.map(onlyMatcher);
    const matched = selected.filter((candidate) => matchers.some((matches) => matches(candidate.name)));
    if (matched.length === 0 && selected.length > 0) {
      throw new Error(
        `${label}: --only ${only.join(" --only ")} matches none of the ${selected.length} package${selected.length === 1 ? "" : "s"} in ${options.from}.\n\nCandidates:\n${candidateList(selected)}`,
      );
    }
    selected = matched;
  } else if (
    tree &&
    !options.name &&
    candidates.length > 1 &&
    candidates.some((candidate) => moduleOrUndefined(options, candidate) === PROJECT_REVIEWER_MODULE)
  ) {
    // Everything in module `review` is dispatched by review-orchestrator. A
    // tree imported whole brings its deprecated aliases, its non-reviewers and
    // anything else that happens to sit there — so the selection is asked for,
    // never inferred from how one overlay names its packages.
    const importable = candidates.filter(
      (candidate) => !isDeprecated(candidate.content) && !BUNDLED_NAMES.has(candidate.slug),
    );
    // Prefer a package that is a reviewer by its own account over one that
    // only lands in review because --module says so.
    const example =
      importable.find((candidate) => ownModule(candidate) === PROJECT_REVIEWER_MODULE) ??
      importable[0] ??
      candidates[0];
    const moduleFlag = options.commandLabel === undefined && options.module ? ` --module ${options.module}` : "";
    throw new Error(
      [
        `${label}: ${options.from} holds ${candidates.length} packages and the import targets module review, where review-orchestrator dispatches every package it finds. Say which ones with --only <glob> (repeatable; matched against the package directory name).`,
        "",
        "Candidates:",
        candidateList(candidates),
        "",
        "Example:",
        `  ${label} --from ${options.from}${moduleFlag} --only '${example?.name ?? "<name>"}'`,
      ].join("\n"),
    );
  }

  // A deprecated package in a tree is skipped, never written: it takes no
  // destination, so it needs no name of its own and collides with nothing.
  const skipped = (candidate: PackageCandidate): boolean => tree && isDeprecated(candidate.content);
  for (const candidate of selected) {
    if (!skipped(candidate) && !hasProjectSkillSlug(candidate.name)) {
      throw new Error(
        `${label}: package directory ${candidate.name} has no letter or digit to name it by. ${
          tree ? "Rename the directory, or leave it out with --only." : renameOrNameAdvice(options)
        }`,
      );
    }
  }
  const picked = selected.map((candidate) => ({
    directory: candidate.name,
    source: {
      name: candidate.slug,
      module: requestedModule(options) ?? inferModule(candidate.slug, candidate.content),
      origin: portableOriginRef(candidate.skillMd, options.projectRoot),
      content: candidate.content,
      sourcePath: candidate.skillMd,
      fromTree: tree,
    } satisfies ImportSource,
  }));
  refuseSharedDestinations(
    label,
    picked.filter(({ source }) => !skippedAsDeprecated(source)),
  );
  return picked
    .map(({ source }) => source)
    .sort((a, b) => projectSkillKey(a).localeCompare(projectSkillKey(b)));
}

/** The package directories under `root`; `tree` is false when `root` is itself one package. */
async function skillPackageDirs(root: string): Promise<{ dirs: string[]; tree: boolean }> {
  if (await pathExists(path.join(root, "SKILL.md"))) {
    return { dirs: [root], tree: false };
  }
  const nestedSkills = path.join(root, "skills");
  const scan = (await pathExists(nestedSkills)) ? nestedSkills : root;
  const entries = await readdir(scan, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(scan, entry.name);
    if (await pathExists(path.join(dir, "SKILL.md"))) {
      dirs.push(dir);
    }
  }
  return { dirs, tree: true };
}

/** What an import does with one source: a row that is already final, or a package to write. */
type ImportPlan = { row: ImportedProjectSkill } | { write: ImportSource; exists: boolean };

async function planOne(options: ImportProjectSkillsOptions, source: ImportSource): Promise<ImportPlan> {
  const dest = projectSkillPackagePath(source.module, source.name);
  const destAbs = path.join(options.projectRoot, dest, "SKILL.md");
  const exists = await pathExists(destAbs);
  const bundled = BUNDLED_NAMES.has(source.name);

  if (skippedAsDeprecated(source)) {
    return {
      row: {
        name: source.name,
        module: source.module,
        status: "skipped",
        path: dest,
        origin: source.origin,
        reason: DEPRECATED_REASON,
      },
    };
  }

  if (bundled && !options.force) {
    return {
      row: {
        name: source.name,
        module: source.module,
        status: "skipped",
        path: dest,
        origin: source.origin,
        reason: "name collides with a bundled keryx skill; pass --force to shadow it",
      },
    };
  }

  if (exists && !options.force) {
    return {
      row: {
        name: source.name,
        module: source.module,
        status: "skipped",
        path: dest,
        origin: source.origin,
        reason: "already exists; pass --force to overwrite",
        wired: wiringNote(source.module),
      },
    };
  }

  return { write: source, exists };
}

/** Write one planned package — or, on a dry run, say it would be written. */
async function writeOne(
  options: ImportProjectSkillsOptions,
  { write: source, exists }: { write: ImportSource; exists: boolean },
): Promise<ImportedProjectSkill> {
  if (options.dryRun) {
    return {
      name: source.name,
      module: source.module,
      status: exists ? "would-overwrite" : "would-import",
      path: projectSkillPackagePath(source.module, source.name),
      origin: source.origin,
      wired: wiringNote(source.module),
      ...importNotes(source),
    };
  }

  const created = await createProjectSkill(options.projectRoot, {
    target: source.name,
    module: source.module,
    name: source.name,
    note: `Imported from ${options.from}`,
    origin: source.origin,
    originContent: source.content,
    ...versionOption(source.content),
    format: "single",
  });
  await overwriteImportedSkill(options.projectRoot, created, source.content);

  return {
    name: source.name,
    module: source.module,
    status: exists ? "overwritten" : "imported",
    path: created.skillPath,
    origin: source.origin,
    wired: wiringNote(source.module),
    ...importNotes(source),
  };
}

type RegistryEntry = { module: string; name: string; path: string };

/** What an update does with one registry entry: a final row, or new content to write over it. */
type UpdatePlan = { row: ImportedProjectSkill } | { entry: RegistryEntry; origin: string; content: string };

async function planUpdate(options: UpdateProjectSkillsOptions, entry: RegistryEntry): Promise<UpdatePlan> {
  const skillMd = path.join(options.projectRoot, entry.path, "SKILL.md");
  const current = await readFile(skillMd, "utf8");
  let origin = options.from ?? metadataLine(current, "Origin");
  const skippedRow = (reason: string, recorded: string): { row: ImportedProjectSkill } => ({
    row: { name: entry.name, module: entry.module, status: "skipped", path: entry.path, origin: recorded, reason },
  });
  if (!origin) {
    return skippedRow("no Origin recorded", "");
  }

  let content: string;
  if (isHttpsSkillUrl(origin)) {
    const fetcher = options.fetcher ?? DEFAULT_FETCHER;
    const response = await fetcher(githubBlobToRaw(origin));
    if (!response.ok) {
      return skippedRow(`failed to fetch origin: HTTP ${response.status}`, origin);
    }
    content = response.text;
  } else {
    const resolved = resolveOriginPath(origin, options.projectRoot);
    if (!(await pathExists(resolved))) {
      return skippedRow("origin file can no longer be read", origin);
    }
    content = await readFile(resolved, "utf8");
    origin = portableOriginRef(resolved, options.projectRoot);
  }
  return { entry, origin, content };
}

/** Write one planned update — or, on a dry run, say it would be written. */
async function writeUpdate(
  options: UpdateProjectSkillsOptions,
  { entry, origin, content }: { entry: RegistryEntry; origin: string; content: string },
): Promise<ImportedProjectSkill> {
  if (options.dryRun) {
    return {
      name: entry.name,
      module: entry.module,
      status: "would-overwrite",
      path: entry.path,
      origin,
      wired: wiringNote(entry.module),
    };
  }

  const created = await createProjectSkill(options.projectRoot, {
    target: entry.name,
    module: entry.module,
    name: entry.name,
    note: `Updated from origin ${origin}`,
    origin,
    originContent: content,
    ...versionOption(content),
    format: "single",
  });
  await overwriteImportedSkill(options.projectRoot, created, content);
  return {
    name: entry.name,
    module: entry.module,
    status: "updated",
    path: created.skillPath,
    origin,
    wired: wiringNote(entry.module),
  };
}

async function overwriteImportedSkill(
  projectRoot: string,
  created: CreateProjectSkillResult,
  source: string,
): Promise<void> {
  const relative = toPosix(path.join(created.skillPath, "SKILL.md"));
  const scaffold = await readFile(path.join(projectRoot, relative), "utf8");
  const header = extractImportHeader(scaffold, parseSkillFrontmatter(source).metadataVersion);
  const stamped = stampImportHeader(source, header);
  const guard = await guardOutput({
    cwd: projectRoot,
    content: stamped,
    target: "skill",
    source: "untrusted-external",
    path: relative,
  });
  const output = prepareOutputForPersistence(guard, stamped);
  if (!output.allowed) {
    throw new Error(`Project skill blocked by the security gate: ${output.reason}`);
  }
  await writeContained(projectRoot, relative, output.content);
}

/**
 * The keryx header an imported skill keeps: `Version`, `Target`, `Module`,
 * the three origin lines, `Status`, `Last Verified` — in the scaffold's order.
 *
 * The import used to keep only the origin lines and drop the rest with the
 * scaffold. `keryx skills verify` reads exactly those dropped labels, so every
 * imported skill verified as `stale` (no Version, no Target) and could never
 * record a verification (no `Last Verified:` line to update). The source's
 * body stays byte-for-byte; the header is what makes it a project skill.
 */
const IMPORT_HEADER_LABELS = [
  "Version",
  "Target",
  "Module",
  "Origin",
  "Origin Hash",
  "Imported At",
  "Status",
  "Last Verified",
];

const IMPORT_HEADER_LINE = new RegExp(`^(${IMPORT_HEADER_LABELS.join("|")}):\\s`);

export function extractImportHeader(scaffold: string, version?: string): string {
  const lines = scaffold
    .split("\n")
    .filter((line) => IMPORT_HEADER_LINE.test(line))
    .map((line) => (version && line.startsWith("Version:") ? `Version: ${version}` : line));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Insert `header` right after the source's frontmatter.
 *
 * A header left by an earlier import — the run of header lines directly after
 * the frontmatter — is replaced, not stacked. Origin lines are stripped
 * wherever they are, as before. Other labels deeper in the body are the
 * author's text and are left alone: a `Status:` line in a template is not ours.
 */
/** U+FEFF, which the frontmatter reader skips at the start of a file. */
const BYTE_ORDER_MARK = 0xfeff;

export function stampImportHeader(source: string, header: string): string {
  if (!header) return source;
  // The frontmatter reader (skill-frontmatter.ts) accepts a leading BOM and
  // CRLF line ends, so the fences are found the same way here: the BOM stays in
  // front of the file, and the header goes after the whole closing fence line.
  const bom = source.charCodeAt(0) === BYTE_ORDER_MARK ? source.slice(0, 1) : "";
  const stripped = source
    .slice(bom.length)
    .replace(/^Origin Hash:.*\n/gm, "")
    .replace(/^Origin:.*\n/gm, "")
    .replace(/^Imported At:.*\n/gm, "");
  const insertAt = afterFrontmatter(stripped);
  if (insertAt === undefined) return `${bom}${header}${stripped}`;
  let bodyStart = insertAt;
  while (true) {
    const lineEnd = stripped.indexOf("\n", bodyStart);
    const line = stripped.slice(bodyStart, lineEnd === -1 ? stripped.length : lineEnd);
    if (!IMPORT_HEADER_LINE.test(line)) break;
    bodyStart = lineEnd === -1 ? stripped.length : lineEnd + 1;
  }
  // A closing fence at the very end of the file has no line end of its own.
  const separator = insertAt > 0 && stripped[insertAt - 1] !== "\n" ? "\n" : "";
  return `${bom}${stripped.slice(0, insertAt)}${separator}${header}${stripped.slice(bodyStart)}`;
}

/**
 * The offset just past the frontmatter's closing fence line — its line end
 * included — or nothing when `text` does not open with a `---` line that is
 * closed by another. The same fences `frontmatterLines` reads.
 */
function afterFrontmatter(text: string): number | undefined {
  const firstEnd = text.indexOf("\n");
  if (firstEnd === -1 || text.slice(0, firstEnd).trimEnd() !== "---") return undefined;
  let start = firstEnd + 1;
  while (start <= text.length) {
    const lineEnd = text.indexOf("\n", start);
    const next = lineEnd === -1 ? text.length : lineEnd + 1;
    if (text.slice(start, lineEnd === -1 ? text.length : lineEnd).trimEnd() === "---") return next;
    if (lineEnd === -1) return undefined;
    start = next;
  }
  return undefined;
}

function versionOption(content: string): { version?: string } {
  const version = parseSkillFrontmatter(content).metadataVersion;
  return version ? { version } : {};
}

/**
 * Where an overlay keeps the rules its skills cite: a `rules/` directory in
 * the skill's own directory or up to three levels above it. That covers the
 * layouts `--from` accepts — `<home>/skills/<name>/SKILL.md` finds
 * `<home>/rules/`.
 *
 * Only a regular file is the overlay's rule. `notRegular` is the first
 * candidate something else sits at, so a lookup that finds no file can say
 * which path was passed over.
 */
async function findOverlayRule(sourcePath: string, ref: string): Promise<{ found?: string; notRegular?: string }> {
  let dir = path.dirname(sourcePath);
  let notRegular: string | undefined;
  for (let depth = 0; depth <= 3; depth += 1) {
    const candidate = path.join(dir, "rules", ref);
    if (await isRegularFile(candidate)) return { found: candidate };
    if (notRegular === undefined && (await pathExists(candidate))) notRegular = candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return notRegular !== undefined ? { notRegular } : {};
}

type RuleCitation = {
  ref: string;
  /** The skills that cite it, sorted. */
  citedBy: string[];
  /** The local SKILL.md files of those skills; empty when every one came from a URL. */
  sourcePaths: string[];
};

/** Every rule the sources cite, one entry per reference, in reference order. */
function collectRuleCitations(sources: ImportSource[]): RuleCitation[] {
  const byRef = new Map<string, RuleCitation>();
  for (const source of sources) {
    for (const ref of ruleReferences(source.content)) {
      const citation = byRef.get(ref) ?? { ref, citedBy: [], sourcePaths: [] };
      citation.citedBy.push(source.name);
      if (source.sourcePath) citation.sourcePaths.push(source.sourcePath);
      byRef.set(ref, citation);
    }
  }
  return [...byRef.values()]
    .map((citation) => ({ ...citation, citedBy: citation.citedBy.sort() }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/** An overlay's rule that has somewhere to go: everything the outcomes below report. */
type RulePlacement = {
  ref: string;
  citedBy: string[];
  origin: string;
  /** The overlay's text. */
  content: string;
  /** Project-relative path it is, or would be, written to. */
  target: string;
  /** True when `target` is the reference's project slot rather than the path it names. */
  toProjectSlot: boolean;
  /** The file the project already has for the reference — a collision — and its text. */
  existing?: { path: string; content: string };
};

/** The row for a placement that was not written, for the reason given (none on a plain dry run). */
function unwrittenRow(placement: RulePlacement, reason?: string): ImportedRule {
  const { ref, citedBy, origin, target } = placement;
  if (placement.existing !== undefined) {
    return {
      ref,
      citedBy,
      status: "differs",
      origin,
      existing: placement.existing.path,
      target,
      written: false,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  return { ref, citedBy, status: placement.toProjectSlot ? "would-import-project" : "would-import", origin, target };
}

function writtenRow(placement: RulePlacement): ImportedRule {
  const { ref, citedBy, origin, target } = placement;
  if (placement.existing !== undefined) {
    return { ref, citedBy, status: "differs", origin, existing: placement.existing.path, target, written: true };
  }
  return { ref, citedBy, status: placement.toProjectSlot ? "imported-project" : "imported", origin, target };
}

/**
 * What an import does about one cited rule: a row that is already final, or a
 * placement still to be written through the security gate.
 *
 * Which file the project has for the reference is `resolveRuleReference`'s
 * answer, not this function's own reading of the directory — the importer and
 * `keryx review reviewers` must agree on the file a reviewer reads. A dry run
 * is decided here, from the same placement a real run writes, so the two name
 * one destination.
 */
type RuleDecision = { row: ImportedRule } | { placement: RulePlacement; dryRunReason?: string };

async function decideRule(
  options: ImportProjectSkillsOptions,
  citation: RuleCitation,
  bundledRules: string,
): Promise<RuleDecision> {
  const base = { ref: citation.ref, citedBy: citation.citedBy };
  const resolution = await resolveRuleReference(options.projectRoot, citation.ref);
  const existing = resolution.resolved;
  // A name keryx itself ships under rules/core is installed — and overwritten
  // on every run — by `keryx init`, `keryx update` and `keryx skills install`.
  // An overlay's file copied there would be silently replaced by a different
  // file of the same name.
  // `ruleReferences` already spelled a case variant of the directory as
  // KERYX_RULES_DIR, so this comparison is exact.
  const shipsWithKeryx =
    citation.ref.startsWith(`${KERYX_RULES_DIR}/`) &&
    (await pathExists(path.join(bundledRules, path.basename(citation.ref))));
  // Something at a candidate that is not a regular file (a directory, say) is
  // neither read nor written over: the reference stays unresolved, named by
  // path, as `keryx review reviewers` reports it, and the rest of the import
  // goes on.
  const notRegularFiles = resolution.notRegularFiles ?? [];
  const notRegularReason = (candidate: string): string => `${candidate} is not a regular file; nothing was written there`;

  let found: string | undefined;
  let overlayNotRegular: string | undefined;
  for (const sourcePath of citation.sourcePaths) {
    const lookup = await findOverlayRule(sourcePath, citation.ref);
    found = lookup.found;
    overlayNotRegular ??= lookup.notRegular;
    if (found) break;
  }
  if (!found) {
    if (existing !== undefined) {
      // Nothing to compare it with: the project's file is the only version.
      return { row: { ...base, status: "present", existing } };
    }
    const reason = shipsWithKeryx
      ? "ships with keryx — run `keryx skills install` to restore it"
      : notRegularFiles[0] !== undefined
        ? `${notRegularFiles[0]} is not a regular file`
        : overlayNotRegular !== undefined
          ? `${portableOriginRef(overlayNotRegular, options.projectRoot)} is not a regular file`
          : citation.sourcePaths.length > 0
            ? "no rules/ directory beside the source has it"
            : "remote source; rules are not fetched";
    return { row: { ...base, status: "unresolved", reason } };
  }

  const origin = portableOriginRef(found, options.projectRoot);
  const content = await readFile(found, "utf8");
  const existingContent =
    existing !== undefined ? await readFile(path.join(options.projectRoot, existing), "utf8") : undefined;
  if (existing !== undefined && existingContent === content) {
    return { row: { ...base, status: "present", origin, existing } };
  }

  // Where the overlay's version goes. A colliding name never lands on the file
  // it collides with: rules/core belongs to keryx's own install, and any other
  // existing file is the project's own.
  const collision =
    existing !== undefined && existingContent !== undefined ? { path: existing, content: existingContent } : undefined;
  const toProjectSlot = collision !== undefined || shipsWithKeryx;
  const target = toProjectSlot ? resolution.project : resolution.literal;
  if (notRegularFiles.includes(target)) {
    return { row: { ...base, status: "unresolved", origin, reason: notRegularReason(target) } };
  }
  const placement: RulePlacement = {
    ...base,
    origin,
    content,
    target,
    toProjectSlot,
    ...(collision !== undefined ? { existing: collision } : {}),
  };
  // The project-slot copy itself differs: it may be a hand edit, and an import
  // never overwrote a project's rule. `--force` is the operator asking.
  const replacesProjectCopy = resolution.shadowed;
  if (replacesProjectCopy && options.force !== true) {
    return { row: unwrittenRow(placement, "left as it is; pass --force to replace it with the overlay's") };
  }
  // A dry run turns this into an unwritten row — after the destination has
  // been checked like the real run's, so both refuse the same symlink.
  return replacesProjectCopy ? { placement, dryRunReason: "would be replaced with the overlay's (--force)" } : { placement };
}

/** Write a placed rule through the security gate, and report what became of it. */
async function writePlacedRule(options: ImportProjectSkillsOptions, placement: RulePlacement): Promise<ImportedRule> {
  const { ref, citedBy, origin, target } = placement;
  const guard = await guardOutput({
    cwd: options.projectRoot,
    content: placement.content,
    target: "skill",
    source: "untrusted-external",
    path: target,
  });
  const output = prepareOutputForPersistence(guard, placement.content);
  if (!output.allowed) {
    const reason = `blocked by the security gate: ${output.reason}`;
    return placement.existing !== undefined
      ? unwrittenRow(placement, reason)
      : { ref, citedBy, status: "unresolved", origin, reason };
  }
  if (placement.existing?.content === output.content) {
    // The gate rewrote the overlay's text and the project already holds that result.
    return { ref, citedBy, status: "present", origin, existing: placement.existing.path };
  }
  await writeContained(options.projectRoot, target, output.content);
  return writtenRow(placement);
}

/** One decision per cited rule, in citation order; nothing is written here. */
async function decideReferencedRules(
  options: ImportProjectSkillsOptions,
  sources: ImportSource[],
): Promise<RuleDecision[]> {
  const bundledRules = bundledRulesSourcePath();
  const decisions: RuleDecision[] = [];
  for (const citation of collectRuleCitations(sources)) {
    decisions.push(await decideRule(options, citation, bundledRules));
  }
  return decisions;
}

function inferNameFromPath(filePath: string, content: string): string {
  const fromFrontmatter = frontmatterName(content);
  if (fromFrontmatter) return fromFrontmatter;
  const parent = path.basename(path.dirname(filePath));
  if (parent && parent !== "skills" && parent !== ".") return parent;
  return path.basename(filePath, path.extname(filePath));
}

function inferNameFromUrl(url: string): string {
  const cleaned = url.replace(/\/SKILL\.md$/i, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "imported-skill";
}

function inferModule(name: string, content: string): string {
  const category = frontmatterCategory(content);
  if (category) return category;
  if (name.startsWith("review-") || name.startsWith("code-")) return PROJECT_REVIEWER_MODULE;
  throw new Error(
    `keryx skills import: cannot infer module for ${name}. Pass --module review|quality|orchestration|…`,
  );
}

function wiringNote(moduleName: string): string {
  if (moduleName === PROJECT_REVIEWER_MODULE) {
    return "review-orchestrator will dispatch this after `keryx review reviewers` lists it";
  }
  return "registered for `keryx skills route`; not auto-injected into flow-orchestrator";
}

function metadataLine(content: string, label: string): string | undefined {
  const match = content.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

async function readRegistry(projectRoot: string): Promise<RegistryEntry[]> {
  const { readJsonFileOr } = await import("../lib/json");
  const manifestPath = path.join(projectRoot, PROJECT_SKILLS_MANIFEST_PATH);
  const manifest = await readJsonFileOr<{
    modules?: { gdskills?: { projectSkillRegistry?: RegistryEntry[] } };
  }>(manifestPath, {});
  return manifest.modules?.gdskills?.projectSkillRegistry ?? [];
}

function selectForUpdate(registry: RegistryEntry[], options: UpdateProjectSkillsOptions): RegistryEntry[] {
  if (options.skill) {
    const normalized = options.skill.replace(/\/SKILL\.md$/i, "");
    const hit = registry.find(
      (entry) => projectSkillKey(entry) === normalized || entry.name === normalized,
    );
    return hit ? [hit] : [];
  }
  if (options.all) return registry;
  return [];
}

function countByStatus(rows: ImportedProjectSkill[]): Record<ImportedProjectSkill["status"], number> {
  const counts: Record<ImportedProjectSkill["status"], number> = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    "would-import": 0,
    "would-overwrite": 0,
    updated: 0,
  };
  for (const row of rows) {
    counts[row.status] += 1;
  }
  return counts;
}

export async function runSkillsImportCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSkillsImportHelp();
    return;
  }
  const from = optionValue(args, "--from");
  if (!from) {
    printSkillsImportHelp();
    throw new Error("Usage: keryx skills import --from <dir|SKILL.md|https://github.com/.../SKILL.md>");
  }
  const moduleName = optionValue(args, "--module");
  const skillName = optionValue(args, "--name");
  const result = await importProjectSkills({
    projectRoot: process.cwd(),
    from,
    ...(moduleName !== undefined ? { module: moduleName } : {}),
    ...(skillName !== undefined ? { name: skillName } : {}),
    only: onlyOption(args, "keryx skills import"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderImportProjectSkillsMarkdown(result));
}

export async function runSkillsUpdateCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSkillsUpdateHelp();
    return;
  }
  const positional = args.slice(1).filter((arg) => !arg.startsWith("--"));
  const from = optionValue(args, "--from");
  const result = await updateProjectSkills({
    projectRoot: process.cwd(),
    ...(positional[0] !== undefined ? { skill: positional[0] } : {}),
    all: args.includes("--all"),
    ...(from !== undefined ? { from } : {}),
    dryRun: args.includes("--dry-run"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderImportProjectSkillsMarkdown(result));
}

export function printSkillsImportHelp(): void {
  console.log(`keryx skills import

Copy a SKILL.md (or a directory of them) into this project's
.metaproject/project-skills/<module>/<name>/, recording Origin so drift is
detectable.

Usage:
  keryx skills import --from <dir|SKILL.md|https-url> [--module <module>] [--name <name>]
                      [--only <glob>]... [--dry-run] [--force] [--json]

--from:
  a skill package directory, a SKILL.md file, a parent tree that contains
  skills/, or an https GitHub blob/raw URL to a SKILL.md.

--module:
  destination module. \`review\` is the only module review-orchestrator
  auto-dispatches. Other modules register for \`keryx skills route\` and are
  NOT injected into flow-orchestrator.

--only:
  a glob (\`*\`, \`?\`) matched against the package directory name; repeatable.
  Required when --from is a tree of several packages and the import targets
  module \`review\`: every package there is dispatched as a reviewer, so the
  import is refused with the list of candidates until you say which ones.
  A single package directory or a SKILL.md needs no --only. An empty value
  (--only "") is an error.

--name:
  the name to import a SKILL.md file or URL under. With a tree, it selects the
  one package whose directory has that name.

--only and --name match the directory name as it is on disk. The package is
written under the slug of that name (review_house_api -> review-house-api),
and the destination, the already-exists and bundled-name checks and the
reported row all use the slug. Two selected directories that slug to one
destination are refused before anything is written.

In a tree import a package whose frontmatter says \`deprecated: true\` is
skipped. Pass its own directory as --from to import it anyway.

A name that collides with a bundled keryx skill is skipped unless --force.

A package landing in module \`review\` is imported with a warning for each of:
  - neither \`metadata.paths\` nor a glob in its description (a file path named
    without a glob is not a trigger): it is dispatched on every round.
  - a \`metadata.flags\` entry that is not a flag after normalising (lower-case,
    \`--\` prefixed): it is dropped. When metadata.flags has at least one
    entry, the flags in the description are not used — even when none of its
    entries is a flag, or it holds only --all. An empty list ([] or '') leaves
    the description's flags in force.
  - a flag that exactly one existing project reviewer carries: it becomes a
    family flag for both, so that reviewer is path-gated under it from now on.
  - with --force, a family flag the new version drops that leaves exactly one
    other reviewer carrying it: that reviewer is dispatched outright under it
    from now on.

Frontmatter is read as a YAML subset: BOM and CRLF accepted, trailing
# comments dropped, metadata.paths and metadata.flags as a flow, block or
comma-separated list, only keys directly under metadata:. A shape outside the
subset reads as not declared.

A package directory, or a SKILL.md or URL name, with no letter or digit is
refused: it has no name to be written under.

Before anything is written, every destination — the package, the registry in
.metaproject/metaproject.json, the catalog and each rule — is checked for a
symlink on the way that resolves outside the project. One is refused, and the
import writes nothing; --dry-run refuses it the same way.

Rules the skills cite (\`<dir>/<name>.mdc\`) are copied from a rules/ directory
beside the source to .metaproject/rules/<dir>/<name>.mdc. When a file already
answers the reference with other content, or keryx ships a core/ rule of that
name, the copy goes to .metaproject/rules/project/<dir>/<name>.mdc, which a
reviewer's reference resolves to first; an existing copy there that differs is
replaced only with --force.

Examples:
  keryx skills import --from ./overlays --module review --only 'review-house-*'
  keryx skills import --from ./overlays/skills/review-house-api --module review
  keryx skills import --from ./skill-supper.md --module quality --name verifier
  keryx skills import --from https://github.com/org/repo/blob/main/skills/verifier/SKILL.md --module quality
`);
}

export function printSkillsUpdateHelp(): void {
  console.log(`keryx skills update

Re-read a project-skill's Origin and overwrite SKILL.md when the source moved on.

Usage:
  keryx skills update <module>/<name> [--from <new-origin>] [--dry-run] [--json]
  keryx skills update --all [--dry-run] [--json]

Before anything is written, every destination is checked for a symlink on the
way that resolves outside the project, as \`keryx skills import\` does. One is
refused and nothing is written; --dry-run refuses it the same way.

Examples:
  keryx skills update review/local-review-skill --from ./skill-supper.md
  keryx skills update --all
`);
}
