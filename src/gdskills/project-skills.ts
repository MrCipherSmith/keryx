import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathExists, toPosix, withFileLock, writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { guardOutput, prepareOutputForPersistence } from "../security/guard";

export type ProjectSkillFormat = "auto" | "single" | "package";

export type CreateProjectSkillOptions = {
  target: string;
  module?: string | undefined;
  name?: string | undefined;
  /**
   * A one-line human gist about WHY this skill exists, kept out of `target`.
   *
   * `target` is a routing key: `keryx skills route` matches queries against it
   * and `verify` resolves it as a path. Prose in that slot yields a skill that
   * matches nothing and verifies as permanently stale, so callers that have a
   * sentence to contribute pass it here instead.
   */
  note?: string | undefined;
  /**
   * Path to an external file this skill was built FROM — a rules file, a
   * profile, an exported convention doc — recorded so the skill can say where
   * it came from and detect that the source has moved on since.
   *
   * The path is stored verbatim (a `~` stays a `~`) because it is a human
   * reference, and hashed from the resolved file so drift is detectable.
   */
  origin?: string | undefined;
  format?: ProjectSkillFormat | undefined;
  dryRun?: boolean | undefined;
};

export type ProjectSkillRegistryEntry = {
  module: string;
  name: string;
  target: string;
  path: string;
  version: string;
  status: "active";
  updatedAt: string;
};

export type CreateProjectSkillResult = {
  module: string;
  name: string;
  target: string;
  skillPath: string;
  files: string[];
  warnings: string[];
  dryRun: boolean;
};

type MetaprojectManifest = {
  modules?: {
    gdskills?: {
      projectSkillRegistry?: ProjectSkillRegistryEntry[];
    };
  };
};

type Evidence = {
  targetExists: boolean;
  targetKind: "file" | "directory" | "symbol-or-concept";
  targetPath?: string | undefined;
  graphArtifacts: string[];
  ctxArtifacts: string[];
  wikiArtifacts: string[];
};

const VERSION = "0.1.0";

export async function createProjectSkill(
  projectRoot: string,
  options: CreateProjectSkillOptions,
): Promise<CreateProjectSkillResult> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run: keryx init");
  }

  const moduleName = slugify(options.module ?? inferModule(options.target));
  const skillName = slugify(options.name ?? inferSkillName(options.target));
  const format = options.format ?? "auto";
  const packageRoot = path.join(metaprojectRoot, "project-skills", moduleName, skillName);
  const relativeSkillPath = toPosix(path.relative(projectRoot, packageRoot));
  const origin = options.origin ? await readSkillOrigin(projectRoot, options.origin) : undefined;
  const evidence = await collectEvidence(projectRoot, options.target);
  const warnings = collectWarnings(evidence, format);
  const files = filesForPackage(packageRoot, format);

  if (!options.dryRun) {
    await withFileLock(path.join(metaprojectRoot, "data", "gdskills", "project-skills.lock"), async () => {
      await writeProjectSkillPackage({
        projectRoot,
        packageRoot,
        moduleName,
        skillName,
        target: options.target,
        note: options.note,
        origin,
        evidence,
        format,
      });

      await updateManifest(projectRoot, {
        module: moduleName,
        name: skillName,
        target: options.target,
        path: relativeSkillPath,
        version: VERSION,
        status: "active",
        updatedAt: new Date().toISOString(),
      });
      await updateSkillsCatalog(projectRoot);
    });
  }

  return {
    module: moduleName,
    name: skillName,
    target: options.target,
    skillPath: relativeSkillPath,
    files: files.map((filePath) => toPosix(path.relative(projectRoot, filePath))),
    warnings,
    dryRun: options.dryRun === true,
  };
}

/**
 * The longest a `target` may be and still be a routing key.
 *
 * `target` is not a description. `keryx skills route` matches queries against
 * it, `verify` resolves it as a path to check the skill is still about
 * something real, and the generated SKILL.md repeats it in four places. A
 * sentence in that slot produces a skill that matches no query, verifies as
 * permanently stale, and reads as noise wherever it is quoted.
 */
export const MAX_SKILL_TARGET_LENGTH = 80;

export type SkillOrigin = {
  /** Verbatim, as the caller wrote it — `~` preserved. */
  ref: string;
  /** `sha256:<hex>` of the source file's bytes at import time. */
  hash: string;
  importedAt: string;
};

/** Expand a leading `~`; anything else is left to `path.resolve`. */
export function resolveOriginPath(ref: string, projectRoot: string): string {
  const trimmed = ref.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(1));
  }
  return path.resolve(projectRoot, trimmed);
}

export function hashOriginContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Read and hash an origin file. Throws when it cannot be read, deliberately:
 * a skill claiming an origin it could not open would record a provenance that
 * was never true, and a wrong provenance is worse than none — it is the thing
 * a later drift check would trust.
 */
export async function readSkillOrigin(
  projectRoot: string,
  ref: string,
  now: () => Date = () => new Date(),
): Promise<SkillOrigin> {
  const resolved = resolveOriginPath(ref, projectRoot);
  let content: string;
  try {
    content = await readFile(resolved, "utf8");
  } catch (cause) {
    throw new Error(
      `Cannot read the origin file ${ref} (resolved to ${resolved}): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return { ref: ref.trim(), hash: hashOriginContent(content), importedAt: now().toISOString() };
}

/**
 * Whether a target can serve as a routing key.
 *
 * Deliberately permissive: a short concept ("auth flow"), a symbol
 * (`IResultDqReport`) and a path (`src/dq/components/DqScoreCard.tsx`) all
 * pass, because `classifyTarget` supports all three. What it rejects is prose —
 * a sentence, a commit message, a wrap-up summary — which is the shape that
 * actually reached this code and put two content-free skills in the registry.
 */
export function isRoutableSkillTarget(target: string): boolean {
  const trimmed = target.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SKILL_TARGET_LENGTH) {
    return false;
  }
  if (/[\n\r]/.test(trimmed)) {
    return false;
  }
  // Sentence punctuation is the tell that separates a target from prose. A path
  // and a symbol carry neither; a summary carries at least one.
  return !/[.!?;:—–]|\s-\s/.test(trimmed.replace(/\.[a-z0-9]+$/i, ""));
}

export function normalizeProjectSkillFormat(value: string | undefined): ProjectSkillFormat {
  if (value === "single" || value === "package" || value === "auto") {
    return value;
  }

  return "auto";
}

async function writeProjectSkillPackage({
  projectRoot,
  packageRoot,
  moduleName,
  skillName,
  target,
  note,
  origin,
  evidence,
  format,
}: {
  projectRoot: string;
  packageRoot: string;
  moduleName: string;
  skillName: string;
  target: string;
  note?: string | undefined;
  origin?: SkillOrigin | undefined;
  evidence: Evidence;
  format: ProjectSkillFormat;
}): Promise<void> {
  const packageFormat = format === "single" ? "single" : "package";
  const skillContent = renderProjectSkill({ moduleName, skillName, target, note, origin, evidence, packageFormat });

  // Security write seam, mirroring `keryx wiki collect`'s guard before publishing
  // a generated page (src/wiki/service.ts) and `keryx memory new`'s
  // writeCanonicalEntry (src/memory/write.ts): SKILL.md is read as agent routing
  // instructions, so its content is scanned BEFORE anything reaches disk. A
  // blocked write refuses outright rather than landing unscanned content that
  // would steer every future agent turn that reads this skill.
  const relativeSkillMdPath = toPosix(path.join(path.relative(projectRoot, packageRoot), "SKILL.md"));
  const guard = await guardOutput({ cwd: projectRoot, content: skillContent, target: "skill", source: "generated", path: relativeSkillMdPath });
  const output = prepareOutputForPersistence(guard, skillContent);
  if (!output.allowed) {
    throw new Error(`Project skill blocked by the security gate: ${output.reason}`);
  }

  await mkdir(packageRoot, { recursive: true });

  const skillPath = path.join(packageRoot, "SKILL.md");
  await writeFileAtomic(skillPath, output.content);

  const changelogPath = path.join(packageRoot, "skill-changelog.md");
  if (!(await pathExists(changelogPath))) {
    await writeFileAtomic(
      changelogPath,
      renderSkillChangelog({ moduleName, skillName, target }),
    );
  }

  if (packageFormat === "package") {
    await mkdir(path.join(packageRoot, "references"), { recursive: true });
    await mkdir(path.join(packageRoot, "templates"), { recursive: true });
    await writeFileAtomic(
      path.join(packageRoot, "references", "context.md"),
      renderReferenceContext({ moduleName, skillName, target, evidence }),
    );
    await writeFileAtomic(
      path.join(packageRoot, "templates", "README.md"),
      renderTemplatesReadme({ moduleName, skillName }),
    );
    await writeFileAtomic(
      path.join(packageRoot, "verification.md"),
      renderVerification({ moduleName, skillName, evidence }),
    );
  }
}

async function collectEvidence(projectRoot: string, target: string): Promise<Evidence> {
  const absoluteTarget = path.resolve(projectRoot, target);
  const targetExists = await pathExists(absoluteTarget);
  const targetKind = await classifyTarget(absoluteTarget, targetExists);
  const maybeRelativeTarget = targetExists ? toPosix(path.relative(projectRoot, absoluteTarget)) : undefined;

  const graphArtifacts = await existingRelativePaths(projectRoot, [
    ".metaproject/data/gdgraph/artifacts/summary.md",
    ".metaproject/data/gdgraph/artifacts/module-map.json",
  ]);
  const ctxArtifacts = await existingRelativePaths(projectRoot, [
    ".metaproject/data/gdctx/artifacts/latest.md",
  ]);
  const wikiArtifacts = await existingRelativePaths(projectRoot, [
    ".metaproject/wiki/index.md",
  ]);

  return {
    targetExists,
    targetKind,
    targetPath: maybeRelativeTarget,
    graphArtifacts,
    ctxArtifacts,
    wikiArtifacts,
  };
}

async function classifyTarget(
  absoluteTarget: string,
  targetExists: boolean,
): Promise<Evidence["targetKind"]> {
  if (!targetExists) {
    return "symbol-or-concept";
  }

  const stats = await stat(absoluteTarget);
  return stats.isDirectory() ? "directory" : "file";
}

async function existingRelativePaths(projectRoot: string, candidates: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(projectRoot, candidate))) {
      existing.push(candidate);
    }
  }

  return existing;
}

function collectWarnings(evidence: Evidence, format: ProjectSkillFormat): string[] {
  const warnings: string[] = [];
  if (!evidence.targetExists) {
    warnings.push("Target was not found as a file or directory; generated skill treats it as a symbol or concept.");
  }
  if (evidence.graphArtifacts.length === 0) {
    warnings.push("No gdgraph artifacts found; run keryx gdgraph build for stronger evidence.");
  }
  if (evidence.ctxArtifacts.length === 0) {
    warnings.push("No gdctx artifact found; run keryx ctx commands when deeper compact context is needed.");
  }
  if (evidence.wikiArtifacts.length === 0) {
    warnings.push("No gdwiki index found; add wiki pages for domain and architecture evidence.");
  }
  if (format === "auto") {
    warnings.push("Format auto selected package format for this first implementation slice.");
  }

  return warnings;
}

function filesForPackage(packageRoot: string, format: ProjectSkillFormat): string[] {
  const base = [
    path.join(packageRoot, "SKILL.md"),
    path.join(packageRoot, "skill-changelog.md"),
  ];
  if (format === "single") {
    return base;
  }

  return [
    ...base,
    path.join(packageRoot, "verification.md"),
    path.join(packageRoot, "references", "context.md"),
    path.join(packageRoot, "templates", "README.md"),
  ];
}

function renderProjectSkill({
  moduleName,
  skillName,
  target,
  note,
  origin,
  evidence,
  packageFormat,
}: {
  moduleName: string;
  skillName: string;
  target: string;
  note?: string | undefined;
  origin?: SkillOrigin | undefined;
  evidence: Evidence;
  packageFormat: "single" | "package";
}): string {
  // The note is prose, so it belongs in prose. It is rendered once, under
  // Purpose, and never interpolated into `target`, the frontmatter description,
  // or the "When To Use" match list — those four are what routing and
  // verification read, and a sentence in any of them makes the skill unmatchable.
  const noteLine = note && note.trim().length > 0 ? `\n\n${note.trim()}` : "";
  // Provenance goes in the metadata header, one `Label: value` per line, the
  // same shape `parseSkillMetadata` (gdskills/verify.ts) already reads. Absent
  // for a skill with no external source — an empty `Origin:` would be a claim
  // that there is one.
  const originLines = origin
    ? `\nOrigin: ${origin.ref}\nOrigin Hash: ${origin.hash}\nImported At: ${origin.importedAt}`
    : "";
  const filesToRead = evidence.targetPath
    ? `- \`${evidence.targetPath}\``
    : "- Resolve target with `keryx gdgraph affected <target>` or compact search before broad reads.";
  const evidenceRefs = [
    ...evidence.graphArtifacts,
    ...evidence.ctxArtifacts,
    ...evidence.wikiArtifacts,
  ];
  const evidenceRows = evidenceRefs.length > 0
    ? evidenceRefs.map((entry) => `- \`${entry}\``).join("\n")
    : "- No generated evidence artifacts were available when this skill was created.";
  const referenceHint = packageFormat === "package"
    ? "\nRead `references/context.md` for the initial evidence snapshot when details are needed."
    : "";

  return `---
name: ${moduleName}-${skillName}
description: Use when working with ${target} in module ${moduleName}; prefer this project-local skill before generic guidance.
---

# ${titleize(skillName)} Skill

Version: ${VERSION}
Target: ${target}
Module: ${moduleName}${originLines}
Status: active
Last Verified: never

## Purpose

Provide project-local guidance for creating, changing, reviewing, and verifying work related to \`${target}\`.${noteLine}${referenceHint}

## When To Use

- The task mentions \`${target}\`, \`${skillName}\`, or module \`${moduleName}\`.
- The task changes nearby files, stores, components, services, tests, or domain rules.
- The agent needs local patterns before applying generic implementation guidance.

## Evidence

<!-- gdskills:generated:start section="evidence" source="target,gdgraph,gdctx,gdwiki" -->
- Target kind: \`${evidence.targetKind}\`
- Target exists: \`${String(evidence.targetExists)}\`
${evidenceRows}
<!-- gdskills:generated:end -->

## Files To Read

<!-- gdskills:generated:start section="files-to-read" source="target" -->
${filesToRead}
<!-- gdskills:generated:end -->

## Architecture Rules

- Preserve the existing module boundaries around \`${moduleName}\`.
- Check graph affected context before changing public exports, shared stores, service APIs, adapters, or templates.
- Keep reusable logic in the established local layer instead of adding cross-module coupling.

## Business Rules

- Read related wiki pages before changing user-visible behavior or domain decisions.
- If wiki coverage is missing, document the discovered rule in gdwiki or Documentation Memory after implementation.

## Implementation Patterns

- Start from existing nearby files and tests.
- Use gdctx for compact reads, command output, diffs, and logs before loading large raw files.
- Keep changes scoped to the target entity and directly affected collaborators.

## Create Workflow

1. Resolve the exact target and related files through gdgraph or compact search.
2. Read this skill and the generated context reference when present.
3. Identify local patterns from neighboring implementation and tests.
4. Ask only for missing product or domain decisions that cannot be inferred.
5. Implement the smallest coherent change and run focused verification.

## Refactor Workflow

1. Build affected context before moving or renaming files.
2. Preserve public contracts unless the task explicitly changes them.
3. Update tests, wiki, memory, and this skill when the pattern changes.

## Questions To Ask

- What behavior or contract changes, if any?
- Should this follow an existing entity pattern or introduce a new one?
- Which tests or scenarios prove the change?

## Testing Rules

- Prefer nearby tests and module-level conventions.
- Cover behavior, edge cases, and regression risks that match the change.
- Record unavailable verification in the final answer.

## Review Checklist

- Target and affected files were found through Metaproject context tools before broad search.
- Local architecture and business rules were checked.
- Tests or explicit verification evidence exist.
- Skill updates are proposed when implementation reveals a reusable pattern or mistake.

## Anti-patterns

- Duplicating module-specific rules into unrelated modules.
- Editing generated or runtime-only artifacts as the canonical source.
- Treating this skill as fresher than source code when verification is stale.

## Review Lessons

- No review lessons recorded yet.

## Verification

- Current state: not verified.
- Run: \`keryx skills verify ${moduleName}/${skillName}\`
`;
}

function renderSkillChangelog({
  moduleName,
  skillName,
  target,
}: {
  moduleName: string;
  skillName: string;
  target: string;
}): string {
  return `# ${titleize(skillName)} Skill Changelog

Version: 0.1.0

## 0.1.0 - ${today()}

- Reason: initial project-skill creation.
- Source: \`keryx skills create\`.
- Module: \`${moduleName}\`.
- Target: \`${target}\`.
- Changed sections: all initial sections.
- Confidence: medium.
- Applied mode: manual.
`;
}

function renderReferenceContext({
  moduleName,
  skillName,
  target,
  evidence,
}: {
  moduleName: string;
  skillName: string;
  target: string;
  evidence: Evidence;
}): string {
  const artifacts = [
    ...evidence.graphArtifacts,
    ...evidence.ctxArtifacts,
    ...evidence.wikiArtifacts,
  ];
  const artifactList = artifacts.length > 0
    ? artifacts.map((entry) => `- \`${entry}\``).join("\n")
    : "- No generated artifacts were available.";

  return `# ${titleize(skillName)} Context

Version: 0.1.0

## Target

- Module: \`${moduleName}\`
- Target: \`${target}\`
- Target kind: \`${evidence.targetKind}\`
- Target exists: \`${String(evidence.targetExists)}\`

## Evidence Sources

${artifactList}

## Notes For Agents

- Treat this file as an initial context snapshot.
- Verify claims against source code before editing.
- Use gdgraph, gdctx, gdwiki, Code Health and Documentation Memory to refresh evidence when needed.
`;
}

function renderTemplatesReadme({
  moduleName,
  skillName,
}: {
  moduleName: string;
  skillName: string;
}): string {
  return `# Templates

Version: 0.1.0

This directory stores reusable templates for project skill \`${moduleName}/${skillName}\`.

Add templates only when a repeated implementation pattern becomes stable enough to reuse.
`;
}

function renderVerification({
  moduleName,
  skillName,
  evidence,
}: {
  moduleName: string;
  skillName: string;
  evidence: Evidence;
}): string {
  return `# ${titleize(skillName)} Verification

Version: 0.1.0

Status: not-verified
Module: ${moduleName}
Skill: ${skillName}
Last Verified: never

## Initial Signals

- Target exists: \`${String(evidence.targetExists)}\`
- Graph artifacts: \`${String(evidence.graphArtifacts.length > 0)}\`
- Context artifacts: \`${String(evidence.ctxArtifacts.length > 0)}\`
- Wiki artifacts: \`${String(evidence.wikiArtifacts.length > 0)}\`

## Next Verification Command

\`\`\`bash
keryx skills verify ${moduleName}/${skillName}
\`\`\`
`;
}

async function updateManifest(
  projectRoot: string,
  entry: ProjectSkillRegistryEntry,
): Promise<void> {
  const manifestPath = path.join(projectRoot, ".metaproject", "metaproject.json");
  const manifest = await readJsonFileOr<MetaprojectManifest>(manifestPath, {});
  manifest.modules ??= {};
  manifest.modules.gdskills ??= {};

  const registry = manifest.modules.gdskills.projectSkillRegistry ?? [];
  const nextRegistry = [
    ...registry.filter((existing) => existing.path !== entry.path),
    entry,
  ].sort((a, b) => `${a.module}/${a.name}`.localeCompare(`${b.module}/${b.name}`));

  manifest.modules.gdskills.projectSkillRegistry = nextRegistry;
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function updateSkillsCatalog(projectRoot: string): Promise<void> {
  const manifestPath = path.join(projectRoot, ".metaproject", "metaproject.json");
  const catalogPath = path.join(projectRoot, ".metaproject", "skills", "catalog.md");
  const manifest = await readJsonFileOr<MetaprojectManifest>(manifestPath, {});
  const registry = manifest.modules?.gdskills?.projectSkillRegistry ?? [];
  const rows = registry.length > 0
    ? registry
        .map((entry) => `| ${entry.module} | ${entry.name} | \`${entry.target}\` | ${entry.path}/SKILL.md |`)
        .join("\n")
    : "| _none_ | _none_ | _none_ | - |";
  const section = `<!-- gdskills:project-skills:start -->
## Project Skills

| Module | Skill | Target | Entry |
|---|---|---|---|
${rows}
<!-- gdskills:project-skills:end -->`;

  const current = (await pathExists(catalogPath))
    ? await readFile(catalogPath, "utf8")
    : "# Metaproject Skills Catalog\n";

  const start = "<!-- gdskills:project-skills:start -->";
  const end = "<!-- gdskills:project-skills:end -->";
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  const next = startIndex >= 0 && endIndex > startIndex
    ? `${current.slice(0, startIndex).trimEnd()}\n\n${section}\n${current.slice(endIndex + end.length).trimStart()}`
    : `${current.trimEnd()}\n\n${section}\n`;

  await writeFileAtomic(catalogPath, next);
}

function inferModule(target: string): string {
  const normalized = toPosix(target).replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] === "src" && parts[1]) {
    return parts[1];
  }

  if (parts[0] && !parts[0].includes(".")) {
    return parts[0];
  }

  return "general";
}

function inferSkillName(target: string): string {
  const normalized = target.trim().replace(/[#:]+/g, "/");
  const base = path.basename(normalized).replace(/\.[^.]+$/, "");
  return base || "entity";
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "entity";
}

function titleize(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
