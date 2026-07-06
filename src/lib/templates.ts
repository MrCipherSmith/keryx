export function renderIndexMarkdown({
  enableGdgraph,
  ruleSources,
}: {
  enableGdgraph: boolean;
  ruleSources: string[];
}): string {
  const moduleRows = enableGdgraph
    ? "| gdgraph | Code graph, dependencies, symbols, affected context | modules/gdgraph.md |\n"
    : "";

  const dataRefs = enableGdgraph
    ? [
        "- `data/gdgraph/artifacts/summary.md`",
        "- `data/gdgraph/artifacts/module-map.json`",
        "- `data/gdgraph/queries/latest.md`",
      ].join("\n")
    : "- No module data generated yet.";

  const skillsRefs = enableGdgraph
    ? "| gdgraph | Default navigation layer for finding relevant project files before broad raw search | skills/gdgraph/SKILL.md |"
    : "";

  const rulesRows =
    ruleSources.length > 0
      ? ruleSources
          .map((source) => {
            const ruleFile = `${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
            return `| ${source} | Imported repository agent instructions | rules/${ruleFile} |`;
          })
          .join("\n")
      : "| _none_ | No project rules imported yet | - |";

  return `# Metaproject Index

## Purpose

This \`.metaproject\` folder contains agent-readable context, tools, generated data, and module manifests for this codebase.

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
${moduleRows || "| _none_ | No modules enabled yet | - |\n"}
## Rules

| Source | Purpose | Entry |
|--------|---------|-------|
${rulesRows}

## Skills

| Skill | Purpose | Entry |
|-------|---------|-------|
| project-rules | Use imported repository rules before planning or editing | skills/project-rules/ |
${skillsRefs}

## Agent Workflow

1. Read this file first.
2. Check enabled modules.
3. Load relevant rules from \`rules/\`.
4. For project navigation, file discovery, code understanding, implementation, review, debugging, or refactoring, use \`skills/gdgraph/SKILL.md\` before broad raw file search when gdgraph is enabled.
5. Use relevant skills from \`skills/\`.
6. Use module manifests before reading raw generated data.
7. Prefer curated artifacts in \`data/*/artifacts\`.
8. Run module CLI commands when generated data is stale.

## Data

${dataRefs}

## Refresh

\`\`\`bash
gd-metapro index refresh
${enableGdgraph ? "gd-metapro gdgraph build" : ""}
\`\`\`
`;
}

export function renderAgentEntrypoint({ source }: { source: string }): string {
  return `# ${source.replace(/\.md$/i, "")} Instructions

<!-- gd-metapro:index -->
## Metaproject

Read [.metaproject/index.md](.metaproject/index.md) before planning, implementing, or reviewing this repository.

For project navigation, file discovery, and code-related tasks, use the Metaproject gdgraph skill by default before broad raw file search.
`;
}

export function renderMetaprojectGitignoreBlock(): string {
  return `# Metaproject: keep agent-facing context versioned, ignore executable/generated internals.
.metaproject/runtime/
.metaproject/core/**/*.ts
.metaproject/data/**/storage/
.metaproject/data/**/queries/
.metaproject/data/**/summaries/
.metaproject/reports/
`;
}

export function renderProjectRulesReadme(): string {
  return `# Project Rules

This directory stores repository-level instructions imported from root agent entrypoints such as \`AGENTS.md\` or \`CLAUDE.md\`.

Rules:

- treat files here as agent-readable mirrors of root instructions;
- update the root entrypoint first when changing project-wide instructions;
- rerun \`gd-metapro init\` to resync imported rule files.
`;
}

export function renderImportedAgentRules({
  source,
  content,
}: {
  source: string;
  content: string;
}): string {
  return `# Imported Rules: ${source}

Source: \`${source}\`

This file is generated from the repository root agent entrypoint. Edit \`${source}\`, then rerun \`gd-metapro init\`.

---

${content.trim()}
`;
}

export function renderProjectRulesSkillReadme({
  sources,
}: {
  sources: string[];
}): string {
  const sourceList =
    sources.length > 0
      ? sources.map((source) => `- \`${source}\``).join("\n")
      : "- No root agent entrypoint was found during init.";

  return `# project-rules Skill

Use this skill before planning, implementing, or reviewing work in this repository.

## Sources

${sourceList}

## Workflow

1. Start from \`.metaproject/index.md\`.
2. Read the relevant imported files in \`.metaproject/rules/\`.
3. Apply those rules before module-specific guidance.
4. If root instructions changed, rerun \`gd-metapro init\` to refresh this mirror.
`;
}

export function renderMetaprojectReadme({
  enableGdgraph,
}: {
  enableGdgraph: boolean;
}): string {
  const modules = enableGdgraph
    ? "- `gdgraph`: code graph and affected context."
    : "- No modules enabled yet.";

  const commands = enableGdgraph
    ? [
        "gd-metapro status",
        "gd-metapro gdgraph build",
        'gd-metapro gdgraph query "module pipelines"',
      ]
    : ["gd-metapro status"];

  return `# Project Metaproject

This folder contains local Metaproject configuration, tools, generated data, and agent instructions.

## Installed Modules

${modules}

## Common Commands

\`\`\`bash
${commands.join("\n")}
\`\`\`

## Editing Policy

- Edit module manifests and skills manually when needed.
- Do not manually edit generated files under \`data/*/storage\`.
- Regenerate artifacts with CLI commands.
`;
}

export function renderMetaprojectCoreReadme(): string {
  return `# Metaproject Core

This folder is reserved for local service scripts, module adapters, and generated tool scaffolds installed by \`gd-metapro init\`.

Runtime rule:

- \`core/\` contains executable/service logic.
- \`data/\` contains generated output for agents.
- user-authored module guidance belongs in \`modules/\` and \`skills/\`.
`;
}

export function renderHooksReadme(): string {
  return `# Metaproject Hooks

Hooks are local project scripts executed by selected \`gd-metapro\` lifecycle commands.

## post-update.d

Executable files in \`post-update.d/\` run after \`gd-metapro update\`.

Rules:

- keep hooks idempotent;
- keep hooks project-local;
- do not require network access unless the hook clearly documents it;
- use generated data under \`.metaproject/data\` for outputs.
`;
}

export function renderGdgraphCoreCli(): string {
  return `#!/usr/bin/env bun

import { buildGraph } from "./build";
import { getAffected, getCycles, getOrphans, loadGraph } from "./query";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "build") {
  const result = await buildGraph(process.cwd());
  console.log(\`gdgraph build complete: \${result.nodes} nodes, \${result.edges} edges\`);
  console.log(\`summary: \${result.summaryPath}\`);
  process.exit(0);
}

if (command === "query") {
  const query = args.slice(1).join(" ").trim();
  const graph = await loadGraph(process.cwd());

  if (query === "cycles") {
    const cycles = getCycles(graph);
    if (cycles.length === 0) {
      console.log("No cycles found.");
      process.exit(0);
    }
    for (const cycle of cycles) {
      console.log(cycle.join(" -> "));
    }
    process.exit(0);
  }

  if (query === "orphans") {
    const orphans = getOrphans(graph);
    if (orphans.length === 0) {
      console.log("No orphan modules found.");
      process.exit(0);
    }
    for (const orphan of orphans) {
      console.log(orphan);
    }
    process.exit(0);
  }

  console.error(\`Unsupported gdgraph query: \${query || "<empty>"}\`);
  console.error("Supported queries: cycles, orphans");
  process.exit(1);
}

if (command === "affected") {
  const target = args[1];
  if (!target) {
    console.error("Usage: gd-metapro gdgraph affected <file>");
    process.exit(1);
  }

  const graph = await loadGraph(process.cwd());
  const affected = getAffected(graph, target);

  console.log(\`# Affected context for \${affected.target}\`);
  console.log("");
  console.log("## Dependencies");
  printList(affected.dependencies);
  console.log("");
  console.log("## Dependents");
  printList(affected.dependents);
  process.exit(0);
}

console.error(\`Unknown gdgraph command: \${command}\`);
printHelp();
process.exit(1);

function printHelp(): void {
  console.log(\`gd-metapro gdgraph

Usage:
  gd-metapro gdgraph build
  gd-metapro gdgraph query cycles
  gd-metapro gdgraph query orphans
  gd-metapro gdgraph affected <file>
\`);
}

function printList(items: string[]): void {
  if (items.length === 0) {
    console.log("- none");
    return;
  }

  for (const item of items) {
    console.log(\`- \${item}\`);
  }
}
`;
}

export function renderGdgraphManifest(): string {
  return `# gdgraph

## Purpose

Builds code graph, symbol graph, dependency map, and affected context.

## Commands

- \`gd-metapro gdgraph build\`
- \`gd-metapro gdgraph query "<query>"\`
- \`gd-metapro gdgraph affected <target>\`
- \`gd-metapro gdgraph explain <target>\`

## Data

- \`data/gdgraph/artifacts/summary.md\`
- \`data/gdgraph/artifacts/module-map.json\`
- \`data/gdgraph/storage/nodes.jsonl\`
- \`data/gdgraph/storage/edges.jsonl\`
- \`data/gdgraph/artifacts/summary.md\`

## Skills

- \`skills/gdgraph/\`
`;
}

export function renderGdgraphCoreReadme(): string {
  return `# gdgraph Core

Local gdgraph service layer installed by \`gd-metapro init\`.

Files:

- \`cli.ts\` - local runner used by \`gd-metapro gdgraph ...\`
- \`build.ts\` - builds file dependency graph
- \`query.ts\` - reads graph storage and answers built-in queries
- \`types.ts\` - local graph schema

Responsibilities:

- build file dependency graph;
- build TypeScript/JavaScript symbol graph;
- write graph storage to \`.metaproject/data/gdgraph/storage\`;
- write curated artifacts to \`.metaproject/data/gdgraph/artifacts\`;
- expose service functions for future CLI and MCP commands.
`;
}

export function renderGdgraphSkillReadme(): string {
  return `---
name: gdgraph
description: Use by default for project navigation and file discovery before broad raw search, especially when the user asks where something is, what files are related, what might be affected, or needs implementation, review, refactoring, debugging, architecture, dependency, module relationship, import cycle, or orphan-file context.
---

# gdgraph Skill

Use this skill by default for project navigation and file discovery. The user does not need to explicitly ask for graph usage.

Run gdgraph before broad raw file search when the task involves finding relevant files, understanding project structure, implementation, review, refactoring, debugging, code understanding, impact analysis, architecture, dependencies, or navigation.

Skip gdgraph only when the request is clearly unrelated to project files, asks for a single known file's literal contents, or when gdgraph is unavailable.

## Trigger Examples

- "Добавь обработку ошибки в init."
- "Проверь этот модуль."
- "Почему этот импорт ломается?"
- "Где лучше изменить эту логику?"
- "Где лежит логика инициализации?"
- "Какие файлы связаны с модулем gdgraph?"
- "Найди, где описаны rules/skills."
- "Что затронет изменение этого файла?"
- "Где используется этот модуль?"
- "Как связаны эти части кода?"
- "Есть ли циклы импортов?"
- "С чего начать читать этот модуль?"
- "Проанализируй архитектуру этой области."

## Workflow

1. Check whether \`.metaproject/modules/gdgraph.md\` exists.
2. If the task requires finding relevant project files or understanding relationships, use graph context before broad \`rg\` or reading many files.
3. If graph storage is missing or likely stale, run:

\`\`\`bash
gd-metapro gdgraph build
\`\`\`

4. Choose the graph command:

- Known file path or changed file:

\`\`\`bash
gd-metapro gdgraph affected <file>
\`\`\`

- Dependency cycle question:

\`\`\`bash
gd-metapro gdgraph query cycles
\`\`\`

- Orphan/unreferenced module question:

\`\`\`bash
gd-metapro gdgraph query orphans
\`\`\`

5. Use graph output to select the smallest relevant file set.
6. Read those files directly and verify any conclusion against source code.
7. If gdgraph is unavailable or cannot answer the question, state that graph context is unavailable and continue with targeted search.

## Reporting

When answering, include a short graph context note:

- \`graph_context: used\` with commands run;
- \`graph_context: unavailable\` with the reason.

Graph output is navigation context, not proof. Verify behavior in actual code before making claims.
`;
}
