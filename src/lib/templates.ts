export function renderIndexMarkdown({
  enableGdgraph,
  enableGdctx,
  enableGdwiki,
  enableGdskills,
  enableHealth,
  enableTesting,
  enableMemory,
  enableTasks,
  enableSecurity = false,
  ruleSources,
  hasDistilledEntrypoints = false,
}: {
  enableGdgraph: boolean;
  enableGdctx: boolean;
  enableGdwiki: boolean;
  enableGdskills: boolean;
  enableHealth: boolean;
  enableTesting: boolean;
  enableMemory: boolean;
  enableTasks: boolean;
  enableSecurity?: boolean;
  ruleSources: string[];
  hasDistilledEntrypoints?: boolean;
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
    enableSecurity
      ? "| security | Policy-based scanning, redaction, guardrails, and audit reports for agent inputs/outputs and artifacts | modules/security.md |"
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
          "- `core/gdskills/contracts/` (skill/worker communication schemas: subagent-dispatch, subagent-result, agent-event, orchestrator-state, review-finding)",
          "- `rules/core/` (shared engineering rules library)",
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
    ...(enableSecurity ? ["- `data/security/artifacts/latest.md`"] : []),
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
    enableTasks && enableGdskills
      ? "| flow-orchestrator | Task Manager implementation orchestrator: flow state + gdskills workers + PR/health gates | skills/gdskills/orchestration/flow-orchestrator/SKILL.md |"
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
          "For Metaproject requirements packages under `docs/requirements` (README, PRD, specification, policies, schemas), use `skills/gdskills/planning/requirements-package-orchestrator/SKILL.md`; for current-codebase reverse-engineering documentation, use `autodoc-orchestrator` from `skills/catalog.md`.",
          "For known modules/components/stores/services/domain entities, check generated project skills under `project-skills/<module>/<entity>/` before generic guidance.",
          "When orchestrating multi-agent work, dispatch gdskills workers through the schema contracts in `core/gdskills/contracts/` (subagent-dispatch -> subagent-result) and read `rules/core/subagent-status-protocol.md`; validate a concrete message with `gd-metapro skills contracts validate <file> --schema <name>`.",
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
          enableGdskills
            ? "When the user asks to start, create, track, or finish a managed piece of work, use `skills/flow/SKILL.md` for state/status commands and use `skills/gdskills/orchestration/flow-orchestrator/SKILL.md` for non-trivial implementation through Task Manager. Never edit flow.json or frozen acceptance criteria by hand."
            : "When the user asks to start, create, track, or finish a piece of work (создай фло, create a flow from this issue, flow status, finish the story), use `skills/flow/SKILL.md` and the `gd-metapro flow` CLI; never edit flow.json or frozen acceptance criteria by hand.",
        ]
      : []),
    ...(enableSecurity
      ? [
          "Before writing external/tool content into memory, wiki, reports, or task context, or when scanning artifacts for secrets/PII/prompt-injection/egress, use `modules/security.md` and `gd-metapro security check-output`/`security scan`; read `data/security/artifacts/latest.md` before claiming security status.",
        ]
      : []),
    "Use relevant skills from `skills/`.",
    "Discover tools: each `modules/*.md` manifest lists that module's `gd-metapro` commands; run `gd-metapro --help` for the full CLI surface.",
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
            return `| ${source} | high | Imported root agent-entrypoint rules; apply before module-specific guidance | rules/${ruleFile} |`;
          })
          .join("\n")
      : "| _none_ | - | No project rules imported yet | - |";
  const allRulesRows = [
    rulesRows,
    enableGdskills
      ? "| rules/core | reference | Shared engineering rules library (error-handling, tdd-workflow, subagent-status-protocol, subagent-context-construction, security-baseline, api-contracts, clean-architecture, solid-principles, …) | rules/core/ |"
      : "",
    hasDistilledEntrypoints
      ? "| distilled-entrypoints | high | Decomposed project rules extracted from root entrypoints | rules/entrypoints/index.md |"
      : "",
  ].filter(Boolean).join("\n");

  return `# Metaproject Index

## Purpose

This \`.metaproject\` folder contains agent-readable context, tools (module CLIs), rules (\`rules/\`), skill/worker schemas (\`core/gdskills/contracts/\`), generated data, and module manifests for this codebase.

Human dashboard: [gd-metapro-dashboard.html](gd-metapro-dashboard.html)

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
${moduleRows || "| _none_ | No modules enabled yet | - |"}
## Rules

| Source | Priority | Purpose | Entry |
|--------|----------|---------|-------|
${allRulesRows}

## Skills

| Skill | Purpose | Entry |
|-------|---------|-------|
| project-rules | Use imported repository rules before planning or editing | skills/project-rules/ |
${hasDistilledEntrypoints ? "| entrypoint-distilled-skills | Project-specific skills extracted from root entrypoints | project-skills/entrypoints/ |" : ""}
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

export type MetaprojectDashboardData = {
  generatedAt?: string;
  health?: {
    status: string;
    score: number | string;
    trend?: string;
    findings: number;
    p0: number;
    p1: number;
    p2: number;
    risk: number;
    loc: number;
    complexityMax: number | string;
    complexityAbove: number;
    riskByPriority: Array<{ priority: string; findings: number; weight: number; risk: number }>;
    findingsBySource: Array<{ source: string; findings: number }>;
    dataQualityWarnings: Array<{ tone: string; message: string }>;
    findingsWithoutFile: number;
    sources: Array<{ source: string; status: string; findings: number; required: boolean }>;
    scopes: Array<{ name: string; kind: string; score: number | string; findings: number; risk: number; complexity?: number | string }>;
    files: Array<{ name: string; score: number | string; findings: number; risk: number; complexity?: number | string }>;
    reportHref?: string;
  };
  graph?: {
    nodes: number;
    files: number;
    assets: number;
    edges: number;
    imports: number;
    assetsEdges: number;
    unresolved: number;
    topModules: Array<{ name: string; files: number; edges: number }>;
    storageHref?: string;
  };
  testing?: {
    status: string;
    runner?: string;
    tests?: number;
    failures?: number;
    contextHref?: string;
    reportHref?: string;
  };
  wiki?: {
    pages: Array<{ title: string; href: string; group: string; content?: string }>;
  };
  memory?: {
    entries: Array<{ title: string; href: string; group: string; content?: string }>;
  };
  // Markdown content keyed by dashboard href, embedded so links render in the
  // in-page modal instead of opening the raw file (fetch is blocked on file://).
  docs?: Record<string, string>;
  tasks?: {
    flows: Array<{
      id: string;
      title: string;
      status: string;
      tasksDone: number;
      tasksTotal: number;
      acConfirmed: number;
      acTotal: number;
      pr: string | null;
    }>;
  };
};

export function renderMetaprojectDashboardHtml({
  enableGdgraph,
  enableGdctx,
  enableGdwiki,
  enableGdskills,
  enableHealth,
  enableTesting,
  enableMemory,
  enableTasks,
  enableSecurity = false,
  data,
}: {
  enableGdgraph: boolean;
  enableGdctx: boolean;
  enableGdwiki: boolean;
  enableGdskills: boolean;
  enableHealth: boolean;
  enableTesting: boolean;
  enableMemory: boolean;
  enableTasks: boolean;
  enableSecurity?: boolean;
  data?: MetaprojectDashboardData;
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
        ["Core README", "core/gdgraph/README.md"],
        ["Runner", "core/gdgraph/cli.ts"],
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
        ["Core README", "core/gdctx/README.md"],
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
        ["Wiki folder", "wiki/"],
        ["Template", "wiki/templates/page.md"],
        ["Skill", "skills/gdwiki/SKILL.md"],
      ],
      commands: ["gd-metapro wiki collect", "gd-metapro wiki new decision <slug>", "gd-metapro wiki index"],
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
        ["Project skills", "project-skills/"],
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
        ["Core README", "core/health/README.md"],
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
        ["Core README", "core/testing/README.md"],
        ["Config", "testing.config.json"],
        ["Skill", "skills/testing/SKILL.md"],
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
        ["Core README", "core/memory/README.md"],
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
        ["Skill", "skills/flow/SKILL.md"],
        ["Flow README", "flows/README.md"],
        ["Init skill", "skills/flow/init.md"],
      ],
      commands: ["gd-metapro flow list", "gd-metapro flow init --title \"...\"", "gd-metapro flow complete <id>"],
    },
    {
      enabled: enableSecurity,
      name: "security",
      role: "Guardrails & audit",
      summary: "Policy-based scanning, redaction, guardrails, and audit reports for agent inputs/outputs and artifacts.",
      accent: "#b91c1c",
      links: [
        ["Manifest", "modules/security.md"],
        ["Core README", "core/security/README.md"],
        ["Config", "security.config.json"],
      ],
      commands: ["gd-metapro security status", "gd-metapro security scan <path>", "gd-metapro security report"],
    },
  ];

  const enabledModules = modules.filter((module) => module.enabled);
  const moduleIcons: Record<string, string> = {
    gdgraph: "🕸️",
    gdctx: "📦",
    gdwiki: "📚",
    gdskills: "🛠️",
    health: "💚",
    testing: "🧪",
    memory: "🧠",
    tasks: "🔀",
  };
  const cards = enabledModules.map((module) => `
        <article class="card" style="--c: ${module.accent}" tabindex="0">
          <div class="card-head">
            <span class="card-ic">${moduleIcons[module.name] ?? "▪"}</span>
            <span class="card-name">${module.name}</span>
            <span class="card-role">${module.role}</span>
          </div>
          <p>${module.summary}</p>
          <div class="card-links">
            ${module.links.map(([label, href]) => `<a href="${href}">${label}</a>`).join("")}
          </div>
          <div class="card-cmds">
            ${module.commands.map((command) => `<code>${escapeHtml(command)}</code>`).join("")}
          </div>
        </article>`).join("\n");
  const disabled = modules
    .filter((module) => !module.enabled)
    .map((module) => `<span>${module.name}</span>`)
    .join("");
  const primaryLinks = [
    ["Agent index", "index.md"],
    ["README", "README.md"],
    ["Manifest", "metaproject.json"],
    enableGdskills ? ["Skills catalog", "skills/catalog.md"] : ["Project rules", "skills/project-rules/README.md"],
  ];
  const health = data?.health;
  const graph = data?.graph;
  const testing = data?.testing;
  const wikiPages = data?.wiki?.pages ?? [];
  const memoryEntries = data?.memory?.entries ?? [];
  const flows = data?.tasks?.flows ?? [];
  const flowRows = flows.map((flow) => {
    const tone = flow.status === "done"
      ? "good"
      : flow.status === "blocked"
        ? "bad"
        : (flow.status === "in-progress" || flow.status === "implemented" || flow.status === "completing")
          ? "warn"
          : "";
    return `
            <tr>
              <td><b>${escapeHtml(flow.id)}</b> ${escapeHtml(flow.title)}</td>
              <td><span class="pill ${tone}">${escapeHtml(flow.status)}</span></td>
              <td>${flow.tasksDone}/${flow.tasksTotal}</td>
              <td>${flow.acConfirmed}/${flow.acTotal}</td>
              <td>${flow.pr ? `<a href="${escapeHtml(flow.pr)}">PR</a>` : "-"}</td>
            </tr>`;
  }).join("");
  // Embed page markdown so links open in an in-page modal instead of navigating
  // to a raw .md file (fetch is blocked when the dashboard is opened via file://).
  const docMap: Record<string, string> = { ...(data?.docs ?? {}) };
  for (const page of [...wikiPages, ...memoryEntries]) {
    if (page.content && docMap[page.href] === undefined) {
      docMap[page.href] = page.content;
    }
  }
  const docsJson = JSON.stringify(docMap).replace(/</g, "\\u003c");
  const qualityStatus = health?.status ?? (enableHealth ? "missing" : "disabled");
  const graphStatus = graph ? `${graph.files} files` : (enableGdgraph ? "missing" : "disabled");
  const healthClass = health ? healthTone(health) : "";
  const healthScoreTone = health ? healthTone(health) : "";
  const wikiStatus = wikiPages.length > 0 ? `${wikiPages.length} pages` : (enableGdwiki ? "needs content" : "disabled");
  const memoryStatus = memoryEntries.length > 0 ? `${memoryEntries.length} entries` : (enableMemory ? "needs content" : "disabled");
  const healthSources = health?.sources.map((source) => `
            <tr class="health-row" data-search="${escapeHtml(`${source.source} ${source.status} ${source.findings}`)}">
              <td>${escapeHtml(source.source)}</td>
              <td><span class="pill ${sourceTone(source.status, source.required)}">${escapeHtml(source.status)}</span></td>
              <td>${metricBadge(source.findings, source.findings === 0 ? "good" : "warn")}</td>
              <td>${source.required ? "yes" : "no"}</td>
            </tr>`).join("") ?? "";
  const healthRiskRows = health?.riskByPriority.map((item) => `
            <tr class="health-row" data-search="${escapeHtml(`${item.priority} ${item.findings} ${item.weight} ${item.risk}`)}">
              <td>${escapeHtml(item.priority)}</td>
              <td>${metricBadge(item.findings, item.findings === 0 ? "good" : "warn")}</td>
              <td>${item.weight}</td>
              <td>${metricBadge(item.risk, riskTone(item.risk))}</td>
            </tr>`).join("") ?? "";
  const healthSourceRows = health?.findingsBySource.map((item) => `
            <tr class="health-row" data-search="${escapeHtml(`${item.source} ${item.findings}`)}">
              <td>${escapeHtml(item.source)}</td>
              <td>${metricBadge(item.findings, item.findings === 0 ? "good" : "warn")}</td>
            </tr>`).join("") ?? "";
  const healthWarnings = health?.dataQualityWarnings.map((warning) => `
            <div class="diag ${escapeHtml(warning.tone)}">${escapeHtml(warning.message)}</div>`).join("") ?? "";
  const healthPriorityRows = [
    ["P0", "Blocker", "Failing tests, TypeScript errors, critical/high dependency issues. Gate fails by default.", "Fix before merge/release."],
    ["P1", "High", "Serious lint/security/coverage signals. Usually not gate-blocking by default, but should be handled quickly.", "Fix in the current workstream."],
    ["P2", "Medium", "Maintainability and warning-level debt such as complexity over threshold.", "Prioritize by affected scope and churn."],
    ["P3", "Info", "Advisory signals and low-risk observations.", "Track or batch later."],
  ].map(([priority, meaning, examples, action]) => `
            <tr>
              <td>${priority}</td>
              <td>${meaning}</td>
              <td>${examples}</td>
              <td>${action}</td>
            </tr>`).join("");
  const healthActionItems = health ? healthRecommendedActions(health).map((item) => `
            <div class="fix ${escapeHtml(item.tone)}">
              <b>${escapeHtml(item.title)}</b>
              <p>${escapeHtml(item.detail)}</p>
              <code>${escapeHtml(item.command)}</code>
            </div>`).join("") : "";
  const healthScopes = health?.scopes.map((scope) => `
            <tr class="health-row" data-search="${escapeHtml(`${scope.name} ${scope.kind} ${scope.score} ${scope.findings} ${scope.risk} ${scope.complexity ?? ""}`)}">
              <td>${escapeHtml(scope.name)}</td>
              <td>${escapeHtml(scope.kind)}</td>
              <td>${metricBadge(scope.score, scoreTone(scope.score))}</td>
              <td>${metricBadge(scope.findings, scope.findings === 0 ? "good" : "warn")}</td>
              <td>${metricBadge(scope.risk, riskTone(scope.risk))}</td>
              <td>${metricBadge(scope.complexity ?? "-", complexityTone(scope.complexity))}</td>
            </tr>`).join("") ?? "";
  const healthFiles = health?.files.map((file) => `
            <tr class="health-row" data-search="${escapeHtml(`${file.name} ${file.score} ${file.findings} ${file.risk} ${file.complexity ?? ""}`)}">
              <td>${escapeHtml(file.name)}</td>
              <td>${metricBadge(file.score, scoreTone(file.score))}</td>
              <td>${metricBadge(file.findings, file.findings === 0 ? "good" : "warn")}</td>
              <td>${metricBadge(file.risk, riskTone(file.risk))}</td>
              <td>${metricBadge(file.complexity ?? "-", complexityTone(file.complexity))}</td>
            </tr>`).join("") ?? "";
  const graphRows = graph?.topModules.map((module) => `
            <tr>
              <td>${escapeHtml(module.name)}</td>
              <td>${module.files}</td>
              <td>${module.edges}</td>
            </tr>`).join("") ?? "";
  const wikiRows = wikiPages.map((page) => `
            <tr>
              <td><a href="${page.href}">${escapeHtml(page.title)}</a></td>
              <td>${escapeHtml(page.group)}</td>
              <td>${escapeHtml(page.href)}</td>
            </tr>`).join("");
  const memoryRows = memoryEntries.map((entry) => `
            <tr>
              <td><a href="${entry.href}">${escapeHtml(entry.title)}</a></td>
              <td>${escapeHtml(entry.group)}</td>
              <td>${escapeHtml(entry.href)}</td>
            </tr>`).join("");
  const healthSummary = health ? healthQualitySummary(health) : "No normalized health report has been collected yet.";
  const wikiEmpty = `<div class="empty-state">
            <b>Wiki has no curated pages yet</b>
            <p>Create architecture, domain, scenario, integration, or decision pages so agents can read product knowledge before scanning code.</p>
            <div class="action-grid">
              <code>gd-metapro wiki collect</code>
              <code>gd-metapro wiki new decision &lt;slug&gt;</code>
              <code>gd-metapro wiki index</code>
            </div>
          </div>`;
  const memoryEmpty = `<div class="empty-state">
            <b>Memory has no learned entries yet</b>
            <p>Ingest lessons from reviews, health reports, and task outcomes to keep recurring mistakes and constraints available as short context.</p>
            <div class="action-grid">
              <code>gd-metapro memory new lesson &lt;slug&gt;</code>
              <code>gd-metapro memory ingest --from-health .metaproject/data/health/artifacts/latest.json</code>
              <code>gd-metapro memory index</code>
            </div>
          </div>`;
  const attentionItems = buildDashboardAttention({
    enableGdgraph,
    enableGdskills,
    enableGdwiki,
    enableHealth,
    enableMemory,
    enableTesting,
    graph,
    health,
    memoryEntries,
    testing,
    wikiPages,
  });
  const attentionCards = attentionItems.map((item) => `
          <article class="attention-card ${item.tone}">
            <div>
              <b>${escapeHtml(item.title)}</b>
              <p>${escapeHtml(item.detail)}</p>
            </div>
            <code>${escapeHtml(item.command)}</code>
          </article>`).join("");

  const scoreValue = typeof health?.score === "number" ? health.score : null;
  const ringCirc = 289;
  const ringOffset = scoreValue === null ? String(ringCirc) : (ringCirc * (1 - scoreValue / 100)).toFixed(1);
  const ringTone = health ? (healthScoreTone || "info") : "muted";
  const navItems: Array<[string, string]> = [["Overview", "#top"]];
  navItems.push(["Attention", "#attention"]);
  if (enabledModules.length > 0) navItems.push(["Modules", "#modules"]);
  if (enableHealth) navItems.push(["Code Health", "#health"]);
  if (enableGdgraph) navItems.push(["Graph", "#graph"]);
  if (enableTesting) navItems.push(["Testing", "#testing"]);
  if (enableGdwiki) navItems.push(["Knowledge", "#wiki"]);
  if (enableMemory) navItems.push(["Memory", "#memory"]);
  if (enableTasks) navItems.push(["Tasks", "#tasks"]);

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Metaproject Dashboard</title>
  <style>
    :root {
      --bg:#0e131b; --panel:#161d29; --panel2:#1b2330; --line:#26303f;
      --ink:#e7edf5; --muted:#8b98ab; --faint:#5d6b7e;
      --accent:#6366f1; --good:#34d399; --warn:#fbbf24; --bad:#f87171;
      --good-bg:rgba(52,211,153,.12); --warn-bg:rgba(251,191,36,.12); --bad-bg:rgba(248,113,113,.12); --info-bg:rgba(99,102,241,.12);
      --radius:14px; --shadow:0 1px 0 rgba(255,255,255,.03), 0 10px 28px -14px rgba(0,0,0,.55);
    }
    html[data-theme="light"] {
      --bg:#f5f7fb; --panel:#ffffff; --panel2:#f0f3f9; --line:#e2e8f2;
      --ink:#1a2333; --muted:#5c6b82; --faint:#94a3b8;
      --good:#0f9d63; --warn:#b45309; --bad:#dc2626;
      --good-bg:#ecfdf5; --warn-bg:#fffbeb; --bad-bg:#fef2f2; --info-bg:#eef2ff;
      --shadow:0 1px 2px rgba(16,24,40,.04), 0 10px 28px -18px rgba(16,24,40,.28);
    }
    * { box-sizing: border-box; }
    body {
      margin:0; background:var(--bg); color:var(--ink);
      font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif;
      -webkit-font-smoothing:antialiased;
    }
    a { color:inherit; }
    .sr-only { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0); }
    .layout { display:grid; grid-template-columns:224px 1fr; min-height:100vh; }

    /* Sidebar */
    .side { position:sticky; top:0; align-self:start; height:100vh; overflow:auto;
      background:var(--panel); border-right:1px solid var(--line); padding:20px 14px; display:flex; flex-direction:column; gap:6px; }
    .brand { display:flex; align-items:center; gap:10px; padding:2px 6px 16px; }
    .brand .logo { width:28px; height:28px; border-radius:8px; background:linear-gradient(135deg,var(--accent),#8b5cf6); display:grid; place-items:center; color:#fff; font-weight:800; font-size:13px; }
    .brand b { font-size:14px; letter-spacing:.2px; }
    .brand span { display:block; font-size:11px; color:var(--faint); font-weight:500; }
    .nav { display:flex; flex-direction:column; gap:2px; }
    .nav a { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:9px; color:var(--muted); text-decoration:none; font-weight:500; font-size:13px; }
    .nav a .dot { width:7px; height:7px; border-radius:50%; background:var(--faint); flex:none; }
    .nav a:hover { color:var(--ink); background:var(--panel2); }
    .nav a:hover .dot { background:var(--accent); }
    .side-foot { margin-top:auto; padding-top:14px; border-top:1px solid var(--line); font-size:11px; color:var(--faint); }
    .side-foot code { display:block; color:var(--muted); background:var(--panel2); border:1px solid var(--line); padding:5px 8px; border-radius:7px; margin-top:6px; font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }

    /* Main */
    .main { padding:24px 30px 44px; min-width:0; max-width:1240px; }
    .topbar { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:20px; }
    .topbar h1 { margin:0; font-size:22px; letter-spacing:-.2px; }
    .topbar .sub { margin:4px 0 0; color:var(--muted); font-size:13px; }
    .toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
    .linkbtn { text-decoration:none; color:var(--muted); border:1px solid var(--line); background:var(--panel); padding:7px 11px; border-radius:9px; font-size:12px; font-weight:600; }
    .linkbtn:hover { color:var(--ink); border-color:var(--faint); }
    .toggle { cursor:pointer; }

    /* Hero */
    .hero { display:grid; grid-template-columns:auto 1fr; gap:20px; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:20px 22px; box-shadow:var(--shadow); margin-bottom:6px; }
    .ring { position:relative; width:112px; height:112px; flex:none; }
    .ring svg { transform:rotate(-90deg); }
    .ring .rc { stroke:var(--rc); }
    .ring.ring-good { --rc:var(--good); } .ring.ring-warn { --rc:var(--warn); } .ring.ring-bad { --rc:var(--bad); } .ring.ring-info { --rc:var(--accent); } .ring.ring-muted { --rc:var(--line); }
    .ring .val { position:absolute; inset:0; display:grid; place-items:center; text-align:center; }
    .ring .val b { font-size:28px; line-height:1; font-weight:800; }
    .ring .val span { font-size:10px; color:var(--muted); letter-spacing:.6px; }
    .heroinfo { display:flex; flex-direction:column; justify-content:center; gap:12px; min-width:0; }
    .gate { display:inline-flex; align-items:center; gap:8px; align-self:flex-start; padding:6px 12px; border-radius:999px; font-size:12px; font-weight:700; border:1px solid var(--line); color:var(--muted); background:var(--panel2); }
    .gate .g { width:7px; height:7px; border-radius:50%; background:var(--faint); }
    .gate.good { color:var(--good); background:var(--good-bg); border-color:transparent; } .gate.good .g { background:var(--good); }
    .gate.warn { color:var(--warn); background:var(--warn-bg); border-color:transparent; } .gate.warn .g { background:var(--warn); }
    .gate.bad { color:var(--bad); background:var(--bad-bg); border-color:transparent; } .gate.bad .g { background:var(--bad); }
    .kpis { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
    .kpi { background:var(--panel2); border:1px solid var(--line); border-radius:11px; padding:11px 13px; min-width:0; }
    .kpi b { display:block; font-size:19px; line-height:1; margin-bottom:4px; font-variant-numeric:tabular-nums; }
    .kpi span { font-size:11px; color:var(--muted); }
    .kpi.good b { color:var(--good); } .kpi.warn b { color:var(--warn); } .kpi.bad b { color:var(--bad); }

    /* Attention */
    .attention-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
    .attention-card { display:grid; grid-template-columns:minmax(0,1fr); gap:10px; background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--faint); border-radius:var(--radius); padding:14px; box-shadow:var(--shadow); }
    .attention-card.good { border-left-color:var(--good); } .attention-card.warn { border-left-color:var(--warn); } .attention-card.bad { border-left-color:var(--bad); }
    .attention-card b { display:block; margin-bottom:4px; font-size:13px; }
    .attention-card p { margin:0; color:var(--muted); font-size:12px; }
    .attention-card code { display:block; width:100%; overflow:auto; font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); background:var(--panel2); border:1px solid var(--line); border-radius:7px; padding:6px 8px; }

    /* Sections */
    .sec { scroll-margin-top:20px; margin-top:26px; }
    .sec-h { display:flex; align-items:center; gap:10px; margin:0 2px 14px; }
    .sec-h h2 { margin:0; font-size:15px; font-weight:700; }
    .sec-h .count { font-size:11px; color:var(--muted); background:var(--panel2); border:1px solid var(--line); padding:1px 8px; border-radius:999px; }
    .sec-h .rule { flex:1; height:1px; background:var(--line); }

    /* Cards */
    .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:12px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:16px; position:relative; overflow:hidden; transition:transform .12s ease,border-color .12s ease; outline:none; }
    .card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--c); }
    .card:hover, .card:focus-visible { transform:translateY(-2px); border-color:var(--c); }
    .card-head { display:flex; align-items:center; gap:9px; margin-bottom:9px; }
    .card-ic { width:27px; height:27px; border-radius:8px; display:grid; place-items:center; font-size:15px; background:color-mix(in srgb, var(--c) 18%, transparent); }
    .card-name { font-size:14px; font-weight:700; }
    .card-role { margin-left:auto; font-size:10px; color:var(--muted); border:1px solid var(--line); padding:2px 8px; border-radius:999px; }
    .card p { margin:0 0 12px; color:var(--muted); font-size:12px; line-height:1.5; }
    .card-links { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
    .card-links a { font-size:11px; color:var(--ink); text-decoration:none; background:var(--panel2); border:1px solid var(--line); padding:4px 8px; border-radius:7px; }
    .card-links a:hover { border-color:var(--c); }
    .card-cmds { display:grid; gap:5px; }
    .card-cmds code { font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); background:var(--panel2); border:1px solid var(--line); border-radius:7px; padding:5px 8px; overflow-x:auto; }

    /* Panels + tables */
    .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:14px; align-items:start; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow); min-width:0; }
    .panel h3 { margin:16px 0 8px; font-size:12px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
    .panel h3:first-of-type { margin-top:4px; }
    .table-tools { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin:10px 0 12px; }
    .table-tools input { width:min(360px,100%); color:var(--ink); background:var(--panel2); border:1px solid var(--line); border-radius:9px; padding:8px 10px; font:13px/1.4 inherit; outline:none; }
    .table-tools input:focus { border-color:var(--accent); }
    .table-tools span { color:var(--muted); font-size:12px; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:10px; }
    table { width:100%; border-collapse:collapse; min-width:420px; font-size:13px; }
    th { text-align:left; padding:9px 12px; color:var(--muted); font-weight:600; font-size:11px; letter-spacing:.4px; text-transform:uppercase; background:var(--panel2); border-bottom:1px solid var(--line); white-space:nowrap; }
    th button { all:unset; cursor:pointer; color:inherit; display:inline-flex; align-items:center; gap:5px; }
    th button::after { content:"↕"; color:var(--faint); font-size:10px; }
    td { padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:middle; }
    tbody tr:last-child td { border-bottom:0; }
    tbody tr:hover { background:var(--panel2); }
    td a { color:var(--ink); text-decoration:none; border-bottom:1px solid var(--line); }
    td a:hover { border-color:var(--accent); }
    .pill { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:999px; font-size:11px; font-weight:600; color:var(--muted); background:var(--panel2); white-space:nowrap; }
    .pill.good { color:var(--good); background:var(--good-bg); } .pill.warn { color:var(--warn); background:var(--warn-bg); } .pill.bad { color:var(--bad); background:var(--bad-bg); }
    .metric { display:inline-flex; align-items:center; justify-content:center; min-width:34px; padding:2px 8px; border-radius:8px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--ink); background:var(--panel2); border:1px solid var(--line); }
    .metric.good { color:var(--good); background:var(--good-bg); border-color:transparent; } .metric.warn { color:var(--warn); background:var(--warn-bg); border-color:transparent; } .metric.bad { color:var(--bad); background:var(--bad-bg); border-color:transparent; }
    .note { display:grid; gap:5px; margin:0 0 14px; padding:12px 14px; border:1px solid var(--line); border-radius:10px; background:var(--panel2); }
    .note b { font-size:12px; } .note p { margin:0; color:var(--muted); font-size:12px; }
    .health-explain { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; margin:0 0 14px; }
    .health-explain > div { border:1px solid var(--line); border-radius:10px; background:var(--panel2); padding:12px; min-width:0; }
    .health-explain h3 { margin:0 0 6px; }
    .health-explain p { margin:0 0 10px; color:var(--muted); font-size:12px; }
    .table-wrap.compact { margin-top:8px; }
    .table-wrap.compact table { min-width:320px; font-size:12px; }
    .diag { border:1px solid var(--line); border-radius:9px; padding:9px 10px; margin:0 0 8px; color:var(--muted); background:var(--panel); font-size:12px; }
    .diag.good { color:var(--good); background:var(--good-bg); border-color:transparent; }
    .diag.warn { color:var(--warn); background:var(--warn-bg); border-color:transparent; }
    .diag.bad { color:var(--bad); background:var(--bad-bg); border-color:transparent; }
    .fix { display:grid; gap:5px; border:1px solid var(--line); border-left:3px solid var(--faint); border-radius:9px; padding:10px 11px; margin:0 0 8px; background:var(--panel); }
    .fix.good { border-left-color:var(--good); } .fix.warn { border-left-color:var(--warn); } .fix.bad { border-left-color:var(--bad); }
    .fix b { font-size:12px; }
    .fix p { margin:0; color:var(--muted); font-size:12px; }
    .fix code { display:block; width:100%; overflow:auto; font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); background:var(--panel2); border:1px solid var(--line); border-radius:7px; padding:5px 8px; }
    .empty { color:var(--muted); border:1px dashed var(--line); border-radius:10px; padding:16px; background:var(--panel2); font-size:13px; }
    .empty code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--ink); }
    .empty-state { display:grid; gap:10px; color:var(--muted); border:1px dashed var(--line); border-radius:10px; padding:16px; background:var(--panel2); }
    .empty-state b { color:var(--ink); } .empty-state p { margin:0; font-size:12px; }
    .action-grid { display:grid; gap:6px; }
    .action-grid code, .empty-state code { font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); background:var(--panel); border:1px solid var(--line); border-radius:7px; padding:5px 8px; overflow-x:auto; }

    /* Workflow */
    .workflow { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
    .step { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:14px; }
    .step .n { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:7px; background:var(--info-bg); color:var(--accent); font-weight:800; font-size:12px; margin-bottom:8px; }
    .step b { display:block; margin-bottom:5px; font-size:13px; }
    .step p { margin:0; color:var(--muted); font-size:12px; line-height:1.5; }

    .disabled { display:flex; gap:8px; flex-wrap:wrap; }
    .disabled span { color:var(--faint); border:1px dashed var(--line); border-radius:999px; padding:5px 11px; font-size:12px; }

    @media (max-width: 820px) {
      .layout { grid-template-columns:1fr; }
      .side { position:static; height:auto; flex-direction:row; flex-wrap:wrap; align-items:center; }
      .brand { padding-bottom:0; }
      .nav { flex-direction:row; flex-wrap:wrap; }
      .side-foot { display:none; }
      .main { padding:20px 18px 40px; }
      .hero { grid-template-columns:1fr; justify-items:start; }
      .kpis { grid-template-columns:repeat(2,1fr); }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="side">
      <div class="brand">
        <div class="logo">gd</div>
        <div><b>Metaproject</b><span>${enabledModules.length} modules</span></div>
      </div>
      <nav class="nav" aria-label="Sections">
        ${navItems.map(([label, href]) => `<a href="${href}"><span class="dot"></span>${label}</a>`).join("")}
      </nav>
      <div class="side-foot">
        Stale data? Refresh:
        <code>gd-metapro update</code>
        <code>gd-metapro health run</code>
      </div>
    </aside>

    <main class="main" id="top">
      <div class="topbar">
        <div>
          <h1>Metaproject Dashboard</h1>
          <p class="sub">Read-only control surface for agent context, health, graph, testing, and knowledge.</p>
        </div>
        <div class="toolbar" aria-label="Primary links">
          ${primaryLinks.map(([label, href]) => `<a class="linkbtn" href="${href}">${label}</a>`).join("")}
          <button class="linkbtn toggle" type="button" onclick="__gdmToggle()" aria-label="Toggle theme">◐ Theme</button>
        </div>
      </div>

      <section class="hero" aria-label="Overview">
        <div class="ring ring-${ringTone}">
          <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label="Health score ${scoreValue ?? "unavailable"}">
            <circle cx="56" cy="56" r="46" fill="none" stroke="var(--line)" stroke-width="9"></circle>
            <circle class="rc" cx="56" cy="56" r="46" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${ringCirc}" stroke-dashoffset="${ringOffset}"></circle>
          </svg>
          <div class="val"><div><b>${health?.score ?? "—"}</b><span>HEALTH</span></div></div>
        </div>
        <div class="heroinfo">
          <span class="gate ${healthClass}"><span class="g"></span>${health ? escapeHtml(health.status) : (enableHealth ? "no report yet" : "health disabled")}${health ? ` gate · ${health.findings} finding(s)` : ""}</span>
          <div class="kpis">
            <div class="kpi ${health ? (health.findings === 0 ? "good" : "warn") : ""}"><b>${health?.findings ?? "—"}</b><span>findings</span></div>
            <div class="kpi"><b>${graph ? graph.files : "—"}</b><span>graph files</span></div>
            <div class="kpi"><b>${wikiPages.length || "—"}</b><span>wiki pages</span></div>
            <div class="kpi"><b>${memoryEntries.length || "—"}</b><span>memory entries</span></div>
          </div>
        </div>
      </section>

      <section class="sec" id="attention">
        <div class="sec-h"><h2>What needs attention</h2><span class="count">${attentionItems.length} signal${attentionItems.length === 1 ? "" : "s"}</span><span class="rule"></span></div>
        <div class="attention-grid">
${attentionCards}
        </div>
      </section>

      <section class="sec" id="modules">
        <div class="sec-h"><h2>Modules</h2><span class="count">${enabledModules.length} enabled</span><span class="rule"></span></div>
        <div class="cards">
${cards || "          <p class=\"empty\">No modules enabled.</p>"}
        </div>
      </section>

      ${enableTasks ? `<section class="sec" id="tasks">
        <div class="sec-h"><h2>Tasks</h2><span class="count">${flows.length} flow(s)</span><span class="rule"></span></div>
        ${flows.length > 0 ? `<div class="panel"><div class="table-wrap"><table>
          <thead><tr><th>Flow</th><th>Status</th><th>Tasks</th><th>AC</th><th>PR</th></tr></thead>
          <tbody>${flowRows}</tbody>
        </table></div></div>` : `<div class="empty">No flows yet. Start one: <code>gd-metapro flow init --title "..."</code>.</div>`}
      </section>` : ""}

      <section class="sec" id="health">
        <div class="sec-h"><h2>Code Health</h2><span class="count">${qualityStatus}</span><span class="rule"></span></div>
        <div class="panel">
          ${health ? `
          <div class="note"><b>Score is contextual</b><p>${healthSummary}</p></div>
          <div class="kpis" style="margin-bottom:14px">
            <div class="kpi ${healthScoreTone}"><b>${health.score}</b><span>score</span></div>
            <div class="kpi"><b><span class="pill ${healthClass}">${escapeHtml(health.status)}</span></b><span>gate</span></div>
            <div class="kpi ${health.findings === 0 ? "good" : "warn"}"><b>${health.findings}</b><span>findings</span></div>
            <div class="kpi ${health.p0 > 0 ? "bad" : (health.p1 > 0 || health.p2 > 0 ? "warn" : "good")}"><b>${health.p0}/${health.p1}/${health.p2}</b><span>P0 / P1 / P2</span></div>
            <div class="kpi ${riskTone(health.risk)}"><b>${health.risk}</b><span>risk</span></div>
            <div class="kpi ${complexityTone(health.complexityMax)}"><b>${health.complexityMax}</b><span>max complexity</span></div>
            <div class="kpi"><b>${health.loc}</b><span>LOC</span></div>
            <div class="kpi ${health.findingsWithoutFile > 0 ? "warn" : "good"}"><b>${health.findingsWithoutFile}</b><span>unmapped findings</span></div>
          </div>
          <div class="health-explain">
            <div>
              <h3>Why this score?</h3>
              <p>Formula: risk = P0*100 + P1*20 + P2*5 + P3*1. Score = clamp(100 - ((risk + coverage penalty + complexity penalty) * 1000 / max(LOC, 1000)), 0, 100). Gate is stricter than score and can fail on blockers even when module scores look high.</p>
              <div class="table-wrap compact"><table data-gdm-table="health-risk">
                <thead><tr><th><button type="button" data-sort-col="0">Priority</button></th><th><button type="button" data-sort-col="1">Findings</button></th><th><button type="button" data-sort-col="2">Weight</button></th><th><button type="button" data-sort-col="3">Risk</button></th></tr></thead>
                <tbody>${healthRiskRows || `<tr><td colspan="4">No risk rows.</td></tr>`}</tbody>
              </table></div>
            </div>
            <div>
              <h3>What to fix first</h3>
              ${healthActionItems || `<div class="fix good"><b>No immediate action</b><p>No blocking or warning-level action was inferred from the latest report.</p><code>gd-metapro health status</code></div>`}
            </div>
          </div>
          <div class="health-explain">
            <div>
              <h3>Priority legend</h3>
              <div class="table-wrap compact"><table>
                <thead><tr><th>Priority</th><th>Meaning</th><th>Typical signals</th><th>Default action</th></tr></thead>
                <tbody>${healthPriorityRows}</tbody>
              </table></div>
            </div>
            <div>
              <h3>Report diagnostics</h3>
              ${healthWarnings || `<div class="diag good">No report-quality warnings detected.</div>`}
              <div class="table-wrap compact"><table data-gdm-table="health-source-breakdown">
                <thead><tr><th><button type="button" data-sort-col="0">Finding source</button></th><th><button type="button" data-sort-col="1">Findings</button></th></tr></thead>
                <tbody>${healthSourceRows || `<tr><td colspan="2">No finding source rows.</td></tr>`}</tbody>
              </table></div>
            </div>
          </div>
          <div class="table-tools">
            <input id="gdmHealthFilter" type="search" placeholder="Filter health tables by file, scope, source, score..." aria-label="Filter health tables">
            <span>Click table headings to sort visible rows.</span>
          </div>
          <h3>Top scopes</h3>
          <div class="table-wrap"><table data-gdm-table="health-scopes">
            <thead><tr><th><button type="button" data-sort-col="0">Scope</button></th><th><button type="button" data-sort-col="1">Kind</button></th><th><button type="button" data-sort-col="2">Score</button></th><th><button type="button" data-sort-col="3">Findings</button></th><th><button type="button" data-sort-col="4">Risk</button></th><th><button type="button" data-sort-col="5">Complexity</button></th></tr></thead>
            <tbody>${healthScopes || `<tr><td colspan="6">No scope metrics.</td></tr>`}</tbody>
          </table></div>
          <h3>Top files</h3>
          <div class="table-wrap"><table data-gdm-table="health-files">
            <thead><tr><th><button type="button" data-sort-col="0">File</button></th><th><button type="button" data-sort-col="1">Score</button></th><th><button type="button" data-sort-col="2">Findings</button></th><th><button type="button" data-sort-col="3">Risk</button></th><th><button type="button" data-sort-col="4">Complexity</button></th></tr></thead>
            <tbody>${healthFiles || `<tr><td colspan="5">No file-level metrics in latest report.</td></tr>`}</tbody>
          </table></div>
          <h3>Sources</h3>
          <div class="table-wrap"><table data-gdm-table="health-sources">
            <thead><tr><th><button type="button" data-sort-col="0">Source</button></th><th><button type="button" data-sort-col="1">Status</button></th><th><button type="button" data-sort-col="2">Findings</button></th><th><button type="button" data-sort-col="3">Required</button></th></tr></thead>
            <tbody>${healthSources}</tbody>
          </table></div>` : `<div class="empty">No health report found. Run <code>gd-metapro health run</code>.</div>`}
        </div>
      </section>

      <section class="sec" id="graph">
        <div class="sec-h"><h2>Graph</h2><span class="count">${graphStatus}</span><span class="rule"></span></div>
        <div class="panel">
          ${graph ? `
          <div class="kpis" style="margin-bottom:14px">
            <div class="kpi"><b>${graph.files}</b><span>files</span></div>
            <div class="kpi"><b>${graph.assets}</b><span>assets</span></div>
            <div class="kpi"><b>${graph.edges}</b><span>edges</span></div>
            <div class="kpi ${graph.unresolved > 0 ? "warn" : "good"}"><b>${graph.unresolved}</b><span>unresolved</span></div>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Module</th><th>Files</th><th>Outgoing edges</th></tr></thead>
            <tbody>${graphRows || `<tr><td colspan="3">No module graph rows.</td></tr>`}</tbody>
          </table></div>` : `<div class="empty">No graph storage found. Run <code>gd-metapro gdgraph build</code>.</div>`}
        </div>
      </section>

      <section class="sec">
        <div class="sec-h"><h2>Testing &amp; Knowledge</h2><span class="rule"></span></div>
        <div class="grid2">
          <div class="panel" id="testing">
            <h3 style="margin-top:0">Testing</h3>
            ${testing ? `
            <div class="kpis">
              <div class="kpi"><b style="font-size:14px">${escapeHtml(testing.status)}</b><span>status</span></div>
              <div class="kpi"><b style="font-size:14px">${testing.runner ? escapeHtml(testing.runner) : "—"}</b><span>runner</span></div>
              <div class="kpi"><b>${testing.tests ?? "—"}</b><span>tests</span></div>
              <div class="kpi ${testing.failures ? "bad" : "good"}"><b>${testing.failures ?? "—"}</b><span>failures</span></div>
            </div>
            <div class="card-links" style="margin-top:12px">
              ${testing.contextHref ? `<a href="${testing.contextHref}">Testing context</a>` : ""}
              ${testing.reportHref ? `<a href="${testing.reportHref}">Latest report</a>` : ""}
            </div>` : `<div class="empty">No testing context/report found. Run <code>gd-metapro test analyze</code>.</div>`}
          </div>
          <div class="panel" id="wiki">
            <h3 style="margin-top:0">Wiki <span style="color:var(--faint);font-weight:500;text-transform:none;letter-spacing:0">· ${wikiStatus}</span></h3>
            ${wikiRows ? `<div class="table-wrap"><table><thead><tr><th>Page</th><th>Group</th><th>Path</th></tr></thead><tbody>${wikiRows}</tbody></table></div>` : wikiEmpty}
          </div>
          <div class="panel" id="memory">
            <h3 style="margin-top:0">Memory <span style="color:var(--faint);font-weight:500;text-transform:none;letter-spacing:0">· ${memoryStatus}</span></h3>
            ${memoryRows ? `<div class="table-wrap"><table><thead><tr><th>Entry</th><th>Group</th><th>Path</th></tr></thead><tbody>${memoryRows}</tbody></table></div>` : memoryEmpty}
          </div>
        </div>
      </section>

      <section class="sec">
        <div class="sec-h"><h2>Agent Workflow</h2><span class="rule"></span></div>
        <div class="workflow">
          <div class="step"><span class="n">1</span><b>Route</b><p>Start from index.md and select the module or skill that owns the question.</p></div>
          <div class="step"><span class="n">2</span><b>Navigate</b><p>Use gdgraph for related files, affected context, cycles, and boundaries.</p></div>
          <div class="step"><span class="n">3</span><b>Compress</b><p>Use gdctx before loading large search output, diffs, logs, or long files.</p></div>
          <div class="step"><span class="n">4</span><b>Verify</b><p>Read testing and health reports before claiming quality or gate status.</p></div>
          <div class="step"><span class="n">5</span><b>Learn</b><p>Write decisions and lessons to wiki, memory, and project skills.</p></div>
        </div>
      </section>

      <section class="sec">
        <div class="sec-h"><h2>Disabled modules</h2><span class="rule"></span></div>
        <div class="disabled">${disabled || "<span>none</span>"}</div>
      </section>
    </main>
  </div>

  <div class="modal" id="gdmModal" hidden>
    <div class="modal-backdrop" onclick="__gdmCloseDoc()"></div>
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="Document viewer">
      <div class="modal-head">
        <span class="modal-title" id="gdmModalTitle"></span>
        <div class="modal-actions">
          <a class="modal-raw" id="gdmModalRaw" href="#" title="Open the raw file">raw ↗</a>
          <button class="modal-x" type="button" onclick="__gdmCloseDoc()" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="modal-body markdown" id="gdmModalBody"></div>
    </div>
  </div>
  <style>
    .modal[hidden] { display:none; }
    .modal { position:fixed; inset:0; z-index:50; display:grid; place-items:center; padding:24px; }
    .modal-backdrop { position:absolute; inset:0; background:rgba(4,8,14,.62); }
    .modal-card { position:relative; width:min(820px,100%); max-height:86vh; display:flex; flex-direction:column; background:var(--panel); border:1px solid var(--line); border-radius:16px; box-shadow:0 24px 60px -20px rgba(0,0,0,.6); overflow:hidden; }
    .modal-head { display:flex; align-items:center; gap:12px; padding:13px 18px; border-bottom:1px solid var(--line); background:var(--panel2); }
    .modal-title { font-weight:700; font-size:13px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,Menlo,monospace; color:var(--muted); }
    .modal-actions { display:flex; align-items:center; gap:9px; }
    .modal-raw { font-size:12px; color:var(--muted); text-decoration:none; border:1px solid var(--line); padding:4px 9px; border-radius:8px; }
    .modal-raw:hover { color:var(--ink); }
    .modal-x { cursor:pointer; background:none; border:1px solid var(--line); color:var(--muted); width:28px; height:28px; border-radius:8px; font-size:12px; }
    .modal-x:hover { color:var(--ink); }
    .modal-body { padding:22px 26px; overflow:auto; }
    .markdown { font-size:14px; line-height:1.65; color:var(--ink); }
    .markdown > *:first-child { margin-top:0; }
    .markdown h1 { font-size:20px; margin:.3em 0 .5em; }
    .markdown h2 { font-size:16px; margin:1.3em 0 .5em; padding-bottom:.3em; border-bottom:1px solid var(--line); }
    .markdown h3 { font-size:13px; margin:1.1em 0 .4em; color:var(--muted); text-transform:uppercase; letter-spacing:.4px; }
    .markdown p { margin:.6em 0; color:var(--muted); }
    .markdown ul, .markdown ol { margin:.5em 0; padding-left:1.4em; color:var(--muted); }
    .markdown li { margin:.25em 0; }
    .markdown a { color:var(--accent); text-decoration:none; }
    .markdown a:hover { text-decoration:underline; }
    .markdown code { font-family:ui-monospace,Menlo,monospace; font-size:.88em; background:var(--panel2); border:1px solid var(--line); border-radius:5px; padding:.1em .35em; color:var(--ink); }
    .markdown pre { background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:12px 14px; overflow:auto; margin:.8em 0; }
    .markdown pre code { background:none; border:0; padding:0; font-size:12px; }
    .markdown strong { color:var(--ink); }
    .markdown blockquote { margin:.6em 0; padding:.3em 0 .3em 12px; border-left:3px solid var(--line); color:var(--faint); }
  </style>
  <script id="gdm-docs" type="application/json">${docsJson}</script>
  <script>
    (function () {
      var root = document.documentElement;
      var KEY = "gdm-theme";
      try {
        var saved = localStorage.getItem(KEY);
        if (saved) { root.setAttribute("data-theme", saved); }
      } catch (e) {}
      window.__gdmToggle = function () {
        var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
        root.setAttribute("data-theme", next);
        try { localStorage.setItem(KEY, next); } catch (e) {}
      };
    })();
    (function () {
      var healthFilter = document.getElementById("gdmHealthFilter");
      function filterHealthRows() {
        var q = (healthFilter && healthFilter.value ? healthFilter.value : "").toLowerCase().trim();
        document.querySelectorAll("#health tr.health-row").forEach(function (row) {
          var haystack = (row.getAttribute("data-search") || row.textContent || "").toLowerCase();
          row.hidden = q.length > 0 && haystack.indexOf(q) === -1;
        });
      }
      if (healthFilter) {
        healthFilter.addEventListener("input", filterHealthRows);
      }
      function cellValue(row, col) {
        var cell = row.children[col];
        var text = cell ? (cell.textContent || "").trim() : "";
        var num = Number(text.replace(/[^0-9.-]/g, ""));
        return Number.isFinite(num) && /[0-9]/.test(text) ? num : text.toLowerCase();
      }
      document.addEventListener("click", function (e) {
        var target = e.target;
        var btn = target && target.closest ? target.closest("[data-sort-col]") : null;
        if (!btn) return;
        var table = btn.closest("table");
        var tbody = table && table.querySelector("tbody");
        if (!tbody) return;
        var col = Number(btn.getAttribute("data-sort-col") || "0");
        var dir = btn.getAttribute("data-sort-dir") === "asc" ? "desc" : "asc";
        table.querySelectorAll("[data-sort-dir]").forEach(function (item) {
          item.removeAttribute("data-sort-dir");
        });
        btn.setAttribute("data-sort-dir", dir);
        var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
        rows.sort(function (a, b) {
          var av = cellValue(a, col);
          var bv = cellValue(b, col);
          var cmp = typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv));
          return dir === "asc" ? cmp : -cmp;
        });
        rows.forEach(function (row) {
          tbody.appendChild(row);
        });
        filterHealthRows();
      });
    })();
    (function () {
      var docs = {};
      try { docs = JSON.parse(document.getElementById("gdm-docs").textContent || "{}"); } catch (e) {}
      var BT = String.fromCharCode(96);
      var fence = BT + BT + BT;
      var codeRe = new RegExp(BT + "([^" + BT + "]+)" + BT, "g");
      function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
      function inline(s) {
        return s
          .replace(codeRe, function (_, c) { return "<code>" + esc(c) + "</code>"; })
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, u) { return "<a href='" + u + "'>" + t + "</a>"; });
      }
      function render(md) {
        var lines = String(md).replace(/\r\n/g, "\n").split("\n");
        var out = [], inCode = false, list = null;
        function closeList() { if (list) { out.push("</" + list + ">"); list = null; } }
        for (var i = 0; i < lines.length; i++) {
          var ln = lines[i];
          if (ln.slice(0, 3) === fence) {
            if (inCode) { out.push("</code></pre>"); inCode = false; }
            else { closeList(); out.push("<pre><code>"); inCode = true; }
            continue;
          }
          if (inCode) { out.push(esc(ln) + "\n"); continue; }
          var h = ln.match(/^(#{1,3})\s+(.*)$/);
          if (h) { closeList(); var n = h[1].length; out.push("<h" + n + ">" + inline(esc(h[2])) + "</h" + n + ">"); continue; }
          var ul = ln.match(/^\s*[-*]\s+(.*)$/);
          if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(esc(ul[1])) + "</li>"); continue; }
          var ol = ln.match(/^\s*\d+\.\s+(.*)$/);
          if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(esc(ol[1])) + "</li>"); continue; }
          var bq = ln.match(/^>\s?(.*)$/);
          if (bq) { closeList(); out.push("<blockquote>" + inline(esc(bq[1])) + "</blockquote>"); continue; }
          if (ln.trim() === "") { closeList(); continue; }
          closeList(); out.push("<p>" + inline(esc(ln)) + "</p>");
        }
        if (inCode) out.push("</code></pre>");
        closeList();
        return out.join("");
      }
      var modal = document.getElementById("gdmModal");
      var body = document.getElementById("gdmModalBody");
      var titleEl = document.getElementById("gdmModalTitle");
      var rawEl = document.getElementById("gdmModalRaw");
      window.__gdmCloseDoc = function () { modal.hidden = true; };
      function openDoc(href) {
        body.innerHTML = render(docs[href] || "");
        titleEl.textContent = href;
        rawEl.setAttribute("href", href);
        modal.hidden = false;
        body.scrollTop = 0;
      }
      document.addEventListener("click", function (e) {
        var a = e.target.closest ? e.target.closest("a") : null;
        if (!a) return;
        var href = a.getAttribute("href");
        if (href && Object.prototype.hasOwnProperty.call(docs, href)) { e.preventDefault(); openDoc(href); }
      });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") { modal.hidden = true; } });
    })();
  </script>
</body>
</html>
`;
}

type DashboardAttentionItem = {
  tone: "good" | "warn" | "bad";
  title: string;
  detail: string;
  command: string;
};

function buildDashboardAttention({
  enableGdgraph,
  enableGdskills,
  enableGdwiki,
  enableHealth,
  enableMemory,
  enableTesting,
  graph,
  health,
  memoryEntries,
  testing,
  wikiPages,
}: {
  enableGdgraph: boolean;
  enableGdskills: boolean;
  enableGdwiki: boolean;
  enableHealth: boolean;
  enableMemory: boolean;
  enableTesting: boolean;
  graph: MetaprojectDashboardData["graph"] | undefined;
  health: MetaprojectDashboardData["health"] | undefined;
  memoryEntries: Array<{ title: string; href: string; group: string; content?: string }>;
  testing: MetaprojectDashboardData["testing"] | undefined;
  wikiPages: Array<{ title: string; href: string; group: string; content?: string }>;
}): DashboardAttentionItem[] {
  const items: DashboardAttentionItem[] = [];

  if (enableHealth && !health) {
    items.push({
      tone: "warn",
      title: "Code Health report is missing",
      detail: "Quality gates and file scores are unavailable until a health report is generated.",
      command: "gd-metapro health run",
    });
  } else if (health && (health.status === "fail" || health.p0 > 0)) {
    items.push({
      tone: "bad",
      title: "Code Health gate is failing",
      detail: `${health.p0} P0 finding(s), ${health.findings} finding(s) total. Resolve blockers before trusting the project score.`,
      command: "gd-metapro health explain <file>",
    });
  } else if (health && (health.status === "warn" || health.findings > 0)) {
    items.push({
      tone: "warn",
      title: "Code Health has active findings",
      detail: `Score ${health.score} still has ${health.findings} finding(s). Review top files and sources.`,
      command: "gd-metapro health status",
    });
  }

  const missingRequired = health?.sources.filter((source) => source.required && source.status === "missing") ?? [];
  if (missingRequired.length > 0) {
    items.push({
      tone: "bad",
      title: "Required health source is missing",
      detail: `Missing: ${missingRequired.map((source) => source.source).join(", ")}.`,
      command: "gd-metapro health sources",
    });
  }

  if (enableGdgraph && !graph) {
    items.push({
      tone: "warn",
      title: "Graph storage is missing",
      detail: "Project navigation and affected-context queries need a built graph.",
      command: "gd-metapro gdgraph build",
    });
  } else if (graph && graph.unresolved > 0) {
    items.push({
      tone: "warn",
      title: "Graph has unresolved imports",
      detail: `${graph.unresolved} unresolved edge(s) can reduce affected-context precision.`,
      command: "gd-metapro gdgraph query orphans",
    });
  }

  if (enableTesting && !testing) {
    items.push({
      tone: "warn",
      title: "Testing context is missing",
      detail: "Agents need the testing context before creating or changing tests.",
      command: "gd-metapro test analyze",
    });
  } else if (testing && (testing.failures ?? 0) > 0) {
    items.push({
      tone: "bad",
      title: "Latest test report has failures",
      detail: `${testing.failures} failing test(s) in the normalized testing report.`,
      command: "gd-metapro test report",
    });
  }

  if (enableGdwiki && wikiPages.length === 0) {
    items.push({
      tone: "warn",
      title: "Wiki has no curated pages",
      detail: "Generate draft knowledge pages so agents can use architecture and domain context before broad code reads.",
      command: "gd-metapro wiki collect",
    });
  }

  if (enableMemory && memoryEntries.length === 0) {
    items.push({
      tone: "warn",
      title: "Memory has no accepted lessons",
      detail: "Long-lived project lessons and decisions are not yet available to agents.",
      command: "gd-metapro memory ingest --from-health .metaproject/data/health/artifacts/latest.json",
    });
  }

  if (!enableGdskills) {
    items.push({
      tone: "warn",
      title: "gdskills is disabled",
      detail: "Project-local working skills and orchestrators are not installed for agents.",
      command: "gd-metapro modules enable gdskills",
    });
  }

  if (items.length === 0) {
    items.push({
      tone: "good",
      title: "Visible signals look current",
      detail: "Enabled modules have dashboard data and no blocking attention signals were detected.",
      command: "gd-metapro status",
    });
  }

  return items.slice(0, 8);
}

function healthRecommendedActions(
  health: NonNullable<MetaprojectDashboardData["health"]>,
): Array<{ tone: string; title: string; detail: string; command: string }> {
  const actions: Array<{ tone: string; title: string; detail: string; command: string }> = [];
  const topScope = health.scopes[0];
  const topFile = health.files[0];
  const tests = health.sources.find((source) => source.source === "tests");
  const coverage = health.sources.find((source) => source.source === "coverage");

  if (health.p0 > 0) {
    actions.push({
      tone: "bad",
      title: "Fix P0 blockers first",
      detail: `${health.p0} blocker finding(s) are present. Gate is expected to fail until these are resolved.`,
      command: topFile ? `gd-metapro health explain ${topFile.name}` : "gd-metapro health run",
    });
  } else if (health.p1 > 0) {
    actions.push({
      tone: "warn",
      title: "Clear high-priority P1 findings",
      detail: `${health.p1} high-priority finding(s) remain. They may not fail the gate by default, but should be handled before expanding scope.`,
      command: topFile ? `gd-metapro health explain ${topFile.name}` : "gd-metapro health status",
    });
  }

  if (health.p2 > 0 && topScope) {
    actions.push({
      tone: "warn",
      title: `Reduce complexity in ${topScope.name}`,
      detail: `${topScope.findings} finding(s), risk ${topScope.risk}. Start with the top files table and split branch-heavy functions into smaller helpers.`,
      command: `gd-metapro health explain ${topScope.name}`,
    });
  }

  if (topFile) {
    actions.push({
      tone: topFile.risk >= 50 ? "bad" : "warn",
      title: "Inspect the highest-risk file",
      detail: `${topFile.name} has ${topFile.findings} finding(s), risk ${topFile.risk}, max complexity ${topFile.complexity ?? "-"}.`,
      command: `gd-metapro health explain ${topFile.name}`,
    });
  }

  if (tests && tests.status === "missing") {
    actions.push({
      tone: "warn",
      title: "Connect testing evidence",
      detail: "The health report did not import or run a compatible testing report, so the score does not prove tests are green.",
      command: "gd-metapro test run && gd-metapro health run",
    });
  }

  if (coverage && coverage.status === "missing") {
    actions.push({
      tone: "warn",
      title: "Connect coverage evidence",
      detail: "Coverage is missing, so the score does not reflect test coverage risk.",
      command: "gd-metapro health sources",
    });
  }

  return actions.slice(0, 5);
}

function metricBadge(value: number | string, tone: string): string {
  return `<span class="metric ${tone}">${escapeHtml(String(value))}</span>`;
}

function healthTone(health: NonNullable<MetaprojectDashboardData["health"]>): string {
  if (health.status === "fail" || health.p0 > 0) {
    return "bad";
  }
  if (health.status === "warn" || health.p1 > 0 || health.findings > 0) {
    return "warn";
  }
  return scoreTone(health.score);
}

function scoreTone(score: number | string | undefined): string {
  if (typeof score !== "number") {
    return "";
  }
  if (score < 60) {
    return "bad";
  }
  if (score < 90) {
    return "warn";
  }
  return "good";
}

function riskTone(risk: number | string | undefined): string {
  if (typeof risk !== "number") {
    return "";
  }
  if (risk >= 50) {
    return "bad";
  }
  if (risk > 0) {
    return "warn";
  }
  return "good";
}

function complexityTone(complexity: number | string | undefined): string {
  if (typeof complexity !== "number") {
    return "";
  }
  if (complexity > 20) {
    return "bad";
  }
  if (complexity > 10) {
    return "warn";
  }
  return "good";
}

function sourceTone(status: string, required: boolean): string {
  if (status === "available" || status === "skipped") {
    return status === "available" ? "good" : "";
  }
  if (status === "missing" && required) {
    return "bad";
  }
  if (status === "missing") {
    return "warn";
  }
  return "";
}

function healthQualitySummary(health: NonNullable<MetaprojectDashboardData["health"]>): string {
  if (health.status === "fail" || health.p0 > 0) {
    return `Gate is failing: ${health.p0} P0 finding(s), ${health.findings} finding(s) total. Treat the score as blocked until P0 items are resolved.`;
  }
  if (health.findings > 0) {
    return `Score ${health.score} still has ${health.findings} finding(s). The dashboard colors this as warning so high scores do not hide active quality debt.`;
  }
  if (health.status === "warn") {
    return `Gate is warning. Check missing optional sources, regressions, and source rows before trusting the score.`;
  }
  return `No active findings in the latest normalized report. Keep coverage and complexity sources connected to avoid a falsely optimistic score.`;
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

For starting, tracking, or finishing a managed piece of work (a flow), use the Metaproject flow skill for state/status commands. For non-trivial implementation through Task Manager, use the local gdskills flow-orchestrator first: .metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md. All flow state changes go through the gd-metapro flow CLI.
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
.metaproject/data/tasks/runtime/
.metaproject/data/tasks/logs/
# Security: local-only HMAC key, self-protect state, and local hash report must never be committed.
.metaproject/data/security/raw/
.metaproject/data/security/raw/**
.metaproject/data/security/artifacts/latest.md
.metaproject/data/security/artifacts/latest.json
.metaproject/reports/
`;
}

export function renderProjectRulesReadme(): string {
  return `# Project Rules

This directory stores repository-level instructions imported from root agent entrypoints such as \`AGENTS.md\` or \`CLAUDE.md\`.

Rules:

- treat files here as high-priority agent-readable mirrors of root instructions;
- update the root entrypoint first when changing project-wide instructions;
- rerun \`gd-metapro rules sync\`, \`gd-metapro init\`, or \`gd-metapro update\` to resync imported rule files.
`;
}

export function renderImportedAgentRules({
  source,
  content,
}: {
  source: string;
  content: string;
}): string {
  const body = extractAgentRuleBody(content);
  const normalizedBody =
    body.length > 0
      ? body
      : `This root entrypoint delegates agent routing to \`.metaproject/index.md\`.

Read \`.metaproject/index.md\` first, then follow the high-priority rules, skills, and module references listed there.`;

  return `---
type: agent-entrypoint-rule
priority: high
source: ${JSON.stringify(source)}
version: "1.0.0"
generated_by: gd-metapro
---

# Imported Rules: ${source}

Source: \`${source}\`
Priority: \`high\`
Version: \`1.0.0\`

This file is generated from the repository root agent entrypoint. Edit \`${source}\`, then rerun \`gd-metapro rules sync\`.

---

${normalizedBody}
`;
}

function extractAgentRuleBody(content: string): string {
  const marker = "<!-- gd-metapro:index -->";
  const markerIndex = content.indexOf(marker);
  const body = markerIndex >= 0 ? content.slice(0, markerIndex) : content;
  return body.trim();
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
2. Treat imported files in \`.metaproject/rules/\` as high-priority rules.
3. Apply those rules before module-specific guidance.
4. If root instructions changed, rerun \`gd-metapro rules sync\` to refresh this mirror.
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
  enableSecurity = false,
}: {
  enableGdgraph: boolean;
  enableGdctx: boolean;
  enableGdwiki: boolean;
  enableGdskills: boolean;
  enableHealth: boolean;
  enableTesting: boolean;
  enableMemory: boolean;
  enableTasks: boolean;
  enableSecurity?: boolean;
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
    enableSecurity
      ? "- `security`: policy-based scanning, redaction, guardrails, and audit reports for agent inputs/outputs and artifacts."
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
    ...(enableGdwiki ? ["gd-metapro wiki status", "gd-metapro wiki collect", "gd-metapro wiki index"] : []),
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
    ...(enableSecurity ? ["gd-metapro security status", "gd-metapro security scan <path>"] : []),
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

Git hooks are installed as marked managed blocks:

\`\`\`sh
# gd-metapro:<hook-id>:begin
...
# gd-metapro:<hook-id>:end
\`\`\`

\`gd-metapro update --hooks\` replaces only those managed blocks. Existing user
content, Husky wrappers, Lefthook dispatchers, lint-staged calls, and other
project-owned hook lines are preserved.

## git post-commit gdgraph hook

When enabled during \`gd-metapro init\`, the Git \`post-commit\` hook detects commits that touched files relevant to the graph and prints the explicit refresh command.

Purpose:

- prevent stale graph usage by surfacing the refresh command close to the commit;
- avoid broad raw file search when graph context is stale;
- avoid mutating versioned \`.metaproject\` artifacts after the commit is already written.

## git post-commit gdskills hook

When enabled during \`gd-metapro init\`, the Git \`post-commit\` hook runs lightweight project-skill verification after relevant project or Metaproject context changes.

Purpose:

- keep generated project-skills from silently drifting after code/wiki/rule changes;
- run non-mutating dry-run verification and report failures without changing files;
- write verification reports only during explicit \`gd-metapro skills verify\` runs or orchestrator-controlled checks;
- keep the hook local, optional and non-blocking.

## git post-commit health hook

When enabled during \`gd-metapro init\`, the Git \`post-commit\` hook detects relevant source/config changes and prints the explicit Code Health refresh command.

Purpose:

- keep Code Health refresh visible close to the commit that may affect it;
- avoid writing health reports after commit, which leaves the worktree dirty;
- avoid heavy sources in hooks: tests, audit, coverage and external providers stay manual or orchestrator-controlled.

## git post-commit testing hook

When enabled during \`gd-metapro init\`, the Git \`post-commit\` hook detects relevant source, test, config or documentation changes and prints the explicit testing refresh command.

Purpose:

- keep test-context staleness visible without mutating versioned files after commit;
- stay non-blocking and avoid running analyzers or heavy suites on every commit;
- give agents fresh context before test generation or debugging.

## git post-commit dashboard hook

When any Metaproject post-commit hook is enabled, a lightweight dashboard hook reminds the user to rebuild the dashboard after Metaproject-facing changes.

Purpose:

- keep \`.metaproject/index.md\` and \`.metaproject/gd-metapro-dashboard.html\` aligned through explicit \`gd-metapro update\` or \`gd-metapro dashboard build\`;
- recover missing \`.metaproject/metaproject.json\` for older initialized projects;
- avoid mutating service files after commit, especially from stale global CLI installations.

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
  # Non-mutating: report graph staleness after graph-relevant commits.

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

  echo "gd-metapro post-commit: gdgraph may be stale; run 'gd-metapro gdgraph build' when you want to refresh graph artifacts"
  return 0
}

gd_metapro_gdgraph_post_commit
`;
}

export function renderGdwikiPostCommitHook(): string {
  return `gd_metapro_gdwiki_post_commit() {
  # Non-mutating: remind to refresh only the touched wiki drafts after a
  # source-relevant commit. The refresh is deterministic; enrichment needs a
  # model, so both stay user-triggered.

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  changed_files="$(git diff-tree --no-commit-id --name-only -r --root HEAD 2>/dev/null || true)"
  if [ -z "$changed_files" ]; then
    return 0
  fi

  if ! printf '%s\\n' "$changed_files" | grep -E '(^src/|^lib/|^app/|^packages/|^services/)' >/dev/null 2>&1; then
    return 0
  fi

  echo "gd-metapro post-commit: wiki drafts may be stale; run 'gd-metapro wiki collect --changed --since HEAD~1', then enrich new drafts with the gdwiki skill on a non-flagship model"
  return 0
}

gd_metapro_gdwiki_post_commit
`;
}

export function renderMetaprojectDashboardPostCommitHook(): string {
  return `gd_metapro_dashboard_post_commit() {
  # Non-mutating: do not rewrite service files after commit.

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  echo "gd-metapro post-commit: dashboard/service files may be stale; run 'gd-metapro update --skip-runtime' or 'gd-metapro dashboard build' explicitly"
  return 0
}

gd_metapro_dashboard_post_commit
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
  # Non-mutating: report health staleness after relevant commits.

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

  echo "gd-metapro post-commit: health report may be stale; run 'gd-metapro health run --changed --since HEAD~1 --source typescript,complexity' explicitly"
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
