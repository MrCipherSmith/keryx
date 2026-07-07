import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import {
  renderAgentEntrypoint,
  renderImportedAgentRules,
  renderProjectRulesSkillReadme,
} from "../lib/templates";

export type SyncedAgentRule = {
  source: string;
  ruleFile: string;
  priority: "high";
  version: "1.0.0";
};

export type SyncAgentRulesOptions = {
  enableTasks?: boolean;
  manifestSources?: string[];
  createDefault?: boolean;
};

export async function syncAgentRules(
  projectRoot: string,
  metaprojectRoot: string,
  options: SyncAgentRulesOptions = {},
): Promise<SyncedAgentRule[]> {
  const entrypoints = await findAgentEntrypoints(projectRoot, options.manifestSources ?? []);
  const sources =
    options.createDefault === false
      ? entrypoints
      : await ensureDefaultAgentEntrypoints(projectRoot, entrypoints);

  await mkdir(path.join(metaprojectRoot, "rules"), { recursive: true });
  await mkdir(path.join(metaprojectRoot, "skills", "project-rules"), { recursive: true });

  const synced: SyncedAgentRule[] = [];
  for (const source of sources) {
    const sourcePath = path.join(projectRoot, source);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    await ensureMetaprojectReference(
      sourcePath,
      options.enableTasks === undefined ? {} : { enableTasks: options.enableTasks },
    );
    const ruleFile = ruleFileNameFor(source);
    const sourceContent = await readFile(sourcePath, "utf8");
    await writeTextIfChanged(
      path.join(metaprojectRoot, "rules", ruleFile),
      renderImportedAgentRules({ source, content: sourceContent }),
    );
    synced.push({ source, ruleFile, priority: "high", version: "1.0.0" });
  }

  await writeTextIfChanged(
    path.join(metaprojectRoot, "skills", "project-rules", "README.md"),
    renderProjectRulesSkillReadme({ sources: synced.map((rule) => rule.source) }),
  );

  return synced;
}

export async function ensureMetaprojectReference(
  filePath: string,
  options: { enableTasks?: boolean } = {},
): Promise<void> {
  const content = await readFile(filePath, "utf8");
  const marker = "<!-- gd-metapro:index -->";
  const oldGraphPolicy =
    "For code-related tasks, use the Metaproject gdgraph skill by default before broad raw file search.";
  const graphPolicy =
    "For project navigation, file discovery, and code-related tasks, use the Metaproject gdgraph skill by default before broad raw file search.";
  const wikiPolicy =
    "For architecture, domain models, business rules, user scenarios, auth and other flows, integrations, and known decisions, consult the Metaproject gdwiki skill and read the wiki index before deep code reads; use gdgraph to move from a wiki concept to code.";
  const oldCtxPolicy =
    "When gdctx is enabled, use the Metaproject gdctx skill for commands, search, diff, test logs, and large file reads that can produce long output.";
  const ctxPolicy =
    "For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.";
  const gdskillsPolicy =
    "For implementation, review, refactoring, planning, documentation, or quality tasks, use project-local Metaproject skills first: .metaproject/skills/catalog.md, .metaproject/project-skills/, then .metaproject/skills/gdskills/. External/global skills are fallback only when explicitly needed.";
  const testingPolicy =
    "For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.";
  const memoryPolicy =
    "For lessons learned, decisions, constraints, repeated mistakes, and historical project context, use the Metaproject memory skill before broad documentation search.";
  const oldFlowPolicy =
    "For starting, tracking, or finishing a managed piece of work (a flow) - e.g. when the user asks to create a flow from a problem description or an issue link, asks for flow status, or asks to finish a story - use the Metaproject flow skill; all flow state changes go through the gd-metapro flow CLI.";
  const flowPolicy =
    "For starting, tracking, or finishing a managed piece of work (a flow), use the Metaproject flow skill for state/status commands. For non-trivial implementation through Task Manager, use the local gdskills flow-orchestrator first: .metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md. All flow state changes go through the gd-metapro flow CLI.";

  if (content.includes(marker)) {
    let next = content;
    if (content.includes(oldGraphPolicy)) {
      next = next.replaceAll(oldGraphPolicy, graphPolicy);
    }
    if (next.includes(oldCtxPolicy)) {
      next = next.replaceAll(oldCtxPolicy, ctxPolicy);
    }
    if (next.includes(oldFlowPolicy)) {
      next = next.replaceAll(oldFlowPolicy, flowPolicy);
    }
    next = collapseDuplicatePolicy(next, graphPolicy);
    next = collapseDuplicatePolicy(next, wikiPolicy);
    next = collapseDuplicatePolicy(next, ctxPolicy);
    next = collapseDuplicatePolicy(next, gdskillsPolicy);
    next = collapseDuplicatePolicy(next, testingPolicy);
    next = collapseDuplicatePolicy(next, memoryPolicy);
    next = collapseDuplicatePolicy(next, flowPolicy);
    if (options.enableTasks === false) {
      next = removePolicy(next, flowPolicy);
    }

    const missingPolicies = [
      ...(next.includes(graphPolicy) ? [] : [graphPolicy]),
      ...(next.includes(wikiPolicy) ? [] : [wikiPolicy]),
      ...(next.includes(ctxPolicy) ? [] : [ctxPolicy]),
      ...(next.includes(gdskillsPolicy) ? [] : [gdskillsPolicy]),
      ...(next.includes(testingPolicy) ? [] : [testingPolicy]),
      ...(next.includes(memoryPolicy) ? [] : [memoryPolicy]),
      ...(options.enableTasks === false || next.includes(flowPolicy) ? [] : [flowPolicy]),
    ];
    if (missingPolicies.length > 0) {
      const suffix = next.endsWith("\n") ? "" : "\n";
      next = `${next}${suffix}\n${missingPolicies.join("\n\n")}\n`;
    }

    if (next !== content) {
      await writeFile(filePath, next, "utf8");
    }

    return;
  }

  const suffix = content.endsWith("\n") ? "" : "\n";
  const initialPolicies = [
    graphPolicy,
    wikiPolicy,
    ctxPolicy,
    gdskillsPolicy,
    testingPolicy,
    memoryPolicy,
    ...(options.enableTasks === false ? [] : [flowPolicy]),
  ];
  await writeFile(
    filePath,
    `${content}${suffix}\n${marker}\n## Metaproject\n\nRead [.metaproject/index.md](.metaproject/index.md) before planning, implementing, or reviewing this repository.\n\n${initialPolicies.join("\n\n")}\n`,
    "utf8",
  );
}

export function ruleFileNameFor(source: string): string {
  return `${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
}

async function findAgentEntrypoints(projectRoot: string, manifestSources: string[]): Promise<string[]> {
  const candidates = [...new Set([...manifestSources, "AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"])];
  let files = new Set<string>();
  try {
    files = new Set(await readdir(projectRoot));
  } catch {
    return [];
  }

  const existing: string[] = [];
  const seenRealPaths = new Set<string>();
  for (const candidate of candidates) {
    if (!files.has(candidate)) {
      continue;
    }
    const candidatePath = path.join(projectRoot, candidate);
    const resolved = await realpath(candidatePath);
    if (seenRealPaths.has(resolved)) {
      continue;
    }
    seenRealPaths.add(resolved);
    existing.push(candidate);
  }
  return existing;
}

async function ensureDefaultAgentEntrypoints(projectRoot: string, entrypoints: string[]): Promise<string[]> {
  const sources = [...entrypoints];
  for (const source of ["AGENTS.md", "CLAUDE.md"]) {
    if (!sources.includes(source)) {
      await writeTextIfMissing(path.join(projectRoot, source), renderAgentEntrypoint({ source }));
      sources.push(source);
    }
  }
  return sources;
}

function removePolicy(content: string, policy: string): string {
  const escaped = escapeRegExp(policy);
  return content
    .replace(new RegExp(`\\n{0,2}${escaped}\\n?`, "g"), "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function collapseDuplicatePolicy(content: string, policy: string): string {
  const escaped = escapeRegExp(policy);
  let seen = false;
  return content.replace(new RegExp(`${escaped}\\n*`, "g"), (match) => {
    if (seen) {
      return "";
    }
    seen = true;
    return match.endsWith("\n") ? match : `${match}\n`;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeTextIfMissing(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }
  await writeFile(filePath, content, "utf8");
}

async function writeTextIfChanged(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    const existing = await readFile(filePath, "utf8");
    if (existing === content) {
      return;
    }
  }
  await writeFile(filePath, content, "utf8");
}
