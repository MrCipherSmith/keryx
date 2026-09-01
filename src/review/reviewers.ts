import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { hashOriginContent, resolveOriginPath } from "../gdskills/project-skills";

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
 */
export const PROJECT_REVIEWER_MODULE = "review";

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
};

export type ProjectReviewer = {
  name: string;
  source: "project-skill";
  path: string;
  /** Verbatim origin reference, when the skill was imported from a file. */
  origin?: string;
  originHash?: string;
  importedAt?: string;
  drift: OriginDrift;
};

export type ReviewerInventory = {
  bundled: BundledReviewer[];
  project: ProjectReviewer[];
};

/**
 * Read one `Label: value` line out of a skill's metadata header.
 *
 * Same shape `gdskills/verify.ts` reads, deliberately duplicated rather than
 * shared: that one parses a different set of labels for a different purpose,
 * and coupling them would make either one's field list the other's problem.
 */
/**
 * Escape a literal so it can be embedded in a regex source.
 *
 * Extracted and exported for one reason: the version inlined here was broken and
 * nothing could tell. The class was written `[.*+?^${}()|[\\]\\\\]`, which closes
 * at the FIRST `]` — so the pattern became "one metacharacter, then two
 * backslashes, then a bracket", matching essentially nothing. The escape was a
 * complete no-op rather than a partial one.
 *
 * It never misbehaved because all three call-site labels ("Origin", "Origin
 * Hash", "Imported At") contain no metacharacters, so escaping them is identity
 * either way. That is exactly why it needed lifting out: through the public
 * surface, fixed and broken are indistinguishable, and a fix nothing can observe
 * is a fix that silently rots. Here it is directly testable.
 */
export function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function metadataLine(content: string, label: string): string | undefined {
  const match = content.match(new RegExp(`^${escapeRegexLiteral(label)}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

/**
 * Directories under `root` that hold a `SKILL.md`.
 *
 * Never throws. A missing root is an empty list, not a failure: a project with
 * no project-skills is the common case, and a review round must not die because
 * the optional half of its reviewer set is absent.
 */
async function skillDirs(root: string): Promise<string[]> {
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
      // A directory without a SKILL.md is not a skill. Skipped silently: this is
      // the shape a half-written package has, and listing it as a reviewer would
      // dispatch an agent at a file that does not exist.
    }
  }
  return names.sort();
}

async function driftFor(
  projectRoot: string,
  origin: string | undefined,
  recordedHash: string | undefined,
): Promise<OriginDrift> {
  if (!origin || !recordedHash) {
    return "none";
  }
  try {
    const content = await readFile(resolveOriginPath(origin, projectRoot), "utf8");
    return hashOriginContent(content) === recordedHash ? "clean" : "changed";
  } catch {
    return "missing";
  }
}

/**
 * Both halves of the reviewer set, with provenance for the project half.
 *
 * Bundled reviewers are read from the INSTALLED tree, not from the shipped
 * source: what a round can dispatch is what `keryx skills install` put in this
 * project, which is a different set whenever the profile is not `full`.
 */
export async function collectReviewers(projectRoot: string): Promise<ReviewerInventory> {
  const bundledRoot = path.join(projectRoot, ".metaproject", "skills", "gdskills", "review");
  const bundled: BundledReviewer[] = (await skillDirs(bundledRoot)).map((name) => ({
    name,
    source: "bundled",
    path: path.posix.join(".metaproject", "skills", "gdskills", "review", name),
  }));

  const projectRoot_ = path.join(projectRoot, ".metaproject", "project-skills", PROJECT_REVIEWER_MODULE);
  const project: ProjectReviewer[] = [];
  for (const name of await skillDirs(projectRoot_)) {
    const relative = path.posix.join(".metaproject", "project-skills", PROJECT_REVIEWER_MODULE, name);
    const content = await readFile(path.join(projectRoot_, name, "SKILL.md"), "utf8");
    const origin = metadataLine(content, "Origin");
    const originHash = metadataLine(content, "Origin Hash");
    const importedAt = metadataLine(content, "Imported At");
    project.push({
      name,
      source: "project-skill",
      path: relative,
      ...(origin ? { origin } : {}),
      ...(originHash ? { originHash } : {}),
      ...(importedAt ? { importedAt } : {}),
      drift: await driftFor(projectRoot, origin, originHash),
    });
  }

  return { bundled, project };
}

export function renderReviewerInventoryMarkdown(inventory: ReviewerInventory): string {
  const lines = [
    "# reviewers",
    "",
    `bundled: ${inventory.bundled.length}`,
    `project-local: ${inventory.project.length}`,
    "",
    "## bundled",
    "",
    ...(inventory.bundled.length > 0
      ? inventory.bundled.map((reviewer) => `- ${reviewer.name}`)
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
