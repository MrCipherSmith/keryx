import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { ProjectSkillRegistryEntry } from "./project-skills";

export type LearningSourceType = "review" | "test" | "failure" | "health" | "memory";

export type LearnProjectSkillOptions = {
  sourceType: LearningSourceType;
  sourcePath: string;
  skill?: string | undefined;
  dryRun?: boolean | undefined;
};

export type LearningProposal = {
  schemaVersion: 1;
  proposalId: string;
  sourceType: LearningSourceType;
  sourcePath: string;
  skill: {
    module: string;
    name: string;
    path: string;
    target: string;
  };
  confidence: "low" | "medium" | "high";
  lessons: string[];
  suggestedSections: string[];
  proposalPath: string;
  createdAt: string;
  dryRun: boolean;
};

export type ApplyLearningProposalResult = {
  proposalId: string;
  skillPath: string;
  previousVersion: string;
  nextVersion: string;
  changedSections: string[];
  appliedReportPath: string;
  dryRun: boolean;
};

type MetaprojectManifest = {
  modules?: {
    gdskills?: {
      projectSkillRegistry?: ProjectSkillRegistryEntry[];
    };
  };
};

export async function learnProjectSkill(
  projectRoot: string,
  options: LearnProjectSkillOptions,
): Promise<LearningProposal> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run: gd-metapro init");
  }

  const absoluteSourcePath = path.resolve(projectRoot, options.sourcePath);
  if (!(await pathExists(absoluteSourcePath))) {
    throw new Error(`Learning source not found: ${options.sourcePath}`);
  }

  const manifest = await readManifest(projectRoot);
  const registry = manifest.modules?.gdskills?.projectSkillRegistry ?? [];
  if (registry.length === 0) {
    throw new Error("No project skills registered. Run: gd-metapro skills create <target> first.");
  }

  const source = await readFile(absoluteSourcePath, "utf8");
  const effectiveSkill =
    options.skill ??
    (options.sourceType === "health"
      ? dominantHealthSkill(source, registry)
      : undefined);
  const skill = resolveSkillForLearning({
    registry,
    explicitSkill: effectiveSkill,
    source,
    sourcePath: options.sourcePath,
  });
  if (!skill) {
    throw new Error("Unable to map learning source to a project skill. Pass --skill <module>/<skill>.");
  }

  const skillKey = `${skill.module}/${skill.name}`;
  const lessons =
    options.sourceType === "health"
      ? healthLessonsForSkill(source, skillKey)
      : extractLessons(source, options.sourceType);
  const createdAt = new Date().toISOString();
  const proposalId = `${skill.module}-${skill.name}-${options.sourceType}-${createdAt.replace(/[^0-9a-z]/gi, "").slice(0, 18)}`;
  const proposalRoot = path.join(metaprojectRoot, "data", "gdskills", "proposals");
  const proposalJsonPath = path.join(proposalRoot, `${proposalId}.json`);
  const relativeProposalPath = toPosix(path.relative(projectRoot, proposalJsonPath));
  const proposal: LearningProposal = {
    schemaVersion: 1,
    proposalId,
    sourceType: options.sourceType,
    sourcePath: toPosix(path.relative(projectRoot, absoluteSourcePath)),
    skill: {
      module: skill.module,
      name: skill.name,
      path: skill.path,
      target: skill.target,
    },
    confidence: confidenceFor({ explicitSkill: Boolean(options.skill), lessons }),
    lessons,
    suggestedSections: suggestedSectionsFor(options.sourceType),
    proposalPath: relativeProposalPath,
    createdAt,
    dryRun: options.dryRun === true,
  };

  if (!options.dryRun) {
    await mkdir(proposalRoot, { recursive: true });
    await writeFile(proposalJsonPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    await writeFile(path.join(proposalRoot, `${proposalId}.md`), renderProposalMarkdown(proposal), "utf8");
  }

  return proposal;
}

export async function applyLearningProposal(
  projectRoot: string,
  proposalPath: string,
  options: { dryRun?: boolean } = {},
): Promise<ApplyLearningProposalResult> {
  const absoluteProposalPath = path.resolve(projectRoot, proposalPath);
  if (!(await pathExists(absoluteProposalPath))) {
    throw new Error(`Learning proposal not found: ${proposalPath}`);
  }

  const proposal = JSON.parse(await readFile(absoluteProposalPath, "utf8")) as LearningProposal;
  const skillRoot = path.resolve(projectRoot, proposal.skill.path);
  const skillMdPath = path.join(skillRoot, "SKILL.md");
  const changelogPath = path.join(skillRoot, "skill-changelog.md");
  if (!(await pathExists(skillMdPath))) {
    throw new Error(`Project skill SKILL.md not found: ${proposal.skill.path}`);
  }
  if (!(await pathExists(changelogPath))) {
    throw new Error(`Project skill changelog not found: ${proposal.skill.path}/skill-changelog.md`);
  }

  const skillMd = await readFile(skillMdPath, "utf8");
  const previousVersion = readVersion(skillMd) ?? "0.1.0";
  const nextVersion = bumpPatchVersion(previousVersion);
  const changedSections = sectionsToApply(proposal);
  const nextSkillMd = applyLessonsToSkill(skillMd, proposal, nextVersion, changedSections);
  const changelog = await readFile(changelogPath, "utf8");
  const nextChangelog = appendChangelogEntry(changelog, proposal, nextVersion, changedSections);
  const appliedReportPath = path.join(
    projectRoot,
    ".metaproject",
    "data",
    "gdskills",
    "proposals",
    `${proposal.proposalId}.applied.json`,
  );
  if (await pathExists(appliedReportPath)) {
    throw new Error(`Learning proposal is already applied: ${proposal.proposalId}`);
  }

  const result: ApplyLearningProposalResult = {
    proposalId: proposal.proposalId,
    skillPath: proposal.skill.path,
    previousVersion,
    nextVersion,
    changedSections,
    appliedReportPath: toPosix(path.relative(projectRoot, appliedReportPath)),
    dryRun: options.dryRun === true,
  };

  if (!options.dryRun) {
    await writeFile(skillMdPath, nextSkillMd, "utf8");
    await writeFile(changelogPath, nextChangelog, "utf8");
    await mkdir(path.dirname(appliedReportPath), { recursive: true });
    await writeFile(appliedReportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  return result;
}

async function readManifest(projectRoot: string): Promise<MetaprojectManifest> {
  const manifestPath = path.join(projectRoot, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return {};
  }

  return JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
}

function resolveSkillForLearning({
  registry,
  explicitSkill,
  source,
  sourcePath,
}: {
  registry: ProjectSkillRegistryEntry[];
  explicitSkill?: string | undefined;
  source: string;
  sourcePath: string;
}): ProjectSkillRegistryEntry | undefined {
  if (explicitSkill) {
    const normalized = explicitSkill.replace(/\/SKILL\.md$/i, "");
    const matched = registry.find((entry) => {
      const key = `${entry.module}/${entry.name}`;
      return (
        key === normalized ||
        entry.name === normalized ||
        entry.path === normalized ||
        entry.path.replace(/\/SKILL\.md$/i, "") === normalized
      );
    });
    if (matched) {
      return matched;
    }
  }

  const haystack = `${sourcePath}\n${source}`;
  const matchedByTarget = registry.find((entry) =>
    haystack.includes(entry.target) ||
    haystack.includes(entry.path) ||
    haystack.includes(`${entry.module}/${entry.name}`) ||
    haystack.includes(path.basename(entry.target)),
  );
  if (matchedByTarget) {
    return matchedByTarget;
  }

  if (registry.length === 1) {
    return registry[0];
  }

  return undefined;
}

type HealthFinding = {
  message?: string;
  suggestedAction?: string | null;
  scope?: { skill?: string | null };
};

function parseHealthFindings(source: string): HealthFinding[] {
  try {
    const parsed = JSON.parse(source) as { findings?: HealthFinding[] };
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    return [];
  }
}

// Pick the project-skill with the most Code Health findings, restricted to
// skills that exist in the registry. Lets `learn --from-health` resolve the
// target skill without an explicit `--skill`.
function dominantHealthSkill(
  source: string,
  registry: ProjectSkillRegistryEntry[],
): string | undefined {
  const keys = new Set(registry.map((entry) => `${entry.module}/${entry.name}`));
  const counts = new Map<string, number>();
  for (const finding of parseHealthFindings(source)) {
    const skill = finding.scope?.skill;
    if (skill && keys.has(skill)) {
      counts.set(skill, (counts.get(skill) ?? 0) + 1);
    }
  }
  let best: { skill: string; count: number } | undefined;
  for (const [skill, count] of counts) {
    if (!best || count > best.count) {
      best = { skill, count };
    }
  }
  return best?.skill;
}

// Lessons from a Code Health report, scoped to one skill. When the report tags
// findings with `scope.skill`, only that skill's findings are used; an untagged
// report falls back to all findings, then to generic keyword extraction.
function healthLessonsForSkill(source: string, skillKey: string): string[] {
  const findings = parseHealthFindings(source);
  const anyTagged = findings.some((finding) => Boolean(finding.scope?.skill));
  const pool = anyTagged
    ? findings.filter((finding) => finding.scope?.skill === skillKey)
    : findings;
  const lessons = pool
    .flatMap((finding) => [finding.message, finding.suggestedAction ?? undefined])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length >= 12 && value.length <= 260,
    );
  const deduped = unique(lessons).slice(0, 10);
  return deduped.length > 0 ? deduped : extractLessons(source, "health");
}

function extractLessons(source: string, sourceType: LearningSourceType): string[] {
  const jsonLessons = extractJsonLessons(source);
  if (jsonLessons.length > 0) {
    return jsonLessons.slice(0, 10);
  }

  const keywords = keywordsFor(sourceType);
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\s>]+/, "").trim())
    .filter((line) => line.length >= 12 && line.length <= 260)
    .filter((line) => !/^(review report|test report|health report|memory report|summary|findings)$/i.test(line))
    .filter((line) => !line.startsWith("```"));

  const keywordMatches = lines.filter((line) =>
    keywords.some((keyword) => line.toLowerCase().includes(keyword)),
  );
  const selected = keywordMatches.length > 0 ? keywordMatches : lines;
  return unique(selected).slice(0, 10);
}

function extractJsonLessons(source: string): string[] {
  try {
    const parsed = JSON.parse(source) as unknown;
    return unique(collectJsonStrings(parsed).filter((item) => item.length >= 12 && item.length <= 260));
  } catch {
    return [];
  }
}

function collectJsonStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectJsonStrings);
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const preferred = [
      record.message,
      record.summary,
      record.recommendation,
      record.lesson,
      record.error,
      record.title,
    ].flatMap(collectJsonStrings);
    return [
      ...preferred,
      ...Object.entries(record)
        .filter(([key]) => !["message", "summary", "recommendation", "lesson", "error", "title"].includes(key))
        .flatMap(([, nested]) => collectJsonStrings(nested)),
    ];
  }

  return [];
}

function keywordsFor(sourceType: LearningSourceType): string[] {
  const common = ["should", "must", "avoid", "missing", "failed", "error", "bug", "regression", "because"];
  if (sourceType === "review") {
    return [...common, "review", "finding", "risk", "fix"];
  }
  if (sourceType === "health") {
    return [...common, "complexity", "coverage", "lint", "typescript", "audit", "vulnerability"];
  }
  if (sourceType === "memory") {
    return [...common, "lesson", "decision", "constraint", "pattern"];
  }
  if (sourceType === "test") {
    return [...common, "test", "assert", "expected", "actual"];
  }
  return common;
}

function suggestedSectionsFor(sourceType: LearningSourceType): string[] {
  if (sourceType === "review") {
    return ["Review Lessons", "Review Checklist", "Anti-patterns"];
  }
  if (sourceType === "health") {
    return ["Testing Rules", "Review Checklist", "Anti-patterns"];
  }
  if (sourceType === "memory") {
    return ["Business Rules", "Implementation Patterns", "Review Lessons"];
  }
  if (sourceType === "test") {
    return ["Testing Rules", "Anti-patterns"];
  }
  return ["Anti-patterns", "Review Lessons"];
}

function confidenceFor({
  explicitSkill,
  lessons,
}: {
  explicitSkill: boolean;
  lessons: string[];
}): LearningProposal["confidence"] {
  if (explicitSkill && lessons.length >= 2) {
    return "high";
  }
  if (lessons.length > 0) {
    return "medium";
  }
  return "low";
}

function renderProposalMarkdown(proposal: LearningProposal): string {
  const lessons = proposal.lessons.length > 0
    ? proposal.lessons.map((lesson) => `- ${lesson}`).join("\n")
    : "- No concrete lessons extracted. Review the source manually.";
  const sections = proposal.suggestedSections.map((section) => `- ${section}`).join("\n");

  return `# Skill Learning Proposal

Version: 0.1.0

Proposal: ${proposal.proposalId}
Created: ${proposal.createdAt}
Source Type: ${proposal.sourceType}
Source: ${proposal.sourcePath}
Confidence: ${proposal.confidence}

## Target Skill

- Module: \`${proposal.skill.module}\`
- Skill: \`${proposal.skill.name}\`
- Path: \`${proposal.skill.path}\`
- Target: \`${proposal.skill.target}\`

## Candidate Lessons

${lessons}

## Suggested Sections

${sections}

## Application Policy

This proposal does not automatically change \`SKILL.md\`.
Apply only after review, then update \`skill-changelog.md\` with the source and changed sections.
`;
}

function applyLessonsToSkill(
  skillMd: string,
  proposal: LearningProposal,
  nextVersion: string,
  changedSections: string[],
): string {
  let next = skillMd.replace(/^Version:\s*.+$/m, `Version: ${nextVersion}`);
  for (const section of changedSections) {
    next = appendBulletsToSection(next, section, lessonsForSection(proposal, section));
  }

  return next;
}

function appendBulletsToSection(content: string, section: string, lessons: string[]): string {
  if (lessons.length === 0) {
    return content;
  }

  const heading = `## ${section}`;
  const startIndex = content.indexOf(heading);
  if (startIndex === -1) {
    return `${content.trimEnd()}\n\n${heading}\n\n${renderLessonBullets(lessons)}\n`;
  }

  const bodyStart = startIndex + heading.length;
  const nextHeadingIndex = content.indexOf("\n## ", bodyStart);
  const before = content.slice(0, bodyStart);
  const body = nextHeadingIndex === -1 ? content.slice(bodyStart) : content.slice(bodyStart, nextHeadingIndex);
  const after = nextHeadingIndex === -1 ? "" : content.slice(nextHeadingIndex);
  const existingLessons = new Set(
    body
      .split(/\r?\n/)
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter(Boolean),
  );
  const newLessons = lessons.filter((lesson) => !existingLessons.has(lesson));
  if (newLessons.length === 0) {
    return content;
  }

  const cleanedBody = body.replace(/\n-\s*No review lessons recorded yet\.\s*/i, "\n");
  return `${before}${cleanedBody.trimEnd()}\n\n${renderLessonBullets(newLessons)}\n${after}`;
}

function lessonsForSection(proposal: LearningProposal, section: string): string[] {
  if (section === "Review Checklist") {
    return proposal.lessons
      .filter((lesson) => /recommendation|should|must|check/i.test(lesson))
      .map((lesson) => normalizeLessonPrefix(lesson, "Check"));
  }

  if (section === "Anti-patterns") {
    return proposal.lessons
      .filter((lesson) => /risk|avoid|missing|failed|error|bug|regression/i.test(lesson))
      .map((lesson) => normalizeLessonPrefix(lesson, "Avoid"));
  }

  return proposal.lessons;
}

function normalizeLessonPrefix(lesson: string, prefix: string): string {
  const cleaned = lesson.replace(/^(finding|risk|recommendation|lesson):\s*/i, "").trim();
  return `${prefix}: ${cleaned}`;
}

function renderLessonBullets(lessons: string[]): string {
  return lessons.map((lesson) => `- ${lesson}`).join("\n");
}

function sectionsToApply(proposal: LearningProposal): string[] {
  const allowed = ["Review Lessons", "Review Checklist", "Anti-patterns", "Testing Rules", "Business Rules", "Implementation Patterns"];
  const sections = proposal.suggestedSections.filter((section) => allowed.includes(section));
  return sections.length > 0 ? sections : ["Review Lessons"];
}

function appendChangelogEntry(
  changelog: string,
  proposal: LearningProposal,
  nextVersion: string,
  changedSections: string[],
): string {
  const entry = `## ${nextVersion} - ${today()}

- Reason: applied learning proposal \`${proposal.proposalId}\`.
- Source: \`${proposal.sourceType}\` from \`${proposal.sourcePath}\`.
- Changed sections: ${changedSections.map((section) => `\`${section}\``).join(", ")}.
- Affected skill: \`${proposal.skill.module}/${proposal.skill.name}\`.
- Confidence: ${proposal.confidence}.
- Applied mode: manual.
`;

  return `${changelog.trimEnd()}\n\n${entry}`;
}

function readVersion(content: string): string | undefined {
  return content.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
}

function bumpPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return "0.1.1";
  }

  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
