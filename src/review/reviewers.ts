import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { BUNDLED_GDSKILLS, bundledSkillMarkdownPath, packageRelativePath } from "../gdskills/catalog";
import { hashOriginContent, PROJECT_SKILLS_DIR, resolveOriginPath } from "../gdskills/project-skills";
import {
  familyFlagsByReviewer,
  PROJECT_REVIEWER_MODULE,
  projectReviewersRoot,
  skillPackageNames,
} from "../gdskills/project-reviewers";
import {
  shadowedRuleReferences,
  unresolvedReferences,
  unresolvedRuleReferences,
  type ShadowedRule,
  type UnresolvedReference,
} from "../gdskills/rule-references";
import {
  escapeRegexLiteral,
  metadataList,
  reviewerFlagReport,
  reviewerPathGate,
  type PathTriggerSource,
} from "../gdskills/reviewer-triggers";
import { parseSkillFrontmatter } from "../gdskills/skill-frontmatter";
import { extractStackRequiresField, parseStackRequires, type StackTag } from "./stack";

// The pure text helpers behind the path gate and the flags live in gdskills,
// the lower layer, where the importer reads them too. Re-exported so this
// module stays the place its callers and tests import them from.
export {
  descriptionFlags,
  descriptionPathTriggers,
  escapeRegexLiteral,
  reviewerFlagReport,
  reviewerFlags,
  reviewerPathGate,
  type PathTriggerSource,
  type ReviewerFlagReport,
} from "../gdskills/reviewer-triggers";

/**
 * The reviewer set a review round can actually dispatch.
 *
 * `review-orchestrator`'s routing table names the reviewers keryx ships. It had
 * no way to learn about a reviewer a PROJECT defines — so a team with its own
 * review profile could write it as a project-skill, register it, and watch every
 * review round ignore it. This is the answer to "who can review here", computed
 * rather than listed, in the same shape `keryx review stack --json` already uses
 * for a neighbouring question.
 *
 * The convention is one line long and deliberately matches gdskills: a project
 * reviewer is a project-skill whose module is `review`, so it lands at
 * `.metaproject/project-skills/review/<name>/` beside
 * `.metaproject/skills/gdskills/review/<name>/`. Nothing else marks it. A team
 * that already knows where bundled reviewers live knows where theirs go.
 *
 * The constant, the enumerator and the family-flag rule are owned by
 * `gdskills/project-reviewers.ts`, which `keryx skills import` reads too.
 */
export { PROJECT_REVIEWER_MODULE };

/** Whether the skill's origin file still matches what was imported. */
export type OriginDrift =
  /** No origin recorded — the skill was written here, not imported. */
  | "none"
  /** The origin file hashes to what was recorded. */
  | "clean"
  /** The origin file exists and has changed since import. */
  | "changed"
  /** An origin was recorded and the file can no longer be read. */
  | "missing";

export type BundledReviewer = {
  name: string;
  source: "bundled";
  path: string;
  /**
   * `metadata.engine`, when the reviewer declares one (flow 330/332/333) —
   * e.g. `"jev"` for a reviewer dispatched as a deterministic CLI engine call
   * (`keryx review <name> ...`) rather than an LLM sub-agent. Absent means
   * the default: an LLM sub-agent dispatch, exactly as every reviewer before
   * flow 330/332/333 already worked.
   */
  engine?: string;
  /**
   * Frontmatter routing description (flow 344), folded to one line — the
   * same field a project reviewer already carries. Added so a caller that
   * needs "every candidate reviewer's id and description" (`keryx review
   * jev-select`) reads it from this one inventory rather than re-parsing
   * every bundled `SKILL.md` a second time.
   */
  description?: string;
};

export type ProjectReviewer = {
  name: string;
  source: "project-skill";
  path: string;
  /** Frontmatter description, folded to one line. */
  description?: string;
  /**
   * Path triggers for the orchestrator's path gate. The routing table only
   * knows bundled reviewers' triggers; without these a project reviewer had
   * no triggers to gate on, so it ran on every round whatever the diff.
   */
  paths: string[];
  pathsSource: PathTriggerSource;
  /**
   * Selection flags (`--acme-core`), `--all` excluded: `metadata.flags`
   * when declared, otherwise the flags its description names. Normalised —
   * lower-case, `--` prefixed — so one flag has one spelling across reviewers.
   */
  flags: string[];
  /**
   * What was dropped from `metadata.flags`: one line per entry that is not a
   * flag, and one more when that left the reviewer with none. Always present;
   * empty when there is nothing to say.
   */
  flagWarnings: string[];
  /**
   * The subset of `flags` at least one other project reviewer also carries.
   * A passed flag listed here is a family selector: it selects this reviewer
   * and leaves it path-gated. A passed flag in `flags` and not here is unique
   * to this reviewer: explicit, never path-gated. Always present; empty when
   * nothing is shared.
   */
  familyFlags: string[];
  /** `metadata.stack_requires`, for `keryx review stack`-style scoping. */
  stackRequires: StackTag[];
  /**
   * Rules it cites that resolve to no file — neither
   * `.metaproject/rules/project/<ref>` nor `.metaproject/rules/<ref>`.
   */
  unresolvedRules: string[];
  /**
   * Rules it cites by one path and reads from another: a
   * `.metaproject/rules/project/<ref>` copy answers the reference before the
   * file the text names (`<dir>/<name>.mdc`). `resolved` is project-relative.
   */
  shadowedRules: ShadowedRule[];
  /**
   * Other references that will not hold: a backticked `skills/...` or
   * `rules/...` `.md` / `.json` path absent under `.metaproject/` (`missing`),
   * and a rule cited by an absolute or `~` path (`non-portable`).
   */
  unresolvedReferences: UnresolvedReference[];
  /** Verbatim origin reference, when the skill was imported from a file. */
  origin?: string;
  originHash?: string;
  importedAt?: string;
  drift: OriginDrift;
};

/**
 * Where the `bundled` half of the inventory came from (flow 347 T9).
 *
 * - `project` — read from this project's INSTALLED tree
 *   (`.metaproject/skills/gdskills/review`), exactly as before this field
 *   existed. The directory is present (even if empty — an install profile can
 *   legitimately install zero review skills).
 * - `package` — the project directory is absent, so the keryx PACKAGE's own
 *   bundled review skills were read instead (the same tree `keryx skills
 *   install` copies from). This is the common case in a worktree whose
 *   `.metaproject/` was never fully installed (only `data/`/`reviews/`
 *   exist).
 * - `not-found` — neither the project directory nor the package's bundled
 *   review skills could be located. `bundled` is empty here, and that empty
 *   list means "nothing found", not "nothing installed" — callers must check
 *   this field rather than infer from an empty array.
 */
export type BundledReviewerSource = "project" | "package" | "not-found";

export type ReviewerInventory = {
  bundled: BundledReviewer[];
  /** See `BundledReviewerSource`. */
  bundledSource: BundledReviewerSource;
  project: ProjectReviewer[];
};

/**
 * Read one `Label: value` line out of a skill's metadata header.
 *
 * Same shape `gdskills/verify.ts` reads, deliberately duplicated rather than
 * shared: that one parses a different set of labels for a different purpose,
 * and coupling them would make either one's field list the other's problem.
 */
function metadataLine(content: string, label: string): string | undefined {
  const match = content.match(new RegExp(`^${escapeRegexLiteral(label)}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

async function driftFor(
  projectRoot: string,
  origin: string | undefined,
  recordedHash: string | undefined,
): Promise<OriginDrift> {
  if (!origin || !recordedHash) {
    return "none";
  }
  // A remote Origin is re-checked by `keryx skills update`, not by listing.
  // `review reviewers` must not open a socket.
  if (/^https:\/\//i.test(origin)) {
    return "clean";
  }
  try {
    const content = await readFile(resolveOriginPath(origin, projectRoot), "utf8");
    return hashOriginContent(content) === recordedHash ? "clean" : "changed";
  } catch {
    return "missing";
  }
}

/** Whether `readdir(dir)` succeeds at all — present-but-empty counts as present. */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

/** One installed-tree bundled reviewer entry, shared by both provenance paths below. */
async function bundledReviewerFromFile(
  name: string,
  skillMdPath: string,
  projectRelativePath: string,
): Promise<BundledReviewer> {
  // `metadata.engine` (flow 330/332/333): read best-effort — a reviewer with no
  // engine declared, or a SKILL.md that vanished between the directory
  // listing above and this read, is a plain LLM sub-agent reviewer.
  const content = await readFile(skillMdPath, "utf8").catch(() => undefined);
  const engine = content !== undefined ? metadataList(content, "engine")[0] : undefined;
  const description = content !== undefined ? parseSkillFrontmatter(content).description : undefined;
  return {
    name,
    source: "bundled" as const,
    path: projectRelativePath,
    ...(engine !== undefined ? { engine } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * Bundled reviewers read from THIS PROJECT's installed tree
 * (`.metaproject/skills/gdskills/review`) — what a round can actually
 * dispatch, which is a different set from the shipped source whenever the
 * install profile is not `full`.
 */
async function projectInstalledReviewers(bundledRoot: string): Promise<BundledReviewer[]> {
  return Promise.all(
    (await skillPackageNames(bundledRoot)).map((name) =>
      bundledReviewerFromFile(
        name,
        path.join(bundledRoot, name, "SKILL.md"),
        path.posix.join(".metaproject", "skills", "gdskills", "review", name),
      ),
    ),
  );
}

/**
 * Injectable half of `collectReviewers` (flow 347 T15 / F-004).
 *
 * Real callers never pass this: `collectReviewers` defaults it to the real
 * `bundledSkillMarkdownPath`, so behaviour is unchanged. Tests that need to
 * force `bundledSource: "not-found"` — the fail-closed exit `runReviewers`
 * signals with `process.exitCode = 1` — inject a lookup that always returns
 * `undefined` instead, without deleting real files out of the keryx package
 * under test.
 */
export type CollectReviewersDeps = {
  bundledSkillMarkdownPath?: (category: string, name: string) => string | undefined;
};

/**
 * Bundled reviewers read from the keryx PACKAGE's own bundled skills — the
 * fallback for a project whose `.metaproject/skills/gdskills/review` was
 * never installed (e.g. a review worktree carrying only `data/`/`reviews/`).
 * Reuses `bundledSkillMarkdownPath`, the same source/packaged two-candidate
 * resolver `catalog.ts` already uses for this exact tree — no new path
 * scheme. (`install.ts` does not share this resolver: it renders a bundled
 * skill's SKILL.md from its `BundledSkill` entry rather than reading a file.)
 */
async function packageBundledReviewers(deps: CollectReviewersDeps = {}): Promise<BundledReviewer[]> {
  const lookup = deps.bundledSkillMarkdownPath ?? bundledSkillMarkdownPath;
  const names = BUNDLED_GDSKILLS.filter((entry) => entry.category === "review")
    .map((entry) => entry.name)
    .sort();
  const found: BundledReviewer[] = [];
  for (const name of names) {
    const file = lookup("review", name);
    if (file === undefined) continue;
    found.push(await bundledReviewerFromFile(name, file, packageRelativePath(path.dirname(file))));
  }
  return found;
}

/**
 * Both halves of the reviewer set, with provenance for each.
 *
 * The `bundled` half's source (`bundledSource`) is `project` when this
 * project's installed tree is present (even empty), `package` when it is
 * absent and the keryx package's own bundled review skills were used
 * instead, and `not-found` when neither exists — see `BundledReviewerSource`.
 */
export async function collectReviewers(projectRoot: string, deps: CollectReviewersDeps = {}): Promise<ReviewerInventory> {
  const bundledRoot = path.join(projectRoot, ".metaproject", "skills", "gdskills", "review");
  let bundled: BundledReviewer[];
  let bundledSource: BundledReviewerSource;
  if (await directoryExists(bundledRoot)) {
    bundled = await projectInstalledReviewers(bundledRoot);
    bundledSource = "project";
  } else {
    bundled = await packageBundledReviewers(deps);
    bundledSource = bundled.length > 0 ? "package" : "not-found";
  }

  const projectRoot_ = projectReviewersRoot(projectRoot);
  const project: ProjectReviewer[] = [];
  for (const name of await skillPackageNames(projectRoot_)) {
    const relative = path.posix.join(PROJECT_SKILLS_DIR, PROJECT_REVIEWER_MODULE, name);
    const content = await readFile(path.join(projectRoot_, name, "SKILL.md"), "utf8");
    const origin = metadataLine(content, "Origin");
    const originHash = metadataLine(content, "Origin Hash");
    const importedAt = metadataLine(content, "Imported At");
    const description = parseSkillFrontmatter(content).description;
    const flagReport = reviewerFlagReport(content);
    project.push({
      name,
      source: "project-skill",
      path: relative,
      ...(description ? { description } : {}),
      ...reviewerPathGate(content),
      flags: flagReport.flags,
      flagWarnings: flagReport.warnings,
      // Filled in below, once every project reviewer's flags are known.
      familyFlags: [],
      stackRequires: parseStackRequires(extractStackRequiresField(content)),
      unresolvedRules: await unresolvedRuleReferences(projectRoot, content),
      shadowedRules: await shadowedRuleReferences(projectRoot, content),
      unresolvedReferences: await unresolvedReferences(projectRoot, content),
      ...(origin ? { origin } : {}),
      ...(originHash ? { originHash } : {}),
      ...(importedAt ? { importedAt } : {}),
      drift: await driftFor(projectRoot, origin, originHash),
    });
  }

  const family = familyFlagsByReviewer(new Map(project.map((reviewer) => [reviewer.name, reviewer.flags])));
  for (const reviewer of project) {
    reviewer.familyFlags = family.get(reviewer.name) ?? [];
  }

  return { bundled, bundledSource, project };
}

/** Human text for `bundledSource`, shown in both markdown and, via the JSON field, `--json`. */
function bundledSourceNote(source: BundledReviewerSource): string {
  switch (source) {
    case "project":
      return "this project's installed reviewers (.metaproject/skills/gdskills/review)";
    case "package":
      return "keryx's bundled reviewers — .metaproject/skills/gdskills/review is absent in this " +
        "project, so the package's own review skills were used instead";
    case "not-found":
      return "not found — no .metaproject/skills/gdskills/review directory in this project, and " +
        "the keryx package's bundled review skills could not be located either";
  }
}

export function renderReviewerInventoryMarkdown(inventory: ReviewerInventory): string {
  const lines = [
    "# reviewers",
    "",
    `bundled: ${inventory.bundled.length} (source: ${inventory.bundledSource})`,
    `  ${bundledSourceNote(inventory.bundledSource)}`,
    `project-local: ${inventory.project.length}`,
    "",
    "## bundled",
    "",
    ...(inventory.bundled.length > 0
      ? inventory.bundled.map((reviewer) => `- ${reviewer.name}${reviewer.engine !== undefined ? ` (engine: ${reviewer.engine})` : ""}`)
      : inventory.bundledSource === "not-found"
        ? ["- not-found — see note above"]
        : ["- none installed"]),
    "",
    "## project-local",
    "",
  ];

  if (inventory.project.length === 0) {
    lines.push(
      "- none",
      "",
      `Create one with: keryx skills create <target> --module ${PROJECT_REVIEWER_MODULE} --name <reviewer> [--origin <file>]`,
    );
    return `${lines.join("\n")}\n`;
  }

  for (const reviewer of inventory.project) {
    const provenance =
      reviewer.drift === "none"
        ? "no recorded origin"
        : `${reviewer.origin ?? "?"} — ${reviewer.drift}`;
    lines.push(`- ${reviewer.name} (${provenance})`);
    lines.push(
      `  - paths: ${reviewer.paths.length > 0 ? reviewer.paths.join(", ") : "none — dispatched on every round"} [${reviewer.pathsSource}]`,
    );
    if (reviewer.flags.length > 0) {
      lines.push(`  - flags: ${reviewer.flags.join(", ")}`);
    }
    if (reviewer.familyFlags.length > 0) {
      lines.push(
        `  - family flags: ${reviewer.familyFlags.join(", ")} — shared with another project reviewer: selects it, stays path-gated`,
      );
    }
    for (const warning of reviewer.flagWarnings) {
      lines.push(`  - warning: ${warning}`);
    }
  }

  const unresolved = inventory.project.filter((reviewer) => reviewer.unresolvedRules.length > 0);
  if (unresolved.length > 0) {
    lines.push("", "## rules cited but not in .metaproject/rules", "");
    for (const reviewer of unresolved) {
      lines.push(`- ${reviewer.name}: ${reviewer.unresolvedRules.join(", ")}`);
    }
    lines.push(
      "",
      "The reviewer names these as its standard and the project does not have them. Re-run",
      "`keryx review import --from <overlay> --only '<glob>'` (a tree import needs --only) to copy",
      "them from the overlay, or add them by hand.",
    );
  }

  const shadowed = inventory.project.filter((reviewer) => reviewer.shadowedRules.length > 0);
  if (shadowed.length > 0) {
    lines.push("", "## rules read from .metaproject/rules/project", "");
    for (const reviewer of shadowed) {
      for (const rule of reviewer.shadowedRules) {
        lines.push(`- ${reviewer.name}: \`${rule.ref}\` → ${rule.resolved}`);
      }
    }
    lines.push(
      "",
      "The reviewer's text names the path on the left; the file it must read is the one on the",
      "right. `.metaproject/rules/project/<dir>/<name>.mdc` is resolved before `.metaproject/rules/<dir>/<name>.mdc`:",
      "`keryx init`, `keryx update` and `keryx skills install` overwrite rules/core with keryx's own rules",
      "(the manifest form of `skills install` skips existing files it did not record)",
      "and leave rules/project alone, so a rule an overlay provides under a name keryx also ships is kept",
      "in rules/project.",
    );
  }

  const dangling = inventory.project.filter((reviewer) => reviewer.unresolvedReferences.length > 0);
  if (dangling.length > 0) {
    lines.push("", "## references that do not resolve", "");
    for (const reviewer of dangling) {
      for (const reference of reviewer.unresolvedReferences) {
        lines.push(
          reference.reason === "missing"
            ? `- ${reviewer.name}: \`${reference.ref}\` — missing (.metaproject/${reference.ref})`
            : `- ${reviewer.name}: \`${reference.ref}\` — non-portable`,
        );
      }
    }
    lines.push(
      "",
      "missing: the reviewer points at a file the import did not bring — it copies SKILL.md and the",
      "rules it cites, nothing else. Copy the file to the path shown, or edit the reference out.",
      "non-portable: a rule cited by an absolute or ~ path exists on one machine at most. Cite it as",
      "`core/<name>.mdc` and keep the file under .metaproject/rules/.",
    );
  }

  const changed = inventory.project.filter((reviewer) => reviewer.drift === "changed");
  const missing = inventory.project.filter((reviewer) => reviewer.drift === "missing");
  if (changed.length > 0 || missing.length > 0) {
    lines.push("", "## origins that moved on", "");
    for (const reviewer of changed) {
      lines.push(`- ${reviewer.name}: \`${reviewer.origin}\` changed since ${reviewer.importedAt ?? "import"}`);
    }
    for (const reviewer of missing) {
      lines.push(`- ${reviewer.name}: \`${reviewer.origin}\` can no longer be read`);
    }
    lines.push(
      "",
      "A changed origin does not make the reviewer wrong — it makes it a reviewer built from an",
      "older version of its source. Re-read the source and update the skill, or record that the",
      "difference is deliberate.",
    );
  }

  return `${lines.join("\n")}\n`;
}
