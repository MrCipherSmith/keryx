export function renderIndexMarkdown({
  enableGdgraph,
  enableGdctx,
  enableGdwiki,
  enableGdskills,
  enableHealth,
  enableTesting,
  enableMemory,
  enableTasks,
  ruleSources,
}: {
  enableGdgraph: boolean;
  enableGdctx: boolean;
  enableGdwiki: boolean;
  enableGdskills: boolean;
  enableHealth: boolean;
  enableTesting: boolean;
  enableMemory: boolean;
  enableTasks: boolean;
  ruleSources: string[];
}): string {
  const moduleRows = [
    enableGdgraph
      ? "| gdgraph | Code graph, dependencies, symbols, affected context | modules/gdgraph.md |"
      : "",
    enableGdctx
      ? "| gdctx | Token-aware command output and context compression | modules/gdctx.md |"
      : "",
    enableGdwiki
      ? "| gdwiki | Project knowledge base: architecture, domain, rules, decisions | modules/gdwiki.md |"
      : "",
    enableGdskills
      ? "| gdskills | Native bundled working skills, orchestration, review, and project-skill lifecycle | modules/gdskills.md |"
      : "",
    enableHealth
      ? "| health | Code quality aggregation, scoring, and quality gate | modules/health.md |"
      : "",
    enableTesting
      ? "| testing | Test context, related tests, execution reports, and test intelligence | modules/testing.md |"
      : "",
    enableMemory
      ? "| memory | Long-lived project memory: lessons, decisions, constraints, known mistakes | modules/memory.md |"
      : "",
    enableTasks
      ? "| tasks | Agent-first flow lifecycle: frozen acceptance criteria, status gates, PR completion | modules/tasks.md |"
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const dataRefItems = [
    ...(enableGdgraph
      ? [
          "- `data/gdgraph/artifacts/summary.md`",
          "- `data/gdgraph/artifacts/module-map.json`",
          "- `data/gdgraph/queries/latest.md`",
        ]
      : []),
    ...(enableGdctx ? ["- `data/gdctx/artifacts/latest.md`"] : []),
    ...(enableGdwiki ? ["- `wiki/index.md`"] : []),
    ...(enableGdskills
      ? [
          "- `skills/catalog.md`",
          "- `skills/gdskills/`",
          "- `project-skills/`",
          "- `data/gdskills/artifacts/latest.md`",
        ]
      : []),
    ...(enableHealth ? ["- `data/health/artifacts/latest.md`"] : []),
    ...(enableTesting
      ? [
          "- `data/testing/context.md`",
          "- `data/testing/recommendations.md`",
          "- `data/testing/artifacts/latest.md`",
        ]
      : []),
    ...(enableMemory
      ? [
          "- `memory/index.md`",
          "- `data/memory/index/index.json`",
          "- `data/memory/artifacts/latest.md`",
        ]
      : []),
    ...(enableTasks ? ["- `flows/` (flow packages)"] : []),
  ];
  const dataRefs = dataRefItems.length > 0
    ? dataRefItems.join("\n")
    : "- No module data generated yet.";

  const skillsRefs = [
    enableGdgraph
      ? "| gdgraph | Default navigation layer for finding relevant project files before broad raw search | skills/gdgraph/SKILL.md |"
      : "",
    enableGdctx
      ? "| gdctx | Use compact command/search/read outputs before loading large raw output | skills/gdctx/SKILL.md |"
      : "",
    enableGdwiki
      ? "| gdwiki | Read wiki/index.md first for architecture, domain, business rules, and decisions | skills/gdwiki/SKILL.md |"
      : "",
    enableGdskills
      ? "| gdskills | Use project-local bundled working skills and project-skill routing before external/global skills | skills/catalog.md |"
      : "",
    enableHealth
      ? "| health | Read data/health/artifacts/latest.md before claiming quality status or gate results | skills/health/SKILL.md |"
      : "",
    enableTesting
      ? "| testing | Read testing context before creating/changing tests and normalized reports before raw test logs | skills/testing/SKILL.md |"
      : "",
    enableMemory
      ? "| memory | Search accepted project memory before historical, decision, and repeated-mistake questions | skills/memory/SKILL.md |"
      : "",
    enableTasks
      ? "| flow | Start/track/finish managed work items (создай фло, create a flow from an issue) | skills/flow/SKILL.md |"
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const workflowItems = [
    "Read this file first.",
    "Check enabled modules.",
    "Load relevant rules from `rules/`.",
    "Route by question type: structural questions go to gdgraph first; conceptual questions go to gdwiki first; gdctx runs in parallel to keep output compact.",
    enableGdgraph
      ? "For structural questions (where is X, what files are related, what breaks if I change Y, usages, cycles, orphans) use `skills/gdgraph/SKILL.md` first, before broad raw file search. The user does not need to request graph usage explicitly."
      : "Use relevant skills from `skills/` before broad raw file search.",
    ...(enableGdwiki
      ? [
          "For conceptual questions (how does X work, why, architecture, domain models, business rules, user scenarios, auth and other flows, integrations, known decisions) read `wiki/index.md` first via `skills/gdwiki/SKILL.md`, then use gdgraph to jump from the wiki page to code.",
        ]
      : []),
    ...(enableGdctx
      ? [
          "In parallel, use `skills/gdctx/SKILL.md` for commands, search, diff, test logs, lint/build output, and large file reads that can produce long output. The user does not need to request compact context usage explicitly.",
        ]
      : []),
    ...(enableGdskills
      ? [
          "For implementation, review, refactoring, planning, documentation, or quality tasks, check `skills/catalog.md` and project-local gdskills before any external/global skill set.",
          "For known modules/components/stores/services/domain entities, check generated project skills under `project-skills/<module>/<entity>/` before generic guidance.",
        ]
      : []),
    ...(enableHealth
      ? [
          "For code quality status (lint, type, test, coverage, complexity, gate, regressions), read `data/health/artifacts/latest.md` or run `gd-metapro health run`; do not claim quality status from raw logs.",
        ]
      : []),
    ...(enableTesting
      ? [
          "For creating, changing, debugging, reviewing, or running tests, read `data/testing/context.md` and use `skills/testing/SKILL.md`; read `data/testing/artifacts/latest.md` before raw test logs.",
        ]
      : []),
    ...(enableMemory
      ? [
          "For lessons learned, known decisions, constraints, repeated mistakes, historical context, or skill verification signals, use `skills/memory/SKILL.md` and `gd-metapro memory search` before broad documentation reads.",
        ]
      : []),
    ...(enableTasks
      ? [
          "When the user asks to start, create, track, or finish a piece of work (создай фло, create a flow from this issue, flow status, finish the story), use `skills/flow/SKILL.md` and the `gd-metapro flow` CLI; never edit flow.json or frozen acceptance criteria by hand.",
        ]
      : []),
    "Use relevant skills from `skills/`.",
    "Use module manifests before reading raw generated data.",
    "Prefer curated artifacts in `data/*/artifacts`.",
    "Run module CLI commands when generated data is stale.",
  ]
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");

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

Human dashboard: [gd-metapro-dashboard.html](gd-metapro-dashboard.html)

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
${moduleRows || "| _none_ | No modules enabled yet | - |"}
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

${workflowItems}

## Data

${dataRefs}

## Refresh

\`\`\`bash
gd-metapro index refresh
${enableGdgraph ? "gd-metapro gdgraph build" : ""}
${enableTesting ? "gd-metapro test analyze" : ""}
${enableMemory ? "gd-metapro memory index" : ""}
\`\`\`
`;
}

export function renderMetaprojectDashboardHtml({
  enableGdgraph,
  enableGdctx,
  enableGdwiki,
  enableGdskills,
  enableHealth,
  enableTesting,
  enableMemory,
  enableTasks,
}: {
  enableGdgraph: boolean;
  enableGdctx: boolean;
  enableGdwiki: boolean;
  enableGdskills: boolean;
  enableHealth: boolean;
  enableTesting: boolean;
  enableMemory: boolean;
  enableTasks: boolean;
}): string {
  const modules = [
    {
      enabled: enableGdgraph,
      name: "gdgraph",
      role: "Project structure",
      summary: "File dependency graph, affected context, cycles, orphans, and module map.",
      accent: "#2563eb",
      links: [
        ["Manifest", "modules/gdgraph.md"],
        ["Summary", "data/gdgraph/artifacts/summary.md"],
        ["Module map", "data/gdgraph/artifacts/module-map.json"],
        ["Skill", "skills/gdgraph/SKILL.md"],
      ],
      commands: ["gd-metapro gdgraph build", "gd-metapro gdgraph affected <file>", "gd-metapro gdgraph query cycles"],
    },
    {
      enabled: enableGdctx,
      name: "gdctx",
      role: "Compact context",
      summary: "Token-aware wrappers for search, reads, diffs, and command output.",
      accent: "#0891b2",
      links: [
        ["Manifest", "modules/gdctx.md"],
        ["Latest artifact", "data/gdctx/artifacts/latest.md"],
        ["Config", "gdctx.config.json"],
        ["Skill", "skills/gdctx/SKILL.md"],
      ],
      commands: ["gd-metapro ctx diff", "gd-metapro ctx rg \"pattern\"", "gd-metapro ctx read <file>"],
    },
    {
      enabled: enableGdwiki,
      name: "gdwiki",
      role: "Knowledge base",
      summary: "Markdown wiki for architecture, business rules, scenarios, integrations, and decisions.",
      accent: "#7c3aed",
      links: [
        ["Manifest", "modules/gdwiki.md"],
        ["Wiki index", "wiki/index.md"],
        ["Template", "wiki/templates/page.md"],
        ["Skill", "skills/gdwiki/SKILL.md"],
      ],
      commands: ["gd-metapro wiki new decision <slug>", "gd-metapro wiki index", "gd-metapro wiki check-links"],
    },
    {
      enabled: enableGdskills,
      name: "gdskills",
      role: "Agent skills",
      summary: "Bundled working skills plus project-skill creation, routing, verification, learning, export, and sync.",
      accent: "#db2777",
      links: [
        ["Manifest", "modules/gdskills.md"],
        ["Catalog", "skills/catalog.md"],
        ["Bundled skills", "skills/gdskills/"],
        ["Reports", "data/gdskills/reports/"],
      ],
      commands: ["gd-metapro skills status", "gd-metapro skills route <target>", "gd-metapro skills verify --all"],
    },
    {
      enabled: enableHealth,
      name: "health",
      role: "Quality signal",
      summary: "Aggregated code health from TypeScript, tests, audit, coverage, complexity, and optional external tools.",
      accent: "#16a34a",
      links: [
        ["Manifest", "modules/health.md"],
        ["Latest report", "data/health/artifacts/latest.md"],
        ["Config", "health.config.json"],
        ["Skill", "skills/health/SKILL.md"],
      ],
      commands: ["gd-metapro health run --changed", "gd-metapro health status", "gd-metapro health explain <file>"],
    },
    {
      enabled: enableTesting,
      name: "testing",
      role: "Test intelligence",
      summary: "Detected test stack, conventions, related-test selection, normalized reports, and strict gates.",
      accent: "#ea580c",
      links: [
        ["Manifest", "modules/testing.md"],
        ["Context", "data/testing/context.md"],
        ["Recommendations", "data/testing/recommendations.md"],
        ["Latest report", "data/testing/artifacts/latest.md"],
      ],
      commands: ["gd-metapro test analyze", "gd-metapro test run --changed", "gd-metapro test related <file>"],
    },
    {
      enabled: enableMemory,
      name: "memory",
      role: "Long-term memory",
      summary: "Lessons learned, decisions, constraints, known mistakes, historical context, and reusable patterns.",
      accent: "#475569",
      links: [
        ["Manifest", "modules/memory.md"],
        ["Memory index", "memory/index.md"],
        ["Config", "memory.config.json"],
        ["Skill", "skills/memory/SKILL.md"],
      ],
      commands: ["gd-metapro memory search \"topic\"", "gd-metapro memory new decision", "gd-metapro memory check"],
    },
    {
      enabled: enableTasks,
      name: "tasks",
      role: "Flow lifecycle",
      summary: "Agent-first flow packages with frozen acceptance criteria, status gates, and PR completion checks.",
      accent: "#0f766e",
      links: [
        ["Manifest", "modules/tasks.md"],
        ["Flows", "flows/"],
        ["Skill", "skills/flow/SKILL.md"],
        ["Flow README", "flows/README.md"],
      ],
      commands: ["gd-metapro flow list", "gd-metapro flow init --title \"...\"", "gd-metapro flow complete <id>"],
    },
  ];

  const enabledModules = modules.filter((module) => module.enabled);
  const cards = enabledModules.map((module) => `
        <article class="module-card" style="--accent: ${module.accent}">
          <div class="module-head">
            <span class="module-name">${module.name}</span>
            <span class="module-role">${module.role}</span>
          </div>
          <p>${module.summary}</p>
          <div class="link-grid">
            ${module.links.map(([label, href]) => `<a href="${href}">${label}</a>`).join("")}
          </div>
          <div class="commands">
            ${module.commands.map((command) => `<code>${escapeHtml(command)}</code>`).join("")}
          </div>
        </article>`).join("\n");
  const disabled = modules
    .filter((module) => !module.enabled)
    .map((module) => `<span>${module.name}</span>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Metaproject Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #64748b;
      --line: #d9dee8;
      --soft: #eef2f7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    header {
      padding: 32px 40px 22px;
      background: #ffffff;
      border-bottom: 1px solid var(--line);
    }
    main { padding: 28px 40px 44px; }
    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.1;
      letter-spacing: 0;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 16px;
      letter-spacing: 0;
    }
    p { margin: 0; color: var(--muted); }
    .topline {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: flex-start;
    }
    .meta-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .meta-actions a,
    .link-grid a {
      color: var(--ink);
      text-decoration: none;
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 7px 10px;
      border-radius: 6px;
    }
    .meta-actions a:hover,
    .link-grid a:hover { border-color: #94a3b8; }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 24px;
    }
    .stat {
      background: var(--soft);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .stat strong {
      display: block;
      font-size: 22px;
      line-height: 1;
      margin-bottom: 6px;
    }
    .section {
      margin-top: 28px;
    }
    .modules {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 14px;
    }
    .module-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-left: 4px solid var(--accent);
      border-radius: 8px;
      padding: 16px;
      min-height: 250px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .module-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }
    .module-name {
      font-size: 18px;
      font-weight: 700;
    }
    .module-role {
      color: var(--muted);
      font-size: 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      white-space: nowrap;
    }
    .link-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .commands {
      display: grid;
      gap: 6px;
      margin-top: auto;
    }
    code {
      display: block;
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #111827;
      color: #e5e7eb;
      border-radius: 6px;
      padding: 7px 8px;
    }
    .workflow {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
    }
    .step {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 110px;
    }
    .step b { display: block; margin-bottom: 6px; }
    .disabled {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .disabled span {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 999px;
      padding: 5px 9px;
    }
    @media (max-width: 900px) {
      header, main { padding-left: 18px; padding-right: 18px; }
      .topline { display: block; }
      .meta-actions { justify-content: flex-start; margin-top: 16px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .workflow { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topline">
      <div>
        <h1>Metaproject Dashboard</h1>
        <p>Human-readable overview of agent context, project modules, generated artifacts, and CLI entrypoints.</p>
      </div>
      <nav class="meta-actions" aria-label="Primary links">
        <a href="index.md">Agent index</a>
        <a href="README.md">README</a>
        <a href="metaproject.json">Manifest</a>
        <a href="skills/catalog.md">Skills catalog</a>
      </nav>
    </div>
    <section class="stats" aria-label="Metaproject stats">
      <div class="stat"><strong>${enabledModules.length}</strong><span>enabled modules</span></div>
      <div class="stat"><strong>${enableGdskills ? "yes" : "no"}</strong><span>local skills catalog</span></div>
      <div class="stat"><strong>${enableGdgraph ? "yes" : "no"}</strong><span>graph navigation</span></div>
      <div class="stat"><strong>${enableHealth || enableTesting ? "yes" : "no"}</strong><span>quality signals</span></div>
    </section>
  </header>
  <main>
    <section class="section">
      <h2>Enabled Modules</h2>
      <div class="modules">
${cards || "        <p>No modules enabled.</p>"}
      </div>
    </section>
    <section class="section">
      <h2>Agent Workflow</h2>
      <div class="workflow">
        <div class="step"><b>1. Route</b><p>Start from index.md and select the module or skill that owns the question.</p></div>
        <div class="step"><b>2. Navigate</b><p>Use gdgraph for related files, affected context, cycles, and module boundaries.</p></div>
        <div class="step"><b>3. Compress</b><p>Use gdctx before loading large search output, diffs, command logs, or long files.</p></div>
        <div class="step"><b>4. Verify</b><p>Read testing and health reports before claiming quality or gate status.</p></div>
        <div class="step"><b>5. Learn</b><p>Write decisions and lessons to wiki, memory, and project skills when patterns change.</p></div>
      </div>
    </section>
    <section class="section">
      <h2>Disabled Modules</h2>
      <div class="disabled">${disabled || "<span>none</span>"}</div>
    </section>
  </main>
</body>
</html>
`;
}

export function renderAgentEntrypoint({ source }: { source: string }): string {
  return `# ${source.replace(/\.md$/i, "")} Instructions

<!-- gd-metapro:index -->
## Metaproject

Read [.metaproject/index.md](.metaproject/index.md) before planning, implementing, or reviewing this repository.

For project navigation, file discovery, and code-related tasks, use the Metaproject gdgraph skill by default before broad raw file search.

For architecture, domain models, business rules, user scenarios, auth and other flows, integrations, and known decisions, consult the Metaproject gdwiki skill and read the wiki index before deep code reads; use gdgraph to move from a wiki concept to code.

For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.

For implementation, review, refactoring, planning, documentation, or quality tasks, use project-local Metaproject skills first: .metaproject/skills/catalog.md, .metaproject/project-skills/, then .metaproject/skills/gdskills/. External/global skills are fallback only when explicitly needed.

For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.

For lessons learned, decisions, constraints, repeated mistakes, and historical project context, use the Metaproject memory skill before broad documentation search.

For starting, tracking, or finishing a managed piece of work (a flow) - e.g. when the user asks to create a flow from a problem description or an issue link, asks for flow status, or asks to finish a story - use the Metaproject flow skill; all flow state changes go through the gd-metapro flow CLI.
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMetaprojectGitignoreBlock(): string {
  return `# Metaproject: keep agent-facing context versioned, ignore executable/generated internals.
.metaproject/runtime/
.metaproject/core/**/*.ts
.metaproject/data/**/storage/
.metaproject/data/**/raw/
.metaproject/data/**/queries/
.metaproject/data/**/summaries/
.metaproject/data/gdctx/artifacts/
.metaproject/data/gdwiki/artifacts/
.metaproject/data/gdwiki/link-check/
.metaproject/data/health/history/
.metaproject/data/health/artifacts/latest.md
.metaproject/data/health/artifacts/latest.json
.metaproject/data/testing/history/
.metaproject/data/testing/logs/
.metaproject/data/testing/artifacts/latest.md
.metaproject/data/testing/artifacts/latest.json
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
  enableGdctx,
  enableGdwiki,
  enableGdskills,
  enableHealth,
  enableTesting,
  enableMemory,
  enableTasks,
}: {
  enableGdgraph: boolean;
  enableGdctx: boolean;
  enableGdwiki: boolean;
  enableGdskills: boolean;
  enableHealth: boolean;
  enableTesting: boolean;
  enableMemory: boolean;
  enableTasks: boolean;
}): string {
  const moduleItems = [
    enableGdgraph ? "- `gdgraph`: code graph and affected context." : "",
    enableGdctx
      ? "- `gdctx`: compact command/search/read output and raw output archive."
      : "",
    enableGdwiki
      ? "- `gdwiki`: local project knowledge base from business logic to implementation."
      : "",
    enableGdskills
      ? "- `gdskills`: project-local bundled working skills, orchestration, review, and project-skill lifecycle."
      : "",
    enableHealth
      ? "- `health`: code quality aggregation, scoring, and quality gate."
      : "",
    enableTesting
      ? "- `testing`: test context, related tests, and normalized test reports."
      : "",
    enableMemory
      ? "- `memory`: long-lived lessons, decisions, constraints, and known mistakes."
      : "",
    enableTasks
      ? "- `tasks`: agent-first flow lifecycle with frozen acceptance criteria and PR gates."
      : "",
  ].filter(Boolean);
  const modules = moduleItems.length > 0
    ? moduleItems.join("\n")
    : "- No modules enabled yet.";

  const commands = [
    "gd-metapro status",
    ...(enableGdgraph
      ? ["gd-metapro gdgraph build", 'gd-metapro gdgraph query "module pipelines"']
      : []),
    ...(enableGdctx ? ["gd-metapro ctx status", "gd-metapro ctx diff"] : []),
    ...(enableGdwiki ? ["gd-metapro wiki status", "gd-metapro wiki index"] : []),
    ...(enableGdskills
      ? [
          "gd-metapro skills status",
          "gd-metapro skills catalog --profile recommended",
          "gd-metapro skills install --profile recommended",
        ]
      : []),
    ...(enableHealth ? ["gd-metapro health run", "gd-metapro health gate"] : []),
    ...(enableTesting ? ["gd-metapro test analyze", "gd-metapro test run --changed"] : []),
    ...(enableMemory ? ["gd-metapro memory index", 'gd-metapro memory search "project decisions"'] : []),
    ...(enableTasks ? ["gd-metapro flow list", 'gd-metapro flow init --title "..."'] : []),
  ];

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

## git post-commit gdgraph hook

When enabled during \`gd-metapro init\`, the Git \`post-commit\` hook refreshes gdgraph only after commits that touched files relevant to the graph.

Purpose:

- keep graph artifacts current without rebuilding on every agent question;
- avoid broad raw file search when graph context is stale;
- leave generated graph storage local while versioning curated artifacts.

## git post-commit gdskills hook

When enabled during \`gd-metapro init\`, the Git \`post-commit\` hook runs lightweight project-skill verification after relevant project or Metaproject context changes.

Purpose:

- keep generated project-skills from silently drifting after code/wiki/rule changes;
- run non-mutating dry-run verification and report failures without changing files;
- write verification reports only during explicit \`gd-metapro skills verify\` runs or orchestrator-controlled checks;
- keep the hook local, optional and non-blocking.

## git post-commit health hook

When enabled during \`gd-metapro init\`, the Git \`post-commit\` hook runs a lightweight changed-scope Code Health check after relevant source/config changes.

Purpose:

- detect obvious type/complexity regressions close to the commit that introduced them;
- update the latest agent-readable health report for changed scope;
- avoid heavy sources in hooks: tests, audit, coverage and external providers stay manual or orchestrator-controlled.

## git post-commit testing hook

When enabled during \`gd-metapro init\`, the Git \`post-commit\` hook refreshes testing context after relevant source, test, config or documentation changes.

Purpose:

- keep \`.metaproject/data/testing/context.md\` aligned with test stack and conventions;
- stay non-blocking and avoid running heavy suites on every commit;
- give agents fresh context before test generation or debugging.

## git pre-push testing hook

When enabled during \`gd-metapro init\`, the Git \`pre-push\` hook runs changed-scope tests and blocks the push on failure.

Purpose:

- catch focused test failures before remote publication;
- use Testing Module related-test selection instead of always running the whole suite;
- keep blocking behavior explicit and opt-in.

## post-update.d

Executable files in \`post-update.d/\` run only when \`gd-metapro update --hooks\` is requested.

Rules:

- keep hooks idempotent;
- keep hooks project-local;
- do not require network access unless the hook clearly documents it;
- use generated data under \`.metaproject/data\` for outputs.
`;
}

export function renderGdgraphPostCommitHook(): string {
  return `gd_metapro_gdgraph_post_commit() {
  # Refresh gdgraph only when a commit touched graph-relevant files.

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  changed_files="$(git diff-tree --no-commit-id --name-only -r --root HEAD 2>/dev/null || true)"
  if [ -z "$changed_files" ]; then
    return 0
  fi

  if ! printf '%s\\n' "$changed_files" | grep -E '(^src/|^lib/|^app/|^packages/|^services/|^scripts/|^docs/|^\\.metaproject/(modules|skills|rules)/|package\\.json$|tsconfig.*\\.json$|bun\\.lockb$|pnpm-lock\\.yaml$|yarn\\.lock$|package-lock\\.json$)' >/dev/null 2>&1; then
    return 0
  fi

  if command -v gd-metapro >/dev/null 2>&1; then
    gd-metapro gdgraph build >/dev/null 2>&1 || {
      echo "gd-metapro post-commit: gdgraph build failed" >&2
      return 0
    }
    echo "gd-metapro post-commit: gdgraph refreshed"
    return 0
  fi

  if [ -x "$HOME/.local/bin/gd-metapro" ]; then
    "$HOME/.local/bin/gd-metapro" gdgraph build >/dev/null 2>&1 || {
      echo "gd-metapro post-commit: gdgraph build failed" >&2
      return 0
    }
    echo "gd-metapro post-commit: gdgraph refreshed"
    return 0
  fi

  echo "gd-metapro post-commit: gd-metapro command not found, skipped gdgraph refresh" >&2
  return 0
}

gd_metapro_gdgraph_post_commit
`;
}

export function renderGdskillsPostCommitHook(): string {
  return `gd_metapro_gdskills_post_commit() {
  # Verify registered project-skills only when a commit touched relevant files.

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  changed_files="$(git diff-tree --no-commit-id --name-only -r --root HEAD 2>/dev/null || true)"
  if [ -z "$changed_files" ]; then
    return 0
  fi

  if ! printf '%s\\n' "$changed_files" | grep -E '(^src/|^lib/|^app/|^packages/|^services/|^docs/|^\\.metaproject/(project-skills|wiki|modules|rules|skills)/|AGENTS\\.md$|CLAUDE\\.md$)' >/dev/null 2>&1; then
    return 0
  fi

  if command -v gd-metapro >/dev/null 2>&1; then
    gd-metapro skills verify --all --dry-run >/dev/null 2>&1 || {
      echo "gd-metapro post-commit: gdskills verification failed" >&2
      return 0
    }
    echo "gd-metapro post-commit: gdskills verified"
    return 0
  fi

  if [ -x "$HOME/.local/bin/gd-metapro" ]; then
    "$HOME/.local/bin/gd-metapro" skills verify --all --dry-run >/dev/null 2>&1 || {
      echo "gd-metapro post-commit: gdskills verification failed" >&2
      return 0
    }
    echo "gd-metapro post-commit: gdskills verified"
    return 0
  fi

  echo "gd-metapro post-commit: gd-metapro command not found, skipped gdskills verification" >&2
  return 0
}

gd_metapro_gdskills_post_commit
`;
}

export function renderHealthPostCommitHook(): string {
  return `gd_metapro_health_post_commit() {
  # Run lightweight changed-scope Code Health checks only when relevant files changed.

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  changed_files="$(git diff-tree --no-commit-id --name-only -r --root HEAD 2>/dev/null || true)"
  if [ -z "$changed_files" ]; then
    return 0
  fi

  if ! printf '%s\\n' "$changed_files" | grep -E '(^src/|^lib/|^app/|^packages/|^services/|^scripts/|package\\.json$|tsconfig.*\\.json$|bun\\.lockb$|pnpm-lock\\.yaml$|yarn\\.lock$|package-lock\\.json$|^\\.metaproject/health\\.config\\.json$)' >/dev/null 2>&1; then
    return 0
  fi

  if command -v gd-metapro >/dev/null 2>&1; then
    gd-metapro health run --changed --since HEAD~1 --source typescript,complexity >/dev/null 2>&1 || {
      echo "gd-metapro post-commit: health check failed" >&2
      return 0
    }
    echo "gd-metapro post-commit: health checked"
    return 0
  fi

  if [ -x "$HOME/.local/bin/gd-metapro" ]; then
    "$HOME/.local/bin/gd-metapro" health run --changed --since HEAD~1 --source typescript,complexity >/dev/null 2>&1 || {
      echo "gd-metapro post-commit: health check failed" >&2
      return 0
    }
    echo "gd-metapro post-commit: health checked"
    return 0
  fi

  echo "gd-metapro post-commit: gd-metapro command not found, skipped health check" >&2
  return 0
}

gd_metapro_health_post_commit
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

Current MVP builds a file dependency graph plus imported asset nodes. Generated
frontend/static outputs are skipped by default.

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

## Frontend Defaults

- skips \`storybook-static\`, \`public\`, \`.docusaurus\`, \`.next\`, \`out\`, \`dist\`, \`build\`, \`coverage\`, and \`generated\`;
- resolves imported CSS, JSON, SVG, handlebars/raw templates, images and fonts as asset nodes;
- reports source files, asset nodes, import resolution, skipped directories, top modules, and unresolved imports by type.
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
- resolve local imported assets as graph asset nodes;
- skip generated/static frontend output by default;
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

When command output, search results, diff, logs, or large file reads may be long, pair this with \`skills/gdctx/SKILL.md\` so graph narrows the file set and gdctx compresses the output.

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
3. Do not rebuild the graph on every user question. Prefer existing graph storage and curated artifacts.
4. Run build only when graph storage is missing, obviously stale, or the user explicitly asks to refresh it:

\`\`\`bash
gd-metapro gdgraph build
\`\`\`

5. Choose the graph command:

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

6. Use graph output to select the smallest relevant file set.
7. Read those files directly and verify any conclusion against source code.
8. If gdgraph is unavailable or cannot answer the question, state that graph context is unavailable and continue with targeted search.

## Refresh Policy

Graph refresh should happen through one of these paths:

- user or agent explicitly runs \`gd-metapro gdgraph build\`;
- Git \`post-commit\` hook refreshes graph after relevant file changes;
- graph storage is missing and the task needs graph context.

## Reporting

When answering, include a short graph context note:

- \`graph_context: used\` with commands run;
- \`graph_context: unavailable\` with the reason.

Graph output is navigation context, not proof. Verify behavior in actual code before making claims.
`;
}

export function renderGdctxManifest(): string {
  return `# gdctx

## Purpose

Runs common project context commands with token-aware filtering and stores raw output separately.

## Commands

- \`gd-metapro ctx status\`
- \`gd-metapro ctx diff\`
- \`gd-metapro ctx rg "<pattern>"\`
- \`gd-metapro ctx read <file>\`
- \`gd-metapro ctx run -- <command...>\`
- \`gd-metapro ctx show latest\`

## Data

- \`data/gdctx/artifacts/latest.md\`
- \`data/gdctx/raw/\`
- \`data/gdctx/queries/\`

## Config

- \`gdctx.config.json\`

## Skills

- \`skills/gdctx/\`
`;
}

export function renderGdctxConfig(): string {
  return `${JSON.stringify(
    {
      maxOutputLines: 120,
      maxImportantLines: 60,
      maxGroupItems: 12,
      compactHeadLines: 120,
      compactTailLines: 80,
      outlineMaxEntries: 160,
    },
    null,
    2,
  )}\n`;
}

export function renderGdctxCoreReadme(): string {
  return `# gdctx Core

Local gdctx service layer installed by \`gd-metapro init\`.

Responsibilities:

- run project context commands through \`gd-metapro ctx ...\`;
- preserve raw stdout/stderr under \`.metaproject/data/gdctx/raw\`;
- write compact curated summaries under \`.metaproject/data/gdctx/artifacts\`;
- use gdgraph artifacts for narrowing when graph context is available;
- expose a service layer for future CLI and MCP commands.

MVP note: executable gdctx scripts are added after the requirements/spec phase. This directory is reserved now so project-local overrides have a stable location.
`;
}

export function renderGdctxSkillReadme(): string {
  return `---
name: gdctx
description: Use for commands, search, diff, test logs, lint/build output, and large file reads that can produce long output; prefer compact gd-metapro ctx output before loading raw command output into agent context.
---

# gdctx Skill

Use this skill by default when a task needs command output, search results, git diff/status, test logs, lint/build output, or large file reads that may produce more context than the agent should load directly. The user does not need to explicitly ask for gdctx usage.

## Workflow

1. Check whether \`.metaproject/modules/gdctx.md\` exists.
2. For potentially long output, prefer \`gd-metapro ctx ...\` over raw shell output by default.
3. For project navigation or file relationship questions, use gdgraph first when available, then use gdctx for compact command/file output.
4. Treat gdctx summaries as navigation context. Verify important claims against source files before editing or reporting.
5. Use raw output only when the compact summary is insufficient.

## Commands

\`\`\`bash
gd-metapro ctx status
gd-metapro ctx diff
gd-metapro ctx rg "<pattern>"
gd-metapro ctx read <file> --mode outline
gd-metapro ctx read <file> --mode compact
gd-metapro ctx run -- <command...>
gd-metapro ctx show latest
\`\`\`

## Skip When

- The command output is already tiny and exact raw output is more useful.
- The user explicitly asks for literal full file contents.
- \`gd-metapro ctx\` is unavailable.

## Reporting

When gdctx is used, mention the commands run and whether raw output was saved.
`;
}
