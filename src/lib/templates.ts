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
- \`data/gdgraph/storage/graph.sqlite\`

## Skills

- \`skills/gdgraph/\`
`;
}

export function renderGdgraphCoreReadme(): string {
  return `# gdgraph Core

Placeholder for the local gdgraph service layer.

Planned responsibilities:

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
