export type GdskillsProfile = "minimal" | "recommended" | "full" | "custom";

export type BundledSkill = {
  name: string;
  category: "core" | "orchestration" | "review" | "quality" | "planning" | "platform";
  description: string;
  purpose: string;
  workflow: string[];
  triggers: string[];
  profiles: Exclude<GdskillsProfile, "custom">[];
};

export const GDSKILLS_PROFILES: Exclude<GdskillsProfile, "custom">[] = [
  "minimal",
  "recommended",
  "full",
];

export const BUNDLED_GDSKILLS: BundledSkill[] = [
  skill("metaproject-router", "core", ["minimal", "recommended", "full"], "Choose which Metaproject module, working skill, or project-skill should be used for a user request.", [
    "Read `.metaproject/index.md` first.",
    "Classify the user request as navigation, implementation, review, planning, documentation, quality, memory, or workflow.",
    "If the request asks to create, run, resume, track, or finish a managed flow and Task Manager is enabled, route implementation work to `gdskills/orchestration/flow-orchestrator/SKILL.md` before `job-orchestrator`.",
    "Prefer project-local skills and module manifests before broad raw file search.",
    "Route to the narrowest applicable skill and record unavailable modules explicitly.",
  ], ["any repository task", "route context", "which skill should be used"]),
  skill("context-router", "core", ["minimal", "recommended", "full"], "Choose between gdgraph, gdctx, gdwiki, memory, health, and project-skills before raw file reads.", [
    "Use gdgraph for file relationships and affected context.",
    "Use gdctx for compact command, search, diff, log, and large-read output.",
    "Use gdwiki for architecture, domain, business rules, decisions, and scenarios.",
    "Use project-skills for known modules, components, stores, services, and domain entities.",
  ], ["find files", "understand code", "collect context"]),
  skill("entity-skill-router", "core", ["minimal", "recommended", "full"], "Select relevant project-skills for known modules, components, stores, services, and domain entities.", [
    "Check `.metaproject/project-skills` for matching module/entity skills.",
    "Use gdgraph affected context to find nearby entities when the target is a file.",
    "Load only the matching project-skill and directly referenced files.",
    "If no project-skill exists, suggest creating one with `gd-metapro skills generate`.",
  ], ["project skill", "component pattern", "module-specific work"]),
  skill("entity-skill-creator", "core", ["minimal", "recommended", "full"], "Create canonical project-skills from a path, symbol, wiki page, module, component, store, service, or domain entity.", [
    "Normalize the target into module, entity, files, symbols, and wiki references.",
    "Collect evidence from gdgraph, gdctx, gdwiki, health, and memory when available.",
    "Run `gd-metapro skills create <target> --module <module> --name <skill-name>`; infer module/name from the target when the user did not provide them.",
    "Run `gd-metapro skills route <target>` and `gd-metapro skills inspect <module>/<skill-name>` to confirm registration and routing.",
    "Run `gd-metapro skills verify <module>/<skill-name>` and finish with `gd-metapro skills status`.",
  ], ["create skill", "generate project skill", "new entity skill", "создай скил", "создай скилл для <path>"]),
  skill("entity-skill-verifier", "core", ["minimal", "recommended", "full"], "Verify project-skills against current code, graph, wiki, health, memory, tests, and review lessons.", [
    "Resolve candidate skills through ownership and gdgraph affected context.",
    "Compare skill claims with current code, wiki decisions, health reports, and memory.",
    "Classify each skill as fresh, stale, needs-review, or blocked.",
    "Write a verification report and only update generated sections when policy allows it.",
  ], ["verify skill", "skill-verify-skill", "stale skill"]),
  skill("entity-skill-learner", "core", ["minimal", "recommended", "full"], "Update project-skills from review findings, test failures, health reports, memory entries, and verifier reports.", [
    "Parse the source report and map findings to project-skills.",
    "Classify lessons as anti-patterns, checklist changes, template changes, workflow changes, or architecture rules.",
    "Respect manual sections and autonomy policy.",
    "Increment version and append `skill-changelog.md` entries with provenance.",
  ], ["learn from review", "update skill", "skill lesson"]),

  skill("job-orchestrator", "orchestration", ["recommended", "full"], "Run full task pipelines: clarify, collect context, plan, implement, verify, review, and summarize.", [
    "Clarify ambiguity with interviewer-style questions only when required.",
    "Collect compact context through Metaproject modules before implementation.",
    "Break the work into phases with verification after each phase.",
    "Run review and skill-learning handoffs before final summary when relevant.",
  ], ["implement issue", "full workflow", "orchestrate task"]),
  skill("flow-orchestrator", "orchestration", ["recommended", "full"], "Run Task Manager-backed implementation flows through gd-metapro flow state, frozen acceptance criteria, PR gates, review, and Code Health.", [
    "Require the Task Manager module and existing `.metaproject/skills/flow` router before starting.",
    "Create or resume a flow with `gd-metapro flow init|list|status` and treat the flow package as the source of truth.",
    "Delegate context, test, implementation, review, and docs work to existing gdskills while keeping flow state changes in the CLI.",
    "Move to implemented only after verification and a draft PR, then complete through acceptance-criteria and health gates.",
  ], ["создай фло", "create flow", "issue to flow", "managed implementation", "task manager orchestration"]),
  skill("job-documenter", "orchestration", ["recommended", "full"], "Create and maintain persistent job documentation for orchestrated analysis, implementation, and review work.", [
    "Initialize job folders and state documents.",
    "Write analysis, context, implementation, verification, and review reports.",
    "Keep job README and status metadata current.",
    "Finalize traceable job documentation for the user and follow-up agents.",
  ], ["job docs", "document job", "persistent job documentation"]),
  skill("context-collector", "orchestration", ["recommended", "full"], "Build compact task context from graph, ctx, wiki, memory, health, project-skills, and selected files.", [
    "Start from the target question and list the minimum context needed.",
    "Use gdgraph for relationships and gdctx for compact outputs.",
    "Pull wiki, memory, health, and project-skills only when relevant.",
    "Return a small context bundle with links, commands run, and confidence gaps.",
  ], ["collect context", "gather context", "build context"]),
  skill("task-implementer", "orchestration", ["recommended", "full"], "Implement one atomic task end to end using local project context and verification.", [
    "Read the task contract and selected context.",
    "Plan a small implementation slice.",
    "Edit only the required files and preserve unrelated changes.",
    "Run focused verification and report modified files, tests, and residual risks.",
  ], ["implement task", "execute task", "atomic task"]),
  skill("code-verifier", "orchestration", ["recommended", "full"], "Run and summarize verification gates: typecheck, lint, tests, build, imports, and changed-scope checks.", [
    "Detect available project scripts and tooling.",
    "Run the narrowest reliable checks first.",
    "Summarize failures as actionable file/line findings where possible.",
    "Store raw output under Metaproject data when gdctx is available.",
  ], ["verify code", "run checks", "quality gate"]),
  skill("issue-analyzer", "orchestration", ["recommended", "full"], "Convert GitHub or local issues into atomic implementation tasks with acceptance criteria.", [
    "Read the issue and linked context.",
    "Identify impacted modules, contracts, and tests.",
    "Split work into independent scenarios.",
    "Produce implementation-ready task briefs.",
  ], ["analyze issue", "decompose issue", "break down issue"]),
  skill("feature-analyzer", "orchestration", ["recommended", "full"], "Analyze a feature, module, branch, or migration area and produce an implementation map.", [
    "Identify the target area and compare current vs desired behavior.",
    "Use graph and compact context before reading broad files.",
    "Rank files by importance and risk.",
    "Produce a concise map of changes, dependencies, tests, and risks.",
  ], ["analyze feature", "study module", "investigate branch"]),
  skill("feature-dev", "orchestration", ["full"], "Run a guided feature workflow from requirements to implementation, verification, and PR-ready summary.", [
    "Clarify requirements and implementation scope.",
    "Collect project context and relevant local patterns.",
    "Implement in small verified slices.",
    "Prepare review and PR-ready documentation.",
  ], ["feature dev", "develop feature", "guided feature workflow"]),

  skill("review-orchestrator", "review", ["recommended", "full"], "Route review requests to specialized reviewers and consolidate findings.", [
    "Detect changed scope and relevant review domains.",
    "Use gdgraph affected context for exported symbols and shared surfaces.",
    "Dispatch specialized review passes conceptually or as separate skill loads.",
    "Report findings first, ordered by severity, with concrete file references.",
  ], ["review code", "full review", "review changes"]),
  skill("review-logic", "review", ["recommended", "full"], "Review logic correctness, contracts, edge cases, nullability, and async behavior.", [
    "Trace behavior through call sites and affected context.",
    "Look for incorrect assumptions, missing branches, race conditions, and error paths.",
    "Ground every finding in source code.",
  ], ["logic review", "bug review", "correctness"]),
  skill("review-architecture", "review", ["recommended", "full"], "Review boundaries, dependency direction, layering, and abstraction stability.", [
    "Identify module boundaries and public surfaces.",
    "Check dependency direction and leakage across layers.",
    "Flag coupling that increases blast radius or blocks future changes.",
  ], ["architecture review", "boundary review", "layering"]),
  skill("review-security-code", "review", ["recommended", "full"], "Review code-level security risks, injections, authorization gaps, unsafe secrets, and data exposure.", [
    "Map inputs, trust boundaries, and sensitive outputs.",
    "Check injection, auth, crypto, secrets, and unsafe filesystem/network behavior.",
    "Prioritize exploitable findings with concrete remediation.",
  ], ["security review", "secure code", "vulnerability"]),
  skill("review-performance", "review", ["recommended", "full"], "Review hot paths, unnecessary work, bundle/perf regressions, blocking operations, and memory risk.", [
    "Find changed hot paths and repeated operations.",
    "Check loops, rendering, async blocking, large imports, and caching behavior.",
    "Prioritize measurable or high-likelihood regressions.",
  ], ["performance review", "perf check", "slow"]),
  skill("review-frontend", "review", ["recommended", "full"], "Review frontend components, state boundaries, rendering behavior, and UI integration patterns.", [
    "Identify component, store, hook, route, and UI boundary changes.",
    "Check data flow, state ownership, rendering cost, accessibility, and local conventions.",
    "Use project-skills for module-specific frontend patterns when available.",
  ], ["frontend review", "component review", "ui review"]),
  skill("review-backend", "review", ["recommended", "full"], "Review backend services, API contracts, DTOs, validation, persistence, and integration boundaries.", [
    "Identify endpoint, service, data-access, and integration changes.",
    "Check validation, error handling, transaction boundaries, and contract compatibility.",
    "Use gdgraph affected context for downstream consumers.",
  ], ["backend review", "api review", "service review"]),
  skill("review-clean-code", "review", ["recommended", "full"], "Review function and class maintainability, SOLID issues, cohesion, naming, and complexity.", [
    "Focus on maintainability problems that affect future changes.",
    "Check function size, argument shape, abstraction level, cohesion, and duplication.",
    "Separate clean-code improvements from correctness defects.",
  ], ["clean code review", "solid review", "maintainability"]),
  skill("review-highload", "review", ["recommended", "full"], "Review concurrency, retries, queues, idempotency, resource pools, and high-traffic risks.", [
    "Map concurrent paths and shared resources.",
    "Check retries, idempotency, backpressure, locks, queues, and connection pools.",
    "Prioritize issues that can fail under load.",
  ], ["highload review", "concurrency review", "race condition"]),
  skill("review-core-boundaries", "review", ["recommended", "full"], "Review shared/core module coupling, public API stability, and dependency minimization.", [
    "Identify core/shared surfaces changed by the task.",
    "Check if feature-specific logic leaked into shared modules.",
    "Verify public API stability and downstream impact.",
  ], ["core review", "shared boundary", "public surface"]),
  skill("review-flow-graph", "review", ["recommended", "full"], "Review graph or flow UI abstractions, graph surfaces, layout lifecycle, and large-graph behavior.", [
    "Identify graph nodes, edges, stores, layout, and rendering changes.",
    "Check public graph surface and internal helper boundaries.",
    "Look for lifecycle, selection, and large-graph performance risks.",
  ], ["flow graph review", "graph ui review", "reactflow review"]),
  skill("review-style", "review", ["recommended", "full"], "Review naming, readability, duplication, dead code, and maintainability.", [
    "Focus on clarity and local consistency.",
    "Separate style findings from correctness findings.",
    "Avoid subjective churn unless it affects maintainability.",
  ], ["style review", "readability", "clean up"]),
  skill("review-testing-practices", "review", ["recommended", "full"], "Review test structure, coverage quality, determinism, and repository test conventions.", [
    "Identify required behavior coverage from the change.",
    "Check whether tests are meaningful, stable, and scoped.",
    "Flag brittle waits, over-mocking, missing negative cases, and weak assertions.",
  ], ["test review", "testing practices", "coverage quality"]),
  skill("review-strict", "review", ["recommended", "full"], "Perform a strict meta-review over findings, weak assumptions, and residual risk.", [
    "Re-check high-impact assumptions.",
    "Drop weak findings and elevate concrete risks.",
    "Ensure final output is actionable and severity-ranked.",
  ], ["strict review", "meta review", "boss review"]),
  skill("review-frontend-conventions", "review", ["recommended", "full"], "Review frontend code against repository-local frontend conventions and agent entrypoints.", [
    "Load local AGENTS.md/CLAUDE.md and matched frontend rules.",
    "Check component, state, styling, i18n, error, and Storybook conventions.",
    "Report concrete convention violations with source references.",
  ], ["frontend conventions", "local frontend rules", "CLAUDE frontend"]),
  skill("review-pr-feedback", "review", ["full"], "Analyze existing PR review comments and turn feedback into actions and reusable lessons.", [
    "Collect review comments and group them by author/topic.",
    "Explain each actionable comment and map it to files or skills.",
    "Propose fixes and rule/skill learning updates when patterns repeat.",
  ], ["review PR feedback", "analyze PR comments", "review comments"]),
  skill("code-ai-review", "review", ["full"], "Run the legacy strict AI review profile from goodai-base.", [
    "Load the AI review baseline rule.",
    "Review branch changes from merge-base.",
    "Report concrete findings first.",
  ], ["code-ai-review", "AI review baseline", "strict AI review"]),
  skill("code-b091-review", "review", ["full"], "Run the b091-style direct review profile from goodai-base.", [
    "Load the b091 review profile.",
    "Review changed code for correctness and weak assumptions.",
    "Use direct concise findings.",
  ], ["b091 review", "code-b091-review", "review as b091"]),
  skill("code-style-review", "review", ["full"], "Run the legacy code style and architecture review profile from goodai-base.", [
    "Load code-style rules and local conventions.",
    "Review naming, structure, boundaries, and TypeScript usage.",
    "Separate style issues from correctness defects.",
  ], ["code-style-review", "style review", "architecture style"]),
  skill("code-mobx-store-review", "review", ["full"], "Run focused MobX store and state logic review.", [
    "Check actions, computed state, reactions, async boundaries, and view/store separation.",
    "Load MobX store template and local conventions.",
    "Report state bugs and maintainability risks.",
  ], ["mobx review", "store review", "code-mobx-store-review"]),

  skill("security-audit", "quality", ["recommended", "full"], "Run dependency and secret/security checks and normalize findings.", [
    "Detect package manager and available audit commands.",
    "Scan for dependency advisories and accidentally committed secrets.",
    "Group findings by severity and remediation path.",
  ], ["security audit", "audit dependencies", "scan secrets"]),
  skill("perf-check", "quality", ["recommended", "full"], "Run or summarize performance, bundle, and complexity checks.", [
    "Detect available perf, build, bundle, and complexity tools.",
    "Run low-risk checks and summarize regressions.",
    "Link issues to files, modules, and affected skills when possible.",
  ], ["perf audit", "bundle size", "complexity"]),
  skill("test-gen", "quality", ["recommended", "full"], "Generate tests for a file or module using local patterns and existing test stack.", [
    "Discover test framework and nearby test examples.",
    "Generate tests that cover behavior, edge cases, and errors.",
    "Run focused tests when available.",
  ], ["generate tests", "write tests", "add coverage"]),
  skill("tests-creator", "quality", ["recommended", "full"], "Create test scenarios before implementation from acceptance criteria and project patterns.", [
    "Read requirements and convert them into behavior scenarios.",
    "Map scenarios to the existing test stack.",
    "Prefer tests that fail for the missing behavior before implementation.",
  ], ["create tests first", "test scenarios", "tdd"]),
  skill("dependency-update", "quality", ["full"], "Plan and verify dependency upgrades.", [
    "Classify updates by risk.",
    "Apply small compatible groups first.",
    "Run relevant verification and document rollback notes.",
  ], ["update dependencies", "upgrade packages", "bump deps"]),
  skill("db-migrate", "quality", ["full"], "Guide database migration creation, apply, rollback, status, and verification flows.", [
    "Detect migration tooling and existing conventions.",
    "Create minimal reversible migrations where possible.",
    "Run or describe verification and rollback steps.",
  ], ["database migration", "db migrate", "migration status"]),
  skill("deploy", "quality", ["full"], "Run deployment pre-flight checks and deployment workflow summaries.", [
    "Detect deployment target and required pre-flight checks.",
    "Run verification before deployment unless explicitly skipped.",
    "Summarize deployment status, rollback path, and health checks.",
  ], ["deploy", "ship", "release"]),
  skill("commit", "quality", ["full"], "Prepare conventional commits with scope, summary, and verification notes.", [
    "Inspect staged and unstaged changes.",
    "Group related changes without staging unrelated work.",
    "Create a conventional commit message with verification summary.",
  ], ["commit changes", "git commit", "conventional commit"]),
  skill("push", "quality", ["full"], "Push branches with safety checks, upstream handling, and concise result summary.", [
    "Check branch and remote state.",
    "Push the current branch with upstream when needed.",
    "Report remote branch and any follow-up needed.",
  ], ["push branch", "git push", "publish branch"]),
  skill("pr", "quality", ["full"], "Prepare pull request creation or update context from local changes.", [
    "Collect branch, commits, diff summary, tests, and risks.",
    "Draft concise PR title and description.",
    "Use project issue links when available.",
  ], ["open PR", "create pull request", "draft PR"]),
  skill("pr-issue-documenter", "quality", ["recommended", "full"], "Create PR descriptions and linked issue documentation from branch changes.", [
    "Analyze commits and changed files.",
    "Group changes by area and user-visible behavior.",
    "Update or draft issue/PR documentation with technical context.",
  ], ["document PR", "PR description", "create issue for PR"]),
  skill("changelog", "quality", ["full"], "Generate changelog or release notes from commits, tags, or date ranges.", [
    "Identify the commit range.",
    "Group changes by type and user impact.",
    "Include linked PRs/issues when available.",
  ], ["generate changelog", "release notes", "what changed"]),

  skill("brainstorm", "planning", ["recommended", "full"], "Explore architecture, product, or implementation options with trade-offs and recommendation.", [
    "Frame the decision and constraints.",
    "Compare pragmatic, innovative, and critical perspectives.",
    "Recommend a path with risks and next steps.",
  ], ["brainstorm", "explore options", "architecture decision"]),
  skill("interviewer", "planning", ["recommended", "full"], "Ask focused clarification questions before expensive or ambiguous work.", [
    "Ask only questions that materially affect implementation.",
    "Prefer short multiple-choice options with a recommended default.",
    "Stop once the task is specific enough to execute.",
  ], ["ask questions", "clarify requirements", "interview"]),
  skill("interview", "planning", ["recommended", "full"], "Run implementation-specific structured interview used by job-orchestrator before planning.", [
    "Clarify implementation ambiguities from the issue or task.",
    "Trigger brainstorm for unresolved architecture decisions.",
    "Return answers in a form the orchestrator can use for planning.",
  ], ["implementation interview", "interview before implementation", "clarify implementation"]),
  skill("prd-creator", "planning", ["recommended", "full"], "Convert vague requests into structured PRD and acceptance criteria.", [
    "Extract users, goals, non-goals, constraints, and risks.",
    "Ask clarifying questions when needed.",
    "Write testable requirements and acceptance criteria.",
  ], ["create PRD", "product requirements", "specify feature"]),
  skill("project-discovery", "planning", ["full"], "Collect initial project facts, modules, constraints, stakeholders, and source references.", [
    "Inventory available docs, code modules, and entrypoints.",
    "Identify project purpose, users, constraints, and unknowns.",
    "Produce a structured discovery summary for PRD/spec work.",
  ], ["project discovery", "discover project", "initial analysis"]),
  skill("problem-definer", "planning", ["full"], "Define goals, non-goals, risks, constraints, and success metrics.", [
    "Separate problem, solution ideas, constraints, and open questions.",
    "Make goals and non-goals explicit.",
    "Define measurable success criteria.",
  ], ["define problem", "goals non-goals", "success metrics"]),
  skill("stack-advisor", "planning", ["full"], "Recommend stack choices based on project level, constraints, team needs, and operational risk.", [
    "Classify project level and constraints.",
    "Compare stack options with trade-offs.",
    "Recommend a conservative default and explain risks.",
  ], ["stack advice", "choose stack", "technology choice"]),
  skill("patterns-researcher", "planning", ["full"], "Find architecture and implementation patterns for selected stack, domain, and project constraints.", [
    "Identify relevant existing local patterns first.",
    "Compare candidate patterns against constraints.",
    "Document chosen patterns and anti-patterns.",
  ], ["research patterns", "architecture patterns", "best practices"]),
  skill("spec-writer", "planning", ["full"], "Write PRD, technical spec, or implementation plan constrained by decisions and evidence.", [
    "Collect source requirements and decisions.",
    "Write structured, testable sections.",
    "Link assumptions, open questions, and acceptance criteria.",
  ], ["write spec", "technical specification", "implementation plan"]),
  skill("consistency-checker", "planning", ["full"], "Check PRD, specs, plans, wiki, and decisions for contradictions or stale assumptions.", [
    "Compare documents against accepted decisions and current code context.",
    "Flag contradictions, missing constraints, and unsupported claims.",
    "Suggest minimal updates with provenance.",
  ], ["check consistency", "validate spec", "doc contradictions"]),
  skill("planner", "planning", ["full"], "Produce roadmap, milestones, task breakdown, dependency graph, and sequencing.", [
    "Break goals into milestones and tasks.",
    "Identify dependencies, risks, and verification gates.",
    "Recommend execution order with small slices.",
  ], ["create plan", "roadmap", "task breakdown"]),
  skill("autodoc-orchestrator", "planning", ["full"], "Coordinate reverse-engineering documentation for an existing codebase.", [
    "Scan structure and identify documentation targets.",
    "Analyze modules in small batches.",
    "Assemble architecture, component, service, and decision docs.",
  ], ["autodoc", "document codebase", "reverse engineer docs"]),
  skill("autodoc-scanner", "planning", ["full"], "Scan an existing codebase to identify documentation targets and module boundaries.", [
    "Inventory structure, stack, entrypoints, and candidate modules.",
    "Produce a bounded scan report for autodoc orchestration.",
    "Avoid broad raw dumps; summarize evidence and gaps.",
  ], ["autodoc scan", "scan codebase", "documentation targets"]),
  skill("autodoc-analyst", "planning", ["full"], "Analyze one module, component, or service area for reverse-engineering documentation.", [
    "Read selected files and nearby context.",
    "Extract responsibilities, flows, dependencies, and risks.",
    "Return structured notes for documentation assembly.",
  ], ["autodoc analyst", "analyze module docs", "reverse engineer module"]),
  skill("autodoc-architect", "planning", ["full"], "Derive architecture-level documentation from scanned code and module analyses.", [
    "Identify architectural layers and dependency direction.",
    "Summarize system boundaries and major flows.",
    "Record assumptions and unknowns for verification.",
  ], ["autodoc architect", "architecture docs", "reverse engineer architecture"]),
  skill("autodoc-writer", "planning", ["full"], "Write Markdown documentation pages from autodoc analysis artifacts.", [
    "Convert structured analysis into readable docs.",
    "Link pages to code, wiki, and decisions.",
    "Keep unsupported claims explicit.",
  ], ["autodoc writer", "write docs", "generate documentation pages"]),
  skill("autodoc-assembler", "planning", ["full"], "Assemble reverse-engineered documentation into a coherent indexed documentation package.", [
    "Combine scanner, analyst, architect, and writer outputs.",
    "Generate indexes and cross-links.",
    "Report gaps and recommended follow-up pages.",
  ], ["autodoc assemble", "assemble docs", "documentation package"]),

  skill("agent-entrypoint-manager", "platform", ["minimal", "recommended", "full"], "Maintain AGENTS.md, CLAUDE.md, and local-first Metaproject references.", [
    "Find existing root agent entrypoints.",
    "Keep managed Metaproject blocks idempotent.",
    "Ensure local `.metaproject/index.md` and skill catalog are first-class references.",
  ], ["agents.md", "claude.md", "entrypoint"]),
  skill("hook-manager", "platform", ["recommended", "full"], "Create and verify lightweight git hooks for graph, health, and skill verification.", [
    "Install hooks only when explicitly enabled.",
    "Keep hooks lightweight and idempotent.",
    "Avoid network and destructive behavior inside hooks.",
  ], ["install hook", "git hook", "post-commit"]),
  skill("hookify", "platform", ["full"], "Use goodai-base hook guidance for safe hook design and installation.", [
    "Detect existing hooks and preserve user content.",
    "Install idempotent managed blocks.",
    "Keep hooks lightweight and observable.",
  ], ["hookify", "hook guidance", "safe hooks"]),
  skill("claude-md-management", "platform", ["full"], "Maintain CLAUDE.md and related agent entrypoint guidance from goodai-base.", [
    "Read existing agent entrypoints.",
    "Patch managed guidance without deleting user-authored content.",
    "Keep rule and skill links discoverable.",
  ], ["claude md", "CLAUDE.md management", "agent entrypoint"]),
  skill("skill-catalog-manager", "platform", ["minimal", "recommended", "full"], "Generate `.metaproject/skills/catalog.md` and machine-readable skill registry.", [
    "Read bundled and project-local skill metadata.",
    "Generate concise catalog entries grouped by category.",
    "Keep catalog deterministic and local-first.",
  ], ["skill catalog", "list skills", "skills registry"]),
  skill("skill-runtime-exporter", "platform", ["full"], "Export canonical skills to runtime-compatible Codex or Claude artifacts.", [
    "Read canonical skill packages.",
    "Remove management-only files from runtime exports.",
    "Keep runtime `SKILL.md` concise with references, scripts, and assets as needed.",
  ], ["export skill", "runtime skill", "codex skill"]),
  skill("skill-sync", "platform", ["full"], "Sync exported runtime skills to configured local runtimes only when explicitly enabled.", [
    "Read configured runtime targets.",
    "Validate runtime skill packages before sync.",
    "Sync only selected skills and report changed files.",
  ], ["sync skills", "install runtime skills", "global skill sync"]),
];

function skill(
  name: string,
  category: BundledSkill["category"],
  profiles: Exclude<GdskillsProfile, "custom">[],
  purpose: string,
  workflow: string[],
  triggers: string[],
): BundledSkill {
  return {
    name,
    category,
    description: `Use when ${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}`,
    purpose,
    workflow,
    triggers,
    profiles,
  };
}

export function normalizeGdskillsProfile(value: string | undefined): GdskillsProfile {
  if (value === "minimal" || value === "recommended" || value === "full" || value === "custom") {
    return value;
  }

  return "recommended";
}

export function getBundledSkillsForProfile(profile: GdskillsProfile): BundledSkill[] {
  if (profile === "custom") {
    return getBundledSkillsForProfile("recommended");
  }

  return BUNDLED_GDSKILLS
    .filter((skillEntry) => skillEntry.profiles.includes(profile))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function renderBundledSkill(skillEntry: BundledSkill): string {
  const triggers = skillEntry.triggers.map((trigger) => `- ${trigger}`).join("\n");
  const workflow = skillEntry.workflow.map((step, index) => `${index + 1}. ${step}`).join("\n");
  const commandContract = renderAgentCommandContract(skillEntry);

  return `---
name: ${skillEntry.name}
description: ${skillEntry.description}
---

# ${skillEntry.name}

## Purpose

${skillEntry.purpose}

## When To Use

${triggers}

## Workflow

${workflow}${commandContract}

## Local-First Rules

1. Start from \`.metaproject/index.md\` and \`.metaproject/skills/catalog.md\`.
2. Prefer project-local skills under \`.metaproject/project-skills\` and \`.metaproject/skills/gdskills\`.
3. Use \`gdgraph\`, \`gdctx\`, \`gdwiki\`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
`;
}

function renderAgentCommandContract(skillEntry: BundledSkill): string {
  if (skillEntry.name !== "entity-skill-creator") {
    return "";
  }

  return `

## Agent Command Contract

When the user asks in natural language to create a skill, for example \`создай скил для init.ts\`, \`создай скилл для src/commands/init.ts\`, or \`create a skill for <path>\`, the agent must run the CLI flow itself. Do not ask the user to run these commands manually.

Required flow:

\`\`\`bash
gd-metapro skills create <target> --module <module> --name <skill-name>
gd-metapro skills route <target>
gd-metapro skills inspect <module>/<skill-name>
gd-metapro skills verify <module>/<skill-name>
gd-metapro skills status
\`\`\`

Inference rules:

1. If the user gives only a basename such as \`init.ts\`, resolve it with graph/search first and use the matching project path.
2. Infer \`--module\` from the closest stable project area when omitted.
3. Infer \`--name\` from the entity or file purpose, using kebab-case.
4. If multiple targets match, ask one short clarification question before creating anything.
5. Report created files, verification status, and next recommended action.
`;
}

export function renderGdskillsCatalog(profile: GdskillsProfile): string {
  const skills = getBundledSkillsForProfile(profile);
  const rows = skills
    .map((skillEntry) => {
      const entry = `gdskills/${skillEntry.category}/${skillEntry.name}/SKILL.md`;
      return `| ${skillEntry.name} | ${skillEntry.category} | ${skillEntry.purpose} | ${entry} |`;
    })
    .join("\n");

  return `# Metaproject Skills Catalog

Profile: ${profile}
Generated By: gd-metapro

This catalog lists project-local working skills installed by \`gd-metapro\`.

Resolution order:

1. \`.metaproject/index.md\`
2. \`.metaproject/skills/catalog.md\`
3. \`.metaproject/project-skills/**\`
4. \`.metaproject/skills/gdskills/**\`
5. Explicitly allowed global fallback skills

## Agent Shortcuts

- User says \`создай скил для <path>\`, \`создай скилл для <file>\`, or \`create a skill for <target>\`: load \`gdskills/core/entity-skill-creator/SKILL.md\` and run the create-route-inspect-verify-status CLI flow yourself.
- User asks which project skill applies to a file/task: run \`gd-metapro skills route <query-or-target>\` before reading broad files.
- User asks whether a project skill is still valid: run \`gd-metapro skills verify <skill-or-target>\`.

| Skill | Category | Purpose | Entry |
|---|---|---|---|
${rows}
`;
}

export function renderGdskillsManifest(profile: GdskillsProfile): string {
  const skills = getBundledSkillsForProfile(profile);
  const byCategory = new Map<BundledSkill["category"], BundledSkill[]>();
  for (const skillEntry of skills) {
    byCategory.set(skillEntry.category, [...(byCategory.get(skillEntry.category) ?? []), skillEntry]);
  }

  const sections = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, entries]) => {
      const items = entries.map((entry) => `- \`${entry.name}\`: ${entry.purpose}`).join("\n");
      return `### ${category}\n\n${items}`;
    })
    .join("\n\n");

  return `# gdskills

## Purpose

Native bundled Metaproject working skills and orchestrators.

## Install Profile

\`${profile}\`

## Installed Skills

${sections}

## Commands

- \`gd-metapro skills status\`
- \`gd-metapro skills catalog --profile ${profile}\`
- \`gd-metapro skills install --profile ${profile}\`

## Storage

- \`skills/gdskills/\` - installed working skills.
- \`project-skills/\` - generated entity/project skills.
- \`data/gdskills/\` - reports, proposals, and artifacts.
`;
}
