import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { hashOriginContent, resolveOriginPath } from "../gdskills/project-skills";
import { unresolvedRuleReferences } from "../gdskills/rule-references";
import { parseSkillFrontmatter } from "../gdskills/skill-frontmatter";
import { extractStackRequiresField, parseStackRequires, type StackTag } from "./stack";

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
  /**
   * `metadata.engine`, when the reviewer declares one (flow 330/332) — e.g.
   * `"jev"` for a reviewer dispatched as a deterministic CLI engine call
   * (`keryx review <name> ...`) rather than an LLM sub-agent. Absent means
   * the default: an LLM sub-agent dispatch, exactly as every reviewer before
   * flow 330/332 already worked.
   */
  engine?: string;
};

/**
 * Where a project reviewer's path triggers came from.
 *
 * - `metadata` — `metadata.paths` in its frontmatter, a comma-separated glob list.
 * - `description` — globs found in its description (`src/core/**`).
 * - `none` — neither; the path gate has nothing to match, so it dispatches.
 */
export type PathTriggerSource = "metadata" | "description" | "none";

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
  /** Selection flags its description names (`--vantage-core`), `--all` excluded. */
  flags: string[];
  /** `metadata.stack_requires`, for `keryx review stack`-style scoping. */
  stackRequires: StackTag[];
  /** Rules it cites that `.metaproject/rules/` does not have. */
  unresolvedRules: string[];
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

/** Split a comma-separated frontmatter scalar into trimmed, unquoted entries. */
function metadataList(content: string, key: string): string[] {
  if (!content.startsWith("---")) return [];
  const end = content.indexOf("\n---", 3);
  if (end === -1) return [];
  let inMetadata = false;
  for (const line of content.slice(3, end).split("\n")) {
    const top = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (top) {
      inMetadata = top[1] === "metadata";
      continue;
    }
    if (!inMetadata) continue;
    const field = new RegExp(`^\\s+${escapeRegexLiteral(key)}:\\s*(.+)$`).exec(line);
    if (field?.[1]) {
      return field[1]
        .trim()
        .replace(/^["'[]|["'\]]$/g, "")
        .split(",")
        .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }
  return [];
}

/**
 * Globs a description names as its trigger — any token with a `*` that looks
 * like a path. `*.ts(x)` expands to both spellings. Prose without a glob
 * (`date/temporal utils`) yields nothing, deliberately: a guessed trigger that
 * matches nothing would gate a reviewer off a diff it was written for.
 */
export function descriptionPathTriggers(description: string): string[] {
  const globs = new Set<string>();
  for (const raw of description.split(/\s+/)) {
    const token = raw.replace(/^[("'`]+/, "").replace(/[,.;:"'`]+$/, "");
    if (!token.includes("*") || !(token.includes("/") || token.startsWith("*."))) continue;
    const optional = /^(.*)\(([a-z0-9]+)\)$/i.exec(token);
    if (optional?.[1] && optional[2]) {
      globs.add(optional[1]);
      globs.add(`${optional[1]}${optional[2]}`);
    } else {
      globs.add(token.replace(/\)+$/, ""));
    }
  }
  return [...globs];
}

export function descriptionFlags(description: string): string[] {
  const flags = new Set<string>();
  for (const match of description.matchAll(/(?:^|[\s(,])(--[a-z][a-z0-9-]*)/g)) {
    if (match[1] && match[1] !== "--all") flags.add(match[1]);
  }
  return [...flags];
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

/**
 * Both halves of the reviewer set, with provenance for the project half.
 *
 * Bundled reviewers are read from the INSTALLED tree, not from the shipped
 * source: what a round can dispatch is what `keryx skills install` put in this
 * project, which is a different set whenever the profile is not `full`.
 */
export async function collectReviewers(projectRoot: string): Promise<ReviewerInventory> {
  const bundledRoot = path.join(projectRoot, ".metaproject", "skills", "gdskills", "review");
  const bundled: BundledReviewer[] = await Promise.all(
    (await skillDirs(bundledRoot)).map(async (name) => {
      // `metadata.engine` (flow 330/332): read best-effort — a reviewer with no
      // engine declared, or a SKILL.md that vanished between the directory
      // listing above and this read, is a plain LLM sub-agent reviewer.
      const engine = await readFile(path.join(bundledRoot, name, "SKILL.md"), "utf8")
        .then((content) => metadataList(content, "engine")[0])
        .catch(() => undefined);
      return {
        name,
        source: "bundled" as const,
        path: path.posix.join(".metaproject", "skills", "gdskills", "review", name),
        ...(engine !== undefined ? { engine } : {}),
      };
    }),
  );

  const projectRoot_ = path.join(projectRoot, ".metaproject", "project-skills", PROJECT_REVIEWER_MODULE);
  const project: ProjectReviewer[] = [];
  for (const name of await skillDirs(projectRoot_)) {
    const relative = path.posix.join(".metaproject", "project-skills", PROJECT_REVIEWER_MODULE, name);
    const content = await readFile(path.join(projectRoot_, name, "SKILL.md"), "utf8");
    const origin = metadataLine(content, "Origin");
    const originHash = metadataLine(content, "Origin Hash");
    const importedAt = metadataLine(content, "Imported At");
    const description = parseSkillFrontmatter(content).description;
    const declaredPaths = metadataList(content, "paths");
    const describedPaths = description ? descriptionPathTriggers(description) : [];
    const pathsSource: PathTriggerSource =
      declaredPaths.length > 0 ? "metadata" : describedPaths.length > 0 ? "description" : "none";
    project.push({
      name,
      source: "project-skill",
      path: relative,
      ...(description ? { description } : {}),
      paths: pathsSource === "metadata" ? declaredPaths : describedPaths,
      pathsSource,
      flags: description ? descriptionFlags(description) : [],
      stackRequires: parseStackRequires(extractStackRequiresField(content)),
      unresolvedRules: await unresolvedRuleReferences(projectRoot, content),
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
      ? inventory.bundled.map((reviewer) => `- ${reviewer.name}${reviewer.engine !== undefined ? ` (engine: ${reviewer.engine})` : ""}`)
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
      "`keryx review import --from <overlay>` to copy them from the overlay, or add them by hand.",
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
