import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { writeContained } from "../lib/contained-write";
import {
  ensureMetaprojectReference,
  ruleFileNameFor,
  syncAgentRules,
} from "./agent-entrypoints";
import { computeFencedRanges, indexOfMarkerLine } from "./marker-matching";

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

const marker = "<!-- keryx:index -->";
const endMarker = "<!-- /keryx:index -->";

/**
 * R2-F7: every OTHER managed-block pair `keryx rules distill` must never
 * split apart, because it does not own them — `keryx:rules` is
 * `src/integrations/surfaces-rules.ts`'s opt-in rules-export block, and
 * `keryx:instructions` is `markdown-block.ts`'s pointer block. Before this
 * fix, `stripManagedBlock` only knew about `keryx:index`; a sibling block
 * left in the body fell through to `splitMarkdownSections`, which has no
 * concept of a managed block and treated its content as ordinary markdown —
 * its START marker line usually landed in whatever section preceded it (kept
 * or distilled away), and its END marker landed wherever the NEXT heading
 * happened to fall, leaving a lone orphaned start marker in the rewritten
 * entrypoint. `extractOtherManagedBlocks` removes each COMPLETE pair before
 * sectioning ever runs, and `rewriteEntrypoint` re-appends the removed text
 * verbatim (byte-for-byte, markers included) after the kept human sections.
 */
const OTHER_MANAGED_BLOCK_MARKERS: ReadonlyArray<{ readonly start: string; readonly end: string }> = [
  { start: "<!-- keryx:rules -->", end: "<!-- /keryx:rules -->" },
  { start: "<!-- keryx:instructions -->", end: "<!-- /keryx:instructions -->" },
];

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
  // R1-F20: contain every write below against `projectRoot`, never
  // `metaprojectRoot` — see the matching comment in
  // `agent-entrypoints.ts#syncAgentRules`. `metaprojectRoot` is always
  // `<projectRoot>/.metaproject`; writing through it directly moved the
  // containment boundary outside the project when `.metaproject` itself was
  // a symlink.
  const metaprojectRel = path.relative(projectRoot, metaprojectRoot).split(path.sep).join("/");

  for (const source of sources) {
    const sourcePath = path.join(projectRoot, source);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const original = await readFile(sourcePath, "utf8");
    const withoutIndexBlock = stripManagedBlock(original);
    const { body: sourceBody, blocks: preservedBlocks } = extractOtherManagedBlocks(withoutIndexBlock);
    const sections = splitMarkdownSections(sourceBody);
    const kept: Section[] = [];

    for (const section of sections) {
      const kind = classifySection(section);
      const slug = `${sourceSlug(source)}-${slugify(section.title)}`;
      if (kind === "root") {
        kept.push(section);
        keptRootSections.push({ source, title: section.title, kind, slug });
      } else if (kind === "skill") {
        const skillPath = await writeDistilledSkill(projectRoot, metaprojectRel, source, slug, section);
        skills.push({ source, title: section.title, kind, slug, path: skillPath });
      } else {
        const rulePath = await writeDistilledRule(projectRoot, metaprojectRel, source, slug, section);
        rules.push({ source, title: section.title, kind, slug, path: rulePath });
      }
    }

    await rewriteEntrypoint(projectRoot, source, kept, options.enableTasks, preservedBlocks);
  }

  await writeDistilledIndex(projectRoot, metaprojectRel, rules, skills, keptRootSections);
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

// R3-F4 / round-4 fix (R2-F15): every marker below is matched as a WHOLE
// LINE (its trimmed content equals the marker exactly), never a bare
// substring, and a marker found inside a fenced code block is never trusted
// either way — via the ONE shared matcher `./marker-matching` also exports to
// `agent-entrypoints.ts`, rather than each module carrying its own
// independently-maintained copy (that drift is exactly what let
// `agent-entrypoints.ts`'s copy fall behind and lose fence-awareness before
// this fix). Before the original fix, `content.indexOf(marker)` matched an
// inline prose MENTION of the marker (e.g. a sentence documenting
// `<!-- keryx:index -->`) exactly like a real block boundary, silently
// deleting every human section between that mention and the next real marker
// it happened to pair with.

function stripManagedBlock(content: string): string {
  const fenced = computeFencedRanges(content);
  const index = indexOfMarkerLine(content, marker, fenced);
  if (index < 0) {
    return content.trim();
  }
  const searchFrom = index + marker.length;
  const endOffset = indexOfMarkerLine(content.slice(searchFrom), endMarker, computeFencedRanges(content.slice(searchFrom)));
  if (endOffset >= 0) {
    const endIndex = searchFrom + endOffset;
    return `${content.slice(0, index)}\n${content.slice(endIndex + endMarker.length)}`.trim();
  }
  return content.slice(0, index).trim();
}

/**
 * Removes every COMPLETE `keryx:rules`/`keryx:instructions` block from
 * `content`, returning the remaining body plus each removed block's exact
 * text (markers included), in the order found. An UNPAIRED marker (a start
 * with no matching end — not this module's job to repair) is left exactly
 * where it is rather than guessed at; the section splitter downstream may
 * still mishandle that pre-existing corruption, which is no worse than
 * before this fix and is a `markdown-block.ts` install/probe concern, not
 * distill's. Markers are matched whole-line and fence-aware (R3-F4) — a
 * prose sentence quoting `<!-- keryx:rules -->`, or an example inside a
 * fenced code block, is never mistaken for a real block boundary.
 */
function extractOtherManagedBlocks(content: string): { body: string; blocks: string[] } {
  let body = content;
  const blocks: string[] = [];
  for (const { start, end } of OTHER_MANAGED_BLOCK_MARKERS) {
    const fenced = computeFencedRanges(body);
    const startIndex = indexOfMarkerLine(body, start, fenced);
    if (startIndex < 0) continue;
    const searchFrom = startIndex + start.length;
    const endOffset = indexOfMarkerLine(body.slice(searchFrom), end, computeFencedRanges(body.slice(searchFrom)));
    if (endOffset < 0) continue;
    const endIndex = searchFrom + endOffset;
    blocks.push(body.slice(startIndex, endIndex + end.length));
    body = `${body.slice(0, startIndex)}\n${body.slice(endIndex + end.length)}`;
  }
  return { body: body.trim(), blocks };
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
    "react", "mobx", "component", "store", "service", "module", "pipeline",
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
  projectRoot: string,
  metaprojectRel: string,
  source: string,
  slug: string,
  section: Section,
): Promise<string> {
  const relative = `rules/entrypoints/${slug}.md`;
  await writeContained(
    projectRoot,
    `${metaprojectRel}/${relative}`,
    `---\ntype: distilled-entrypoint-rule\npriority: high\nsource: ${JSON.stringify(source)}\nversion: "1.0.0"\ngenerated_by: keryx rules distill\n---\n\n# ${section.title}\n\n${section.body}\n`,
  );
  return relative;
}

async function writeDistilledSkill(
  projectRoot: string,
  metaprojectRel: string,
  source: string,
  slug: string,
  section: Section,
): Promise<string> {
  const relative = `project-skills/entrypoints/${slug}/SKILL.md`;
  await writeContained(
    projectRoot,
    `${metaprojectRel}/${relative}`,
    `---\nname: ${slug}\ndescription: Use when working with the project-specific workflow extracted from ${source}: ${section.title}.\nmetadata:\n  source: ${source}\n  version: "1.0.0"\n  generated_by: keryx rules distill\n---\n\n# ${section.title}\n\n## When To Use\n\nUse this skill when the task matches the workflow, agent behavior, or project-specific procedure below.\n\n## Procedure\n\n${section.body}\n\n## Source\n\nExtracted from \`${source}\` by \`keryx rules distill\`.\n`,
  );
  return relative;
}

async function rewriteEntrypoint(
  projectRoot: string,
  source: string,
  kept: Section[],
  enableTasks: boolean,
  preservedBlocks: readonly string[],
): Promise<void> {
  const sourcePath = path.join(projectRoot, source);
  const title = `# ${source.replace(/\.md$/i, "")} Instructions`;
  const body = kept.length > 0
    ? kept.map((section) => `${"#".repeat(Math.max(2, section.level))} ${section.title}\n\n${section.body}`.trim()).join("\n\n")
    : "Project-specific rules and skills were moved into `.metaproject/`. Keep only global, personal, or repository-critical always-on instructions here.";
  // R2-F7: every OTHER managed block this source carried (`keryx:rules`,
  // `keryx:instructions`) is carried through verbatim, appended after the
  // kept human content — `ensureMetaprojectReference` below still owns
  // `keryx:index` on its own, since it must also handle the "no block yet"
  // insertion case these preserved blocks never need.
  const preserved = preservedBlocks.length > 0 ? `\n\n${preservedBlocks.join("\n\n")}` : "";
  await writeContained(projectRoot, source, `${title}\n\n${body}${preserved}\n`);
  await ensureMetaprojectReference(sourcePath, { enableTasks, root: projectRoot });
}

async function writeDistilledIndex(
  projectRoot: string,
  metaprojectRel: string,
  rules: DistilledEntry[],
  skills: DistilledEntry[],
  keptRootSections: DistilledEntry[],
): Promise<void> {
  const ruleRows = rules.length > 0
    ? rules.map((entry) => `| ${entry.source} | ${entry.title} | ${entry.path} |`).join("\n")
    : "| _none_ | No project rule sections extracted | - |";
  const skillRows = skills.length > 0
    ? skills.map((entry) => `| ${entry.source} | ${entry.title} | ${entry.path} |`).join("\n")
    : "| _none_ | No procedural skill sections extracted | - |";
  const rootRows = keptRootSections.length > 0
    ? keptRootSections.map((entry) => `| ${entry.source} | ${entry.title} |`).join("\n")
    : "| _none_ | No root-only sections kept |";

  await writeContained(
    projectRoot,
    `${metaprojectRel}/rules/entrypoints/index.md`,
    `# Distilled Entrypoint Rules\n\nGenerated by \`keryx rules distill\`.\n\n## Extracted Rules\n\n| Source | Section | Entry |\n|--------|---------|-------|\n${ruleRows}\n\n## Extracted Skills\n\n| Source | Section | Entry |\n|--------|---------|-------|\n${skillRows}\n\n## Kept In Root Entrypoints\n\n| Source | Section |\n|--------|---------|\n${rootRows}\n`,
  );
}

function sourceSlug(source: string): string {
  return ruleFileNameFor(source).replace(/\.md$/, "");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.length > 0 ? slug.slice(0, 80) : "root-instructions";
}
