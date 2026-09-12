import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "./skill-frontmatter";

export type GdskillsProfile = "minimal" | "recommended" | "full" | "custom";

export type BundledSkill = {
  name: string;
  category: "core" | "orchestration" | "review" | "quality" | "planning" | "platform";
  /**
   * The routing description `skills route` scores. For a file-backed skill it
   * IS the bundled SKILL.md frontmatter `description`, read from that file; for
   * a rendered-only skill it is the literal passed to `renderedSkill`.
   */
  description: string;
  purpose: string;
  workflow: string[];
  /** Same source rule as `description`, for the frontmatter `triggers:` list. */
  triggers: string[];
  profiles: Exclude<GdskillsProfile, "custom">[];
};

export const GDSKILLS_PROFILES: Exclude<GdskillsProfile, "custom">[] = [
  "minimal",
  "recommended",
  "full",
];

export const BUNDLED_GDSKILLS: BundledSkill[] = [
  renderedSkill("metaproject-router", "core", ["minimal", "recommended", "full"], "Choose which Metaproject module, working skill, or project-skill should be used for a user request.", [
    "Read `.metaproject/index.md` first.",
    "Treat the user's natural-language request as an intent; do not require exact keryx command, skill, or MCP tool names.",
    "Classify the user request as navigation, understanding, implementation, review, planning, documentation, quality, testing, security, memory, or workflow.",
    "Prefer available MCP tools/resources for the selected Metaproject capability; otherwise use the corresponding project-local skill and `keryx` CLI command.",
    "Use the Intent Router in `.metaproject/routing.md` to map user intent to capability before reading broad source files.",
    "If the request asks to create, run, resume, track, or finish a managed flow and Task Manager is enabled, route implementation work to `gdskills/orchestration/flow-orchestrator/SKILL.md` before `job-orchestrator`.",
    "Prefer project-local skills and module manifests before broad raw file search.",
    "Route to the narrowest applicable skill and record unavailable modules explicitly.",
  ], ["any repository task", "route context", "which skill should be used", "ordinary product-development request", "agent should decide tools", "pick the module"],
    "Use when a request's routing to a Metaproject module, skill, or project-skill is unclear and needs deciding before any work starts. NOT for: picking between gdgraph, gdctx, gdwiki, memory, and health once the module is already known (see context-router)."),
  renderedSkill("context-router", "core", ["minimal", "recommended", "full"], "Choose between gdgraph, gdctx, gdwiki, memory, health, and project-skills before raw file reads.", [
    "Start from the user's goal, not from command names.",
    "Use gdgraph for file relationships and affected context.",
    "Use gdctx for compact command, search, diff, log, and large-read output.",
    "Use gdwiki for architecture, domain, business rules, decisions, and scenarios.",
    "Use memory for historical decisions, known constraints, lessons, and repeated mistakes.",
    "Use health for normalized quality and gate status; use testing for test selection and test context.",
    "Prefer MCP tools/resources for these capabilities when connected; otherwise use the matching skill and CLI command.",
    "Use project-skills for known modules, components, stores, services, and domain entities.",
    // No "collect context": that phrase is context-collector's, and a trigger
    // two skills share settles nothing (flow 257 T6).
  ], ["find files", "understand code", "what should I inspect", "agent routing"],
    "Use when the Metaproject module or skill is already known and the next step is picking gdgraph, gdctx, gdwiki, memory, health, or project-skills before reading raw files. NOT for: deciding which top-level skill or module should handle a request (see metaproject-router)."),
  renderedSkill("entity-skill-router", "core", ["minimal", "recommended", "full"], "Select relevant project-skills for known modules, components, stores, services, and domain entities.", [
    "Check `.metaproject/project-skills` for matching module/entity skills.",
    "Use gdgraph affected context to find nearby entities when the target is a file.",
    "Load only the matching project-skill and directly referenced files.",
    "If no project-skill exists, suggest creating one with `keryx skills generate`.",
  ], ["project skill", "component pattern", "module-specific work"],
    "Use when a known module, component, store, service, or domain entity already has a project-skill that should be loaded instead of searched for from scratch. NOT for: scaffolding a project-skill that does not exist yet (see entity-skill-creator), checking one against current code (see entity-skill-verifier), or applying a finding to one (see entity-skill-learner)."),
  renderedSkill("entity-skill-creator", "core", ["minimal", "recommended", "full"], "Create canonical project-skills from a path, symbol, wiki page, module, component, store, service, or domain entity.", [
    "Normalize the target into module, entity, files, symbols, and wiki references.",
    "Collect evidence from gdgraph, gdctx, gdwiki, health, and memory when available.",
    "Run `keryx skills create <target> --module <module> --name <skill-name>`; infer module/name from the target when the user did not provide them.",
    "When the user points at an existing SKILL.md, a folder of them, or a GitHub SKILL.md URL, run `keryx skills import --from <that> --module <module>` instead of scaffolding an empty skill.",
    "To refresh a project-skill from its Origin (or a new file), run `keryx skills update <module>/<name> [--from <origin>]`.",
    "Run `keryx skills route <target>` and `keryx skills inspect <module>/<skill-name>` to confirm registration and routing.",
    "Run `keryx skills verify <module>/<skill-name>` and finish with `keryx skills status`.",
  ], ["create skill", "generate project skill", "new entity skill", "создай скил", "создай скилл для <path>", "import skill", "import skills from", "update skill from", "подтяни скилы", "обнови скил"],
    "Use when no project-skill exists yet for a target module, component, store, service, or domain entity, or one needs scaffolding, importing, or refreshing from its origin. NOT for: loading a project-skill that already exists (see entity-skill-router)."),
  skill("reviewer-skill-creator", "core", ["recommended", "full"], "Create a project-local reviewer for review-orchestrator from a rules file, review profile, or written team standard.", [
    "Read the source in full and sort it into method, convention, and persona before writing anything.",
    "Scaffold with `keryx skills create <target> --module review --name <reviewer> --note <gist> --origin <source file>`; the target is a routing key, the note is the prose.",
    "Always pass --origin when a source file exists, so `keryx review reviewers` can report when the source moves on.",
    "Write the reviewer against the orchestrated review contract; point at the canonical severity rubric instead of inventing one.",
    "Drop the persona, keep the method, and state the reason beside every rule kept.",
    "Confirm with `keryx review reviewers` — creating files is not registration, and registration is not discovery.",
    "For existing SKILL.md packages, run `keryx skills import --from <dir|file|https-url> --module <module>`; `keryx review import` is the review-shaped alias with the review-vantage-* prefix.",
  ]),
  renderedSkill("entity-skill-verifier", "core", ["minimal", "recommended", "full"], "Run `keryx skills verify` to check a project-skill's required files, SKILL.md metadata, manifest registration, target-path existence, and evidence artifacts (gdgraph, gdctx, validated gdwiki, Code Health, canonical accepted memory), then classify it as fresh, needs-review, stale, or blocked. The command does not read the skill's prose or compare it against current code — that comparison is a manual agent step.", [
    "Resolve the target project-skill through gdgraph affected context or `keryx skills route <target>`.",
    "Run `keryx skills verify <module>/<skill-name>` (`--dry-run` previews without writing).",
    "The command checks required files, SKILL.md metadata (version, target, last-verified), manifest registration, target path existence, and evidence artifacts for gdgraph, gdctx, gdwiki, Code Health, and memory consultation, then classifies the skill fresh, needs-review, stale, or blocked and writes the JSON report plus `verification.md`.",
    "Manually read the skill and the code, wiki, and health evidence it points at to check its claims — the command does not do this comparison — then route stale or blocked findings to entity-skill-learner.",
  ], ["verify skill", "skill-verify-skill", "stale skill"],
    "Use when an existing project-skill needs classifying — fresh, needs-review, stale, or blocked — from its required files, metadata, manifest registration, target-path existence, and evidence artifacts (gdgraph, gdctx, gdwiki, Code Health, memory), followed by a manual read of its claims against current code as this skill's next step. NOT for: applying a review, test, or health finding to update a skill (see entity-skill-learner)."),
  renderedSkill("entity-skill-learner", "core", ["minimal", "recommended", "full"], "Update project-skills from review findings, test failures, health reports, memory entries, and verifier reports.", [
    "Parse the source report and map findings to project-skills.",
    "Classify lessons as anti-patterns, checklist changes, template changes, workflow changes, or architecture rules.",
    "Respect manual sections and autonomy policy.",
    "Increment version and append `skill-changelog.md` entries with provenance.",
  ], ["learn from review", "update skill", "skill lesson"],
    "Use when a review finding, test failure, health report, memory entry, or verifier report points at a project-skill that needs updating. NOT for: checking a skill's current accuracy with no source report driving it (see entity-skill-verifier)."),

  skill("job-orchestrator", "orchestration", ["recommended", "full"], "Run full task pipelines: clarify, collect context, plan, implement, verify, review, and summarize.", [
    "Clarify ambiguity with interviewer-style questions only when required.",
    "Collect compact context through Metaproject modules before implementation.",
    "Break the work into phases with verification after each phase.",
    "Run review and skill-learning handoffs before final summary when relevant.",
  ]),
  skill("flow-orchestrator", "orchestration", ["recommended", "full"], "Run Task Manager-backed implementation flows through keryx flow state, frozen acceptance criteria, an explicit completion choice, review, and Code Health.", [
    "Require the Task Manager module and existing `.metaproject/skills/flow` router before starting.",
    "Create or resume a flow with `keryx flow init|list|status` and treat the flow package as the source of truth.",
    "Delegate context, test, implementation, review, and docs work to existing gdskills while keeping flow state changes in the CLI.",
    "After verification, ask the user whether to create a draft PR and complete the managed flow, finish with a verified handoff without PR, or keep the flow open.",
  ]),
  skill("job-documenter", "orchestration", ["recommended", "full"], "Create and maintain persistent job documentation for orchestrated analysis, implementation, and review work.", [
    "Initialize job folders and state documents.",
    "Write analysis, context, implementation, verification, and review reports.",
    "Keep job README and status metadata current.",
    "Finalize traceable job documentation for the user and follow-up agents.",
  ]),
  skill("context-collector", "orchestration", ["recommended", "full"], "Build compact task context from graph, ctx, wiki, memory, health, project-skills, and selected files.", [
    "Start from the target question and list the minimum context needed.",
    "Use gdgraph for relationships and gdctx for compact outputs.",
    "Pull wiki, memory, health, and project-skills only when relevant.",
    "Return a small context bundle with links, commands run, and confidence gaps.",
  ]),
  skill("task-implementer", "orchestration", ["recommended", "full"], "Implement one atomic task end to end using local project context and verification.", [
    "Read the task contract and selected context.",
    "Plan a small implementation slice.",
    "Edit only the required files and preserve unrelated changes.",
    "Run focused verification and report modified files, tests, and residual risks.",
  ]),
  skill("code-verifier", "orchestration", ["recommended", "full"], "Run and summarize verification gates: typecheck, lint, tests, build, imports, and changed-scope checks.", [
    "Detect available project scripts and tooling.",
    "Run the narrowest reliable checks first.",
    "Summarize failures as actionable file/line findings where possible.",
    "Store raw output under Metaproject data when gdctx is available.",
  ]),
  skill("issue-analyzer", "orchestration", ["recommended", "full"], "Convert GitHub or local issues into atomic implementation tasks with acceptance criteria.", [
    "Read the issue and linked context.",
    "Identify impacted modules, contracts, and tests.",
    "Split work into independent scenarios.",
    "Produce implementation-ready task briefs.",
  ]),
  skill("feature-analyzer", "orchestration", ["recommended", "full"], "Analyze a feature, module, branch, or migration area and produce an implementation map.", [
    "Identify the target area and compare current vs desired behavior.",
    "Use graph and compact context before reading broad files.",
    "Rank files by importance and risk.",
    "Produce a concise map of changes, dependencies, tests, and risks.",
  ]),
  skill("feature-dev", "orchestration", ["full"], "Run a guided feature workflow from requirements to implementation, verification, and PR-ready summary.", [
    "Clarify requirements and implementation scope.",
    "Collect project context and relevant local patterns.",
    "Implement in small verified slices.",
    "Prepare review and PR-ready documentation.",
  ]),

  // Its SKILL.md triggers include a bare "review", which belongs to the
  // ORCHESTRATOR — the description says so: use it when a review is requested
  // and the user does NOT name a specialist. Safe only because a trigger cannot
  // fire on fewer words than it was written with: before that, "ui review"
  // degenerated to ["review"] and review-frontend took every review request.
  // The same fact constrains its description and triggers: "review" fires on
  // every review request, so a specialist's word in this skill's text (the
  // `review --frontend` flag list it used to carry) ties it with the specialist
  // that owns the word.
  skill("review-orchestrator", "review", ["recommended", "full"], "Route review requests to specialized reviewers and consolidate findings.", [
    "Detect changed scope and relevant review domains.",
    "Use gdgraph affected context for exported symbols and shared surfaces.",
    "Dispatch specialized review passes conceptually or as separate skill loads.",
    "Report findings first, ordered by severity, with concrete file references.",
  ]),
  skill("review-logic", "review", ["recommended", "full"], "Review logic correctness, contracts, edge cases, nullability, and async behavior.", [
    "Trace behavior through call sites and affected context.",
    "Look for incorrect assumptions, missing branches, race conditions, and error paths.",
    "Ground every finding in source code.",
  ]),
  skill("review-architecture", "review", ["recommended", "full"], "Review boundaries, dependency direction, layering, and abstraction stability.", [
    "Identify module boundaries and public surfaces.",
    "Check dependency direction and leakage across layers.",
    "Flag coupling that increases blast radius or blocks future changes.",
  ]),
  // Its SKILL.md carries "проверь безопасность" explicitly, because `провер*`
  // means check and no longer implies review — "проверка почты" is not a review
  // request. The specific case is carried by a trigger rather than by widening
  // the synonym that broke it.
  skill("review-security-code", "review", ["recommended", "full"], "Review code-level security risks, injections, authorization gaps, unsafe secrets, and data exposure.", [
    "Map inputs, trust boundaries, and sensitive outputs.",
    "Check injection, auth, crypto, secrets, and unsafe filesystem/network behavior.",
    "Prioritize exploitable findings with concrete remediation.",
  ]),
  skill("review-performance", "review", ["recommended", "full"], "Review hot paths, unnecessary work, bundle/perf regressions, blocking operations, and memory risk.", [
    "Find changed hot paths and repeated operations.",
    "Check loops, rendering, async blocking, large imports, and caching behavior.",
    "Prioritize measurable or high-likelihood regressions.",
  ]),
  skill("review-frontend", "review", ["recommended", "full"], "Review frontend components, state boundaries, rendering behavior, and UI integration patterns.", [
    "Identify component, store, hook, route, and UI boundary changes.",
    "Check data flow, state ownership, rendering cost, accessibility, and local conventions.",
    "Use project-skills for module-specific frontend patterns when available.",
  ]),
  skill("review-backend", "review", ["recommended", "full"], "Review backend services, API contracts, DTOs, validation, persistence, and integration boundaries.", [
    "Identify endpoint, service, data-access, and integration changes.",
    "Check validation, error handling, transaction boundaries, and contract compatibility.",
    "Use gdgraph affected context for downstream consumers.",
  ]),
  skill("review-clean-code", "review", ["recommended", "full"], "Review function and class maintainability, SOLID issues, cohesion, naming, and complexity.", [
    "Focus on maintainability problems that affect future changes.",
    "Check function size, argument shape, abstraction level, cohesion, and duplication.",
    "Separate clean-code improvements from correctness defects.",
  ]),
  skill("review-highload", "review", ["recommended", "full"], "Review concurrency, retries, queues, idempotency, resource pools, and high-traffic risks.", [
    "Map concurrent paths and shared resources.",
    "Check retries, idempotency, backpressure, locks, queues, and connection pools.",
    "Prioritize issues that can fail under load.",
  ]),
  skill("review-regression", "review", ["recommended", "full"], "Review the blast radius of a change — the code it can break — rather than the change itself. Scope B of a deep round.", [
    "Read the dependency path back to the change before reading the file.",
    "Ask only whether the change breaks an existing behaviour here; style and architecture in untouched code are rejected in code, not discouraged.",
    "Anchor class_scope on the callers that break, never on the changed line.",
    "Say when the radius could not answer — a non-code change has an empty one.",
  ]),
  skill("review-core-boundaries", "review", ["recommended", "full"], "Review shared/core module coupling, public API stability, and dependency minimization.", [
    "Identify core/shared surfaces changed by the task.",
    "Check if feature-specific logic leaked into shared modules.",
    "Verify public API stability and downstream impact.",
  ]),
  skill("review-flow-graph", "review", ["recommended", "full"], "Review graph or flow UI abstractions, graph surfaces, layout lifecycle, and large-graph behavior.", [
    "Identify graph nodes, edges, stores, layout, and rendering changes.",
    "Check public graph surface and internal helper boundaries.",
    "Look for lifecycle, selection, and large-graph performance risks.",
  ]),
  skill("review-layout", "review", ["recommended", "full"], "Review rendered layout: flex/grid sizing, collapse and overflow, box model, logical properties and RTL, and locale-driven geometry.", [
    "Measure in a real layout engine; a DOM stub loads no stylesheet, so toHaveClass observes a string and never a pixel.",
    "Report host width, element width or offset in pixels, and the command or probe that produced them.",
    "Measure the worst real case: the longest translation, the narrowest supported host, the state where the sibling is absent.",
    "An unmeasured layout claim is info, marked unverified — never promoted on confidence.",
  ]),
  skill("review-style", "review", ["recommended", "full"], "Review naming, readability, duplication, dead code, and maintainability.", [
    "Focus on clarity and local consistency.",
    "Separate style findings from correctness findings.",
    "Avoid subjective churn unless it affects maintainability.",
  ]),
  skill("review-testing-practices", "review", ["recommended", "full"], "Review test structure, coverage quality, determinism, and repository test conventions.", [
    "Identify required behavior coverage from the change.",
    "Check whether tests are meaningful, stable, and scoped.",
    "Flag brittle waits, over-mocking, missing negative cases, and weak assertions.",
  ]),
  // Replaced `review-strict`, which re-read findings and adjusted severity with
  // no new evidence. Intrinsic self-correction is measured to degrade accuracy
  // (GPT-4 on GSM8K 95.5 -> 91.5 -> 89.0 across rounds; GPT-3.5 on CommonSenseQA
  // 75.8 -> 38.1; Huang et al., ICLR 2024, arXiv:2310.01798), so the pass was
  // removed rather than improved. The replacement verifies by RUNNING something
  // and can only delete.
  skill("review-verifier", "review", ["recommended", "full"], "Verify reported findings by executing a check that fails if the finding is real; delete-only.", [
    "Never verify a finding raised by yourself.",
    "Run a command or test that fails if the finding is real; record the command and its output.",
    "Fall back to confirming the class_scope sites exist; reasoning alone is capped at unverifiable.",
    "Emit one verdict per finding checked; never add a finding, raise a severity, or edit a finding's text.",
  ]),
  skill("review-frontend-conventions", "review", ["recommended", "full"], "Review frontend code against repository-local frontend conventions and agent entrypoints.", [
    "Load local AGENTS.md/CLAUDE.md and matched frontend rules.",
    "Check component, state, styling, i18n, error, and Storybook conventions.",
    "Report concrete convention violations with source references.",
  ]),
  skill("review-pr-feedback", "review", ["full"], "Analyze existing PR review comments, validate them against the code, plan the fix, and — with --fix — drive it to merged and answer every reviewer.", [
    "Collect through `keryx review comments collect`; a hand-rolled fetch loses page two and writes no record.",
    "Give every comment a verdict against the code at the head SHA, with the evidence that settled it.",
    "Plan by class, one item per shape, each carrying a verifiable acceptance criterion.",
    "Under --fix, dispatch flow-orchestrator: branch from the reviewed PR's own branch, draft PR, review/fix loop to zero minor-and-above, merge back into it.",
    "Answer each comment once after the merge, in English, through `keryx review comments reply --final`.",
    "Propose a learning update for configured authors; never apply it.",
  ]),
  skill("code-ai-review", "review", ["full"], "Run the legacy strict AI review profile.", [
    "Load the AI review baseline rule.",
    "Review branch changes from merge-base.",
    "Report concrete findings first.",
  ]),
  skill("code-learned-review", "review", ["full"], "Review against conventions this project learned from its own pull-request comments.", [
    "Read .metaproject/review-learning.config.json and the project skill it names.",
    "Apply that skill's learned lessons to the branch diff, citing the lesson behind each finding.",
    "Stop and say so when the project has no learned skill — this reviewer has no conventions of its own.",
  ]),
  skill("code-style-review", "review", ["full"], "Run the legacy code style and architecture review profile.", [
    "Load code-style rules and local conventions.",
    "Review naming, structure, boundaries, and TypeScript usage.",
    "Separate style issues from correctness defects.",
  ]),
  skill("code-mobx-store-review", "review", ["full"], "Run focused MobX store and state logic review.", [
    "Check actions, computed state, reactions, async boundaries, and view/store separation.",
    "Load MobX store template and local conventions.",
    "Report state bugs and maintainability risks.",
  ]),

  skill("security-audit", "quality", ["recommended", "full"], "Run dependency and secret/security checks and normalize findings.", [
    "Detect package manager and available audit commands.",
    "Scan for dependency advisories and accidentally committed secrets.",
    "Group findings by severity and remediation path.",
  ]),
  skill("metaproject-security", "quality", ["recommended", "full"], "Check Metaproject Security policies for prompts, external content, memory/wiki/report writes, PII, secrets, prompt injection, and data exfiltration.", [
    "Discover the security module and classify source/target context.",
    "Run or emulate check-input, check-output, scan, redact, and report workflows.",
    "Preserve safe storage: hashes and redacted previews, not raw secrets or prompts.",
  ]),
  skill("perf-check", "quality", ["recommended", "full"], "Run or summarize performance, bundle, and complexity checks.", [
    "Detect available perf, build, bundle, and complexity tools.",
    "Run low-risk checks and summarize regressions.",
    "Link issues to files, modules, and affected skills when possible.",
  ]),
  skill("root-cause", "quality", ["recommended", "full"], "Find the mechanism behind a reported defect, repair it, and leave a guard that fails without the repair.", [
    "Reproduce first and write the reproduction down as commands, input, expected and observed, with a rate for anything intermittent.",
    "Localize by halving the search space — history, call path, input, environment — changing one thing at a time.",
    "Reduce to the smallest failing case, then state the cause as a mechanism before changing anything.",
    "Leave a guard that was watched failing against the unfixed code; when nothing reproduces, report attempts, evidence and surviving hypotheses instead of a fix.",
  ]),
  skill("fresh-eyes", "quality", ["recommended", "full"], "Doubt work still in flight from a reader who was never told why it works.", [
    "Take the artifact and the contract it must satisfy; refuse the author's walkthrough, rationale, and \"I already checked that\".",
    "Ask only procedural questions — how to run it, which branch is live — and never why it is right.",
    "Raise a doubt only when it names a concrete failure, is anchored to a line or step, is checkable, and survives one honest re-read.",
    "Bound the loop before round one; end at the first round with no new qualifying doubt, and report finding nothing as a completed cycle.",
  ]),
  skill("api-truth", "quality", ["recommended", "full"], "Write dependency calls against the version installed here, and mark the ones that went out unchecked.", [
    "Read the version on disk — the package's own installed metadata — not the manifest range, and report a lockfile that disagrees with it.",
    "Spend the check where failure is silent: option bags, untyped surfaces, effects invisible locally, defaults changed in a minor; skip it where a type-check or a watched test already covers the call.",
    "Rank the evidence: the installed artefact and its shipped types first, then documentation pinned to that version, then a changelog; a post or a recollection is a lead, never proof.",
    "When documentation and the installed build disagree, follow the build, name both versions, and never branch the call site across the two.",
    "Mark every unchecked call at the site with what would settle it, and list them in the report — empty stated as empty.",
  ]),
  skill("test-gen", "quality", ["recommended", "full"], "Generate tests for a file or module using local patterns and existing test stack.", [
    "Discover test framework and nearby test examples.",
    "Generate tests that cover behavior, edge cases, and errors.",
    "Run focused tests when available.",
  ]),
  skill("tests-creator", "quality", ["recommended", "full"], "Create test scenarios before implementation from acceptance criteria and project patterns.", [
    "Read requirements and convert them into behavior scenarios.",
    "Map scenarios to the existing test stack.",
    "Prefer tests that fail for the missing behavior before implementation.",
  ]),
  skill("dependency-update", "quality", ["full"], "Plan and verify dependency upgrades.", [
    "Classify updates by risk.",
    "Apply small compatible groups first.",
    "Run relevant verification and document rollback notes.",
  ]),
  skill("db-migrate", "quality", ["full"], "Guide database migration creation, apply, rollback, status, and verification flows.", [
    "Detect migration tooling and existing conventions.",
    "Create minimal reversible migrations where possible.",
    "Run or describe verification and rollback steps.",
  ]),
  // Its SKILL.md carries "deployment" explicitly, because `-ment` is refused as
  // an inflection: "deployment" and "commitment" are the same shape and only
  // one is a routing request.
  skill("deploy", "quality", ["full"], "Run deployment pre-flight checks and deployment workflow summaries.", [
    "Detect deployment target and required pre-flight checks.",
    "Run verification before deployment unless explicitly skipped.",
    "Summarize deployment status, rollback path, and health checks.",
  ]),
  skill("commit", "quality", ["full"], "Prepare conventional commits with scope, summary, and verification notes.", [
    "Inspect staged and unstaged changes.",
    "Group related changes without staging unrelated work.",
    "Create a conventional commit message with verification summary.",
  ]),
  skill("push", "quality", ["full"], "Push branches with safety checks, upstream handling, and concise result summary.", [
    "Check branch and remote state.",
    "Push the current branch with upstream when needed.",
    "Report remote branch and any follow-up needed.",
  ]),
  skill("pr", "quality", ["full"], "Prepare pull request creation or update context from local changes.", [
    "Collect branch, commits, diff summary, tests, and risks.",
    "Draft concise PR title and description.",
    "Use project issue links when available.",
  ]),
  skill("pr-issue-documenter", "quality", ["recommended", "full"], "Create PR descriptions and linked issue documentation from branch changes.", [
    "Analyze commits and changed files.",
    "Group changes by area and user-visible behavior.",
    "Update or draft issue/PR documentation with technical context.",
  ]),
  skill("changelog", "quality", ["full"], "Generate changelog or release notes from commits, tags, or date ranges.", [
    "Identify the commit range.",
    "Group changes by type and user impact.",
    "Include linked PRs/issues when available.",
  ]),

  skill("brainstorm", "planning", ["recommended", "full"], "Explore architecture, product, or implementation options with trade-offs and recommendation.", [
    "Frame the decision and constraints.",
    "Compare pragmatic, innovative, and critical perspectives.",
    "Recommend a path with risks and next steps.",
  ]),
  skill("interviewer", "planning", ["recommended", "full"], "Scope a vague or expensive request before any context is collected (job-orchestrator 0.1.5, custom intent); for implementation specifics after context exists, use interview.", [
    "Ask only questions that materially affect implementation.",
    "Prefer short multiple-choice options with a recommended default.",
    "Stop once the task is specific enough to execute.",
  ]),
  skill("interview", "planning", ["recommended", "full"], "Clarify implementation ambiguities after context is collected and the goal is known (job-orchestrator 0.3, implement intent); to scope the request itself, use interviewer.", [
    "Clarify implementation ambiguities from the issue or task.",
    "Trigger brainstorm for unresolved architecture decisions.",
    "Return answers in a form the orchestrator can use for planning.",
  ]),
  skill("prd-creator", "planning", ["recommended", "full"], "Convert vague requests into structured PRD and acceptance criteria.", [
    "Extract users, goals, non-goals, constraints, and risks.",
    "Ask clarifying questions when needed.",
    "Write testable requirements and acceptance criteria.",
  ]),
  skill("project-discovery", "planning", ["full"], "Collect initial project facts, modules, constraints, stakeholders, and source references.", [
    "Inventory available docs, code modules, and entrypoints.",
    "Identify project purpose, users, constraints, and unknowns.",
    "Produce a structured discovery summary for PRD/spec work.",
  ]),
  skill("problem-definer", "planning", ["full"], "Define goals, non-goals, risks, constraints, and success metrics.", [
    "Separate problem, solution ideas, constraints, and open questions.",
    "Make goals and non-goals explicit.",
    "Define measurable success criteria.",
  ]),
  skill("stack-advisor", "planning", ["full"], "Recommend stack choices based on project level, constraints, team needs, and operational risk.", [
    "Classify project level and constraints.",
    "Compare stack options with trade-offs.",
    "Recommend a conservative default and explain risks.",
  ]),
  skill("patterns-researcher", "planning", ["full"], "Find architecture and implementation patterns for selected stack, domain, and project constraints.", [
    "Identify relevant existing local patterns first.",
    "Compare candidate patterns against constraints.",
    "Document chosen patterns and anti-patterns.",
  ]),
  skill("spec-writer", "planning", ["full"], "Write PRD, technical spec, or implementation plan constrained by decisions and evidence.", [
    "Collect source requirements and decisions.",
    "Write structured, testable sections.",
    "Link assumptions, open questions, and acceptance criteria.",
  ]),
  skill("consistency-checker", "planning", ["full"], "Check PRD, specs, plans, wiki, and decisions for contradictions or stale assumptions.", [
    "Compare documents against accepted decisions and current code context.",
    "Flag contradictions, missing constraints, and unsupported claims.",
    "Suggest minimal updates with provenance.",
  ]),
  skill("docpack-orchestrator", "planning", ["recommended", "full"], "Create or update Metaproject requirements packages under docs/requirements with PRD, specification, README, optional protocols/schemas, verification, review, and roadmap updates. Use autodoc-orchestrator instead for reverse-engineering current codebase documentation.", [
    "Design the required file set from requirements-package-standard.",
    "Write or update README, PRD, specification, optional policies/protocols/schemas.",
    "Run structural verification and docpack-review before final output.",
  ]),
  skill("docpack-review", "planning", ["recommended", "full"], "Review Metaproject requirements packages for completeness, versioning, consistency, schema references, roadmap updates, and unsupported implementation claims.", [
    "Check every file in the package against requirements-package-standard.",
    "Report blockers, warnings, and audit trail without rewriting docs.",
    "Verify README/PRD/spec consistency and honest implementation status.",
  ]),
  skill("planner", "planning", ["full"], "Produce roadmap, milestones, task breakdown, dependency graph, and sequencing.", [
    "Break goals into milestones and tasks.",
    "Identify dependencies, risks, and verification gates.",
    "Recommend execution order with small slices.",
  ]),
  skill("autodoc-orchestrator", "planning", ["full"], "Coordinate reverse-engineering documentation for an existing codebase.", [
    "Scan structure and identify documentation targets.",
    "Analyze modules in small batches.",
    "Assemble architecture, component, service, and decision docs.",
  ]),
  skill("autodoc-scanner", "planning", ["full"], "Scan an existing codebase to identify documentation targets and module boundaries.", [
    "Inventory structure, stack, entrypoints, and candidate modules.",
    "Produce a bounded scan report for autodoc orchestration.",
    "Avoid broad raw dumps; summarize evidence and gaps.",
  ]),
  skill("autodoc-analyst", "planning", ["full"], "Analyze one module, component, or service area for reverse-engineering documentation.", [
    "Read selected files and nearby context.",
    "Extract responsibilities, flows, dependencies, and risks.",
    "Return structured notes for documentation assembly.",
  ]),
  skill("autodoc-architect", "planning", ["full"], "Derive architecture-level documentation from scanned code and module analyses.", [
    "Identify architectural layers and dependency direction.",
    "Summarize system boundaries and major flows.",
    "Record assumptions and unknowns for verification.",
  ]),
  skill("autodoc-writer", "planning", ["full"], "Write Markdown documentation pages from autodoc analysis artifacts.", [
    "Convert structured analysis into readable docs.",
    "Link pages to code, wiki, and decisions.",
    "Keep unsupported claims explicit.",
  ]),
  skill("autodoc-assembler", "planning", ["full"], "Assemble reverse-engineered documentation into a coherent indexed documentation package.", [
    "Combine scanner, analyst, architect, and writer outputs.",
    "Generate indexes and cross-links.",
    "Report gaps and recommended follow-up pages.",
  ]),

  renderedSkill("agent-entrypoint-manager", "platform", ["minimal", "recommended", "full"], "Maintain AGENTS.md, CLAUDE.md, and local-first Metaproject references.", [
    "Find existing root agent entrypoints.",
    "Keep managed Metaproject blocks idempotent.",
    "Ensure local `.metaproject/index.md` and skill catalog are first-class references.",
  ], ["agents.md", "claude.md", "entrypoint"],
    "Use when AGENTS.md or CLAUDE.md needs its managed Metaproject block added, refreshed, or kept idempotent. NOT for: splitting an oversized entrypoint into rules and project-skills (see agent-entrypoint-distiller)."),
  skill("agent-entrypoint-distiller", "platform", ["minimal", "recommended", "full"], "Split large AGENTS.md/CLAUDE.md files into high-priority Metaproject rules and project-specific skills.", [
    "Run `keryx rules distill` when the user asks to decompose a large CLAUDE.md/AGENTS.md.",
    "Keep root entrypoints compact: non-project/highest-priority instructions plus `.metaproject/index.md` routing.",
    "Verify `.metaproject/rules/entrypoints/index.md`, `.metaproject/rules/entrypoints/`, and `.metaproject/project-skills/entrypoints/` were updated.",
  ]),
  renderedSkill("hook-manager", "platform", ["recommended", "full"], "Create and verify lightweight git hooks for graph, health, and skill verification.", [
    "Install hooks only when explicitly enabled.",
    "Keep hooks lightweight and idempotent.",
    "Avoid network and destructive behavior inside hooks.",
  ], ["install hook", "git hook", "post-commit"],
    "Use when a lightweight, explicitly-enabled git hook that runs graph, health, or skill verification after a commit, a checkout, or a merge needs installing or checking. NOT for: general hook design guidance not tied to these three (see hookify)."),
  skill("hookify", "platform", ["full"], "Use hook guidance for safe hook design and installation.", [
    "Detect existing hooks and preserve user content.",
    "Install idempotent managed blocks.",
    "Keep hooks lightweight and observable.",
  ]),
  skill("claude-md-management", "platform", ["full"], "Maintain CLAUDE.md and related agent entrypoint guidance.", [
    "Read existing agent entrypoints.",
    "Patch managed guidance without deleting user-authored content.",
    "Keep rule and skill links discoverable.",
  ]),
  renderedSkill("skill-catalog-manager", "platform", ["minimal", "recommended", "full"], "Generate `.metaproject/skills/catalog.md` and machine-readable skill registry.", [
    "Read bundled and project-local skill metadata.",
    "Generate concise catalog entries grouped by category.",
    "Keep catalog deterministic and local-first.",
  ], ["skill catalog", "list skills", "skills registry"],
    "Use when `.metaproject/skills/catalog.md` or the machine-readable skill registry is missing or out of date with bundled and project-local skill metadata. NOT for: turning skills into runtime artifacts (see skill-runtime-exporter) or pushing them to local runtimes (see skill-sync)."),
  renderedSkill("skill-runtime-exporter", "platform", ["full"], "Export canonical skills to runtime-compatible Codex or Claude artifacts.", [
    "Read canonical skill packages.",
    "Remove management-only files from runtime exports.",
    "Keep runtime `SKILL.md` concise with references, scripts, and assets as needed.",
  ], ["export skill", "runtime skill", "codex skill"],
    "Use when canonical skill packages need turning into runtime-compatible Codex or Claude artifacts, stripped of management-only files. NOT for: regenerating the skill catalog (see skill-catalog-manager) or pushing the export to local runtimes (see skill-sync)."),
  renderedSkill("skill-sync", "platform", ["full"], "Sync exported runtime skills to configured local runtimes only when explicitly enabled.", [
    "Read configured runtime targets.",
    "Validate runtime skill packages before sync.",
    "Sync only selected skills and report changed files.",
  ], ["sync skills", "install runtime skills", "global skill sync"],
    "Use when already-exported runtime skills need pushing to configured local runtimes, and only when sync is explicitly enabled. NOT for: producing the runtime export itself (see skill-runtime-exporter)."),
];

/**
 * A skill that ships a `SKILL.md` under `src/gdskills/bundled/skills`.
 *
 * Its description and triggers are not written here: they are read from that
 * file's frontmatter, so the router (which scores this entry, never the file)
 * and every agent that loads the file see one text. Flow 257 found the two had
 * split — 67 entries described themselves as a lowercased echo of `purpose`
 * ("Use when run full task pipelines…") while their SKILL.md carried a real
 * routing description, and the SKILL.md trigger lists had drifted into overlaps
 * the catalog had already curated away. With one place to edit there is
 * nothing to drift.
 *
 * Read on first access and cached: most of the CLI imports this module, and a
 * command that never routes should not pay for 67 file reads.
 */
function skill(
  name: string,
  category: BundledSkill["category"],
  profiles: Exclude<GdskillsProfile, "custom">[],
  purpose: string,
  workflow: string[],
): BundledSkill {
  let routing: BundledSkillRouting | undefined;
  const load = (): BundledSkillRouting => (routing ??= readBundledSkillRouting(category, name));
  return {
    name,
    category,
    get description(): string {
      return load().description;
    },
    purpose,
    workflow,
    get triggers(): string[] {
      return load().triggers;
    },
    profiles,
  };
}

/**
 * A skill with no bundled file: install renders its SKILL.md from this entry
 * (`renderBundledSkill`), so these literals are its only source. The
 * description is required — there is no fallback to `purpose`, which produced
 * "Use when <imperative>" for every entry that relied on it.
 */
function renderedSkill(
  name: string,
  category: BundledSkill["category"],
  profiles: Exclude<GdskillsProfile, "custom">[],
  purpose: string,
  workflow: string[],
  triggers: string[],
  description: string,
): BundledSkill {
  return { name, category, description, purpose, workflow, triggers, profiles };
}

export type BundledSkillRouting = { description: string; triggers: string[] };

/**
 * The bundled `SKILL.md` of a skill, or `undefined` when it ships none.
 *
 * Two candidates — the pair install.ts resolves for the same tree: next to this
 * module when running from source, and `../src/gdskills/bundled` from the built
 * `dist/` (the npm package ships `src/gdskills/bundled`; see package.json
 * `files`).
 */
export function bundledSkillMarkdownPath(category: string, name: string): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(here, "bundled", "skills", category, name, "SKILL.md"),
    path.join(here, "..", "src", "gdskills", "bundled", "skills", category, name, "SKILL.md"),
  ].find((candidate) => existsSync(candidate));
}

/**
 * A file-backed skill's routing fields, parsed the way `skills_catalog` and
 * `bundled-eval` parse them (`parseSkillFrontmatter`). Throws rather than
 * degrading: a skill routed on an empty description is the defect this exists
 * to remove, and a missing file is a packaging bug.
 */
export function readBundledSkillRouting(category: string, name: string): BundledSkillRouting {
  const file = bundledSkillMarkdownPath(category, name);
  if (file === undefined) {
    throw new Error(
      `bundled skill "${category}/${name}" ships no SKILL.md under src/gdskills/bundled/skills, and BUNDLED_GDSKILLS reads its description and triggers from there. Declare it with renderedSkill() if it has no file.`,
    );
  }
  const { description, triggers } = parseSkillFrontmatter(readFileSync(file, "utf8"));
  if (description === undefined || description.length === 0 || triggers === undefined || triggers.length === 0) {
    throw new Error(`${file}: frontmatter must declare a non-empty \`description\` and \`triggers:\` list; the skill router scores both.`);
  }
  return { description, triggers };
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
  // A `NOT for: <sibling>` clause carries a colon; quote the value whenever
  // one is present so the frontmatter stays a valid YAML scalar (the same
  // convention several bundled SKILL.md files already use for this reason).
  const descriptionField = skillEntry.description.includes(":")
    ? `description: ${JSON.stringify(skillEntry.description)}`
    : `description: ${skillEntry.description}`;

  return `---
name: ${skillEntry.name}
${descriptionField}
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
keryx skills create <target> --module <module> --name <skill-name>
keryx skills route <target>
keryx skills inspect <module>/<skill-name>
keryx skills verify <module>/<skill-name>
keryx skills status
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
Generated By: keryx

This catalog lists project-local working skills installed by \`keryx\`.

Resolution order:

1. \`.metaproject/index.md\`
2. \`.metaproject/routing.md\` when the compact index does not answer the intent
3. \`.metaproject/skills/catalog.md\`
4. \`.metaproject/project-skills/**\`
5. \`.metaproject/skills/gdskills/**\`
6. Explicitly allowed global fallback skills

## Agent Shortcuts

- User says \`создай скил для <path>\`, \`создай скилл для <file>\`, or \`create a skill for <target>\`: load \`gdskills/core/entity-skill-creator/SKILL.md\` and run the create-route-inspect-verify-status CLI flow yourself.
- User asks which project skill applies to a file/task: run \`keryx skills route <query-or-target>\` before reading broad files.
- User asks whether a project skill is still valid: run \`keryx skills verify <skill-or-target>\`.
- User asks to create/update a Metaproject requirements package, PRD/spec package, or \`docs/requirements/<name>\` documentation: load \`gdskills/planning/docpack-orchestrator/SKILL.md\`; use \`autodoc-orchestrator\` instead only for reverse-engineering documentation from the current codebase.

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

- \`keryx skills status\`
- \`keryx skills catalog --profile ${profile}\`
- \`keryx skills install --profile ${profile}\`

## Storage

- \`skills/gdskills/\` - installed working skills.
- \`project-skills/\` - generated entity/project skills.
- \`data/gdskills/\` - reports, proposals, and artifacts.
`;
}
