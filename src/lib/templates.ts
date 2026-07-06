export function renderIndexMarkdown({
  enableGdgraph,
}: {
  enableGdgraph: boolean;
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
    ? "- `skills/gdgraph/`"
    : "- No module skills installed yet.";

  return `# Metaproject Index

## Purpose

This \`.metaproject\` folder contains agent-readable context, tools, generated data, and module manifests for this codebase.

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
${moduleRows || "| _none_ | No modules enabled yet | - |\n"}
## Agent Workflow

1. Read this file first.
2. Check enabled modules.
3. Use module manifests before reading raw generated data.
4. Prefer curated artifacts in \`data/*/artifacts\`.
5. Run module CLI commands when generated data is stale.

## Data

${dataRefs}

## Skills

${skillsRefs}

## Refresh

\`\`\`bash
gd-metapro index refresh
${enableGdgraph ? "gd-metapro gdgraph build" : ""}
\`\`\`
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
  return `# gdgraph Skill

Use this skill when a task requires code graph context, dependency impact analysis, module explanation, or affected-file discovery.

## Workflow

1. Check \`.metaproject/modules/gdgraph.md\`.
2. Prefer curated artifacts in \`.metaproject/data/gdgraph/artifacts\`.
3. Run \`gd-metapro gdgraph build\` when graph data is stale.
4. Use \`gd-metapro gdgraph affected <target>\` before implementation or review.
`;
}
