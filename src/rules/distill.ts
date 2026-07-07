import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import {
  ensureMetaprojectReference,
  ruleFileNameFor,
  syncAgentRules,
} from "./agent-entrypoints";

export type DistilledEntry = {
  source: string;
  title: string;
  kind: "rule" | "skill" | "root";
  slug: string;
  path?: string;
};

export type DistillEntrypointsResult = {
  sources: string[];
  rules: DistilledEntry[];
  skills: DistilledEntry[];
  keptRootSections: DistilledEntry[];
};

type Section = {
  title: string;
  body: string;
  level: number;
};

const marker = "<!-- gd-metapro:index -->";

export async function distillAgentEntrypoints(
  projectRoot: string,
  metaprojectRoot: string,
  options: { enableTasks: boolean; manifestSources?: string[] } = { enableTasks: false },
): Promise<DistillEntrypointsResult> {
  const synced = await syncAgentRules(projectRoot, metaprojectRoot, {
    enableTasks: options.enableTasks,
    manifestSources: options.manifestSources ?? [],
    createDefault: true,
  });
  const sources = synced.map((rule) => rule.source);
  const rules: DistilledEntry[] = [];
  const skills: DistilledEntry[] = [];
  const keptRootSections: DistilledEntry[] = [];

  for (const source of sources) {
    const sourcePath = path.join(projectRoot, source);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const original = await readFile(sourcePath, "utf8");
    const sourceBody = stripManagedBlock(original);
    const sections = splitMarkdownSections(sourceBody);
    const kept: Section[] = [];

    for (const section of sections) {
      const kind = classifySection(section);
      const slug = `${sourceSlug(source)}-${slugify(section.title)}`;
      if (kind === "root") {
        kept.push(section);
        keptRootSections.push({ source, title: section.title, kind, slug });
      } else if (kind === "skill") {
        const skillPath = await writeDistilledSkill(metaprojectRoot, source, slug, section);
        skills.push({ source, title: section.title, kind, slug, path: skillPath });
      } else {
        const rulePath = await writeDistilledRule(metaprojectRoot, source, slug, section);
        rules.push({ source, title: section.title, kind, slug, path: rulePath });
      }
    }

    await rewriteEntrypoint(projectRoot, source, kept, options.enableTasks);
  }

  await writeDistilledIndex(metaprojectRoot, rules, skills, keptRootSections);
  return { sources, rules, skills, keptRootSections };
}

export async function hasDistilledEntrypoints(metaprojectRoot: string): Promise<boolean> {
  return pathExists(path.join(metaprojectRoot, "rules", "entrypoints", "index.md"));
}

export async function listRootEntrypoints(projectRoot: string, manifestSources: string[] = []): Promise<string[]> {
  const candidates = [...new Set([...manifestSources, "AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"])];
  const entries = new Set(await readdir(projectRoot));
  return candidates.filter((candidate) => entries.has(candidate));
}

function stripManagedBlock(content: string): string {
  const index = content.indexOf(marker);
  return (index >= 0 ? content.slice(0, index) : content).trim();
}

function splitMarkdownSections(content: string): Section[] {
  const lines = content.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) {
        sections.push(current);
      }
      const hashes = heading[1] ?? "#";
      const title = heading[2] ?? "Root Instructions";
      current = { level: hashes.length, title: title.trim(), body: "" };
      continue;
    }
    if (!current) {
      current = { level: 1, title: "Root Instructions", body: "" };
    }
    current.body = `${current.body}${line}\n`;
  }

  if (current) {
    sections.push(current);
  }

  return sections
    .map((section) => ({ ...section, body: section.body.trim() }))
    .filter((section) => section.title.trim().length > 0 || section.body.length > 0);
}

function classifySection(section: Section): "rule" | "skill" | "root" {
  const text = `${section.title}\n${section.body}`.toLowerCase();
  const projectSignals = [
    ".metaproject", "src/", "docs/", "package.json", "bun", "pnpm", "npm", "typescript",
    "react", "mobx", "component", "store", "service", "module", "pipeline", "vantage",
    "test", "lint", "build", "architecture", "domain", "api", "database", "frontend",
    "backend", "storybook", "playwright",
  ];
  const skillSignals = [
    "workflow", "orchestrator", "skill", "agent", "subagent", "review", "implement",
    "generate", "create", "analyze", "investigate", "verify", "deploy", "test-gen",
  ];
  const rootSignals = [
    "personal", "global", "communication", "tone", "language", "response", "style",
    "priority", "safety", "permissions", "do not", "always ask", "never",
  ];

  const hasProject = projectSignals.some((signal) => text.includes(signal));
  const hasSkill = skillSignals.some((signal) => text.includes(signal));
  const hasRoot = rootSignals.some((signal) => text.includes(signal));

  if (hasRoot && !hasProject) {
    return "root";
  }
  if (hasSkill) {
    return "skill";
  }
  return hasProject ? "rule" : "root";
}

async function writeDistilledRule(
  metaprojectRoot: string,
  source: string,
  slug: string,
  section: Section,
): Promise<string> {
  const relative = path.join("rules", "entrypoints", `${slug}.md`);
  const target = path.join(metaprojectRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `---\ntype: distilled-entrypoint-rule\npriority: high\nsource: ${JSON.stringify(source)}\nversion: "1.0.0"\ngenerated_by: gd-metapro rules distill\n---\n\n# ${section.title}\n\n${section.body}\n`,
    "utf8",
  );
  return relative;
}

async function writeDistilledSkill(
  metaprojectRoot: string,
  source: string,
  slug: string,
  section: Section,
): Promise<string> {
  const relative = path.join("project-skills", "entrypoints", slug, "SKILL.md");
  const target = path.join(metaprojectRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `---\nname: ${slug}\ndescription: Use when working with the project-specific workflow extracted from ${source}: ${section.title}.\nmetadata:\n  source: ${source}\n  version: "1.0.0"\n  generated_by: gd-metapro rules distill\n---\n\n# ${section.title}\n\n## When To Use\n\nUse this skill when the task matches the workflow, agent behavior, or project-specific procedure below.\n\n## Procedure\n\n${section.body}\n\n## Source\n\nExtracted from \`${source}\` by \`gd-metapro rules distill\`.\n`,
    "utf8",
  );
  return relative;
}

async function rewriteEntrypoint(projectRoot: string, source: string, kept: Section[], enableTasks: boolean): Promise<void> {
  const sourcePath = path.join(projectRoot, source);
  const title = `# ${source.replace(/\.md$/i, "")} Instructions`;
  const body = kept.length > 0
    ? kept.map((section) => `${"#".repeat(Math.max(2, section.level))} ${section.title}\n\n${section.body}`.trim()).join("\n\n")
    : "Project-specific rules and skills were moved into `.metaproject/`. Keep only global, personal, or repository-critical always-on instructions here.";
  await writeFile(sourcePath, `${title}\n\n${body}\n`, "utf8");
  await ensureMetaprojectReference(sourcePath, { enableTasks });
}

async function writeDistilledIndex(
  metaprojectRoot: string,
  rules: DistilledEntry[],
  skills: DistilledEntry[],
  keptRootSections: DistilledEntry[],
): Promise<void> {
  const target = path.join(metaprojectRoot, "rules", "entrypoints", "index.md");
  await mkdir(path.dirname(target), { recursive: true });
  const ruleRows = rules.length > 0
    ? rules.map((entry) => `| ${entry.source} | ${entry.title} | ${entry.path} |`).join("\n")
    : "| _none_ | No project rule sections extracted | - |";
  const skillRows = skills.length > 0
    ? skills.map((entry) => `| ${entry.source} | ${entry.title} | ${entry.path} |`).join("\n")
    : "| _none_ | No procedural skill sections extracted | - |";
  const rootRows = keptRootSections.length > 0
    ? keptRootSections.map((entry) => `| ${entry.source} | ${entry.title} |`).join("\n")
    : "| _none_ | No root-only sections kept |";

  await writeFile(
    target,
    `# Distilled Entrypoint Rules\n\nGenerated by \`gd-metapro rules distill\`.\n\n## Extracted Rules\n\n| Source | Section | Entry |\n|--------|---------|-------|\n${ruleRows}\n\n## Extracted Skills\n\n| Source | Section | Entry |\n|--------|---------|-------|\n${skillRows}\n\n## Kept In Root Entrypoints\n\n| Source | Section |\n|--------|---------|\n${rootRows}\n`,
    "utf8",
  );
}

function sourceSlug(source: string): string {
  return ruleFileNameFor(source).replace(/\.md$/, "");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.length > 0 ? slug.slice(0, 80) : "root-instructions";
}
