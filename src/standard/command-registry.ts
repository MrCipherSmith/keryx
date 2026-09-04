// Machine-readable command descriptor registry (flow 087, item 1).
//
// The `emit-llms` surface lists only command *names*. A harness that wants to
// CALL a command still has to guess flags, output shape, and whether a model is
// involved. This registry closes that gap: a single deterministic, typed
// catalog of every agent-facing `keryx` command — its natural-language intents,
// argument schema, output shape, side effects, and whether it invokes a model.
//
// ZERO runtime dependency and fully DETERMINISTIC: the descriptor list is a
// static literal (sorted on emit), so `keryx commands --json` is byte-stable and
// diffable. Consumers: `keryx commands` (agent-facing), `.metaproject/index.md`
// intent router, and future MCP tool generation.

/** One argument (positional or flag) of a command. */
export interface CommandArg {
  /** Flag name without dashes (`page`) or `<positional>` for a positional arg. */
  name: string;
  type: "string" | "enum" | "bool" | "number" | "path";
  /** Required to invoke the command meaningfully. Defaults to false. */
  required?: boolean;
  /** Allowed values when `type: "enum"`. */
  values?: string[];
  desc: string;
}

/** A single agent-callable command descriptor. */
export interface CommandDescriptor {
  /** Owning module key, e.g. `gdwiki`. */
  module: string;
  /** Full invocation stem, e.g. `wiki enrich`. */
  command: string;
  /** One-line summary of what it does. */
  summary: string;
  /** Natural-language intent phrases (ru + en) that should route here. */
  intent: string[];
  /** Argument schema. */
  args: CommandArg[];
  /** True when the command invokes a model provider (anthropic/ollama/…). */
  model?: boolean;
  /** Relative path to the prompt template a model command uses. */
  promptTemplate?: string;
  /** Whether the command supports `--json` structured output. */
  json?: boolean;
  /** Read-only (no writes, safe to call speculatively). */
  read?: boolean;
  /** Human-readable side effects when not read-only. */
  sideEffects?: string[];
}

/**
 * The curated registry. Order here is authoring order; every emit path sorts by
 * `(module, command)` so output is deterministic regardless of insertion order.
 */
export const COMMAND_DESCRIPTORS: CommandDescriptor[] = [
  // ---- gdgraph ----------------------------------------------------------
  {
    module: "gdgraph",
    command: "gdgraph affected",
    summary: "Blast radius of a file or symbol (transitive dependents).",
    intent: ["что сломается если изменить", "blast radius", "кто зависит от файла", "affected by change"],
    args: [{ name: "<file-or-symbol>", type: "string", required: true, desc: "file path or symbol name" }],
    json: true,
    read: true,
  },
  {
    module: "gdgraph",
    command: "gdgraph query",
    summary: "Structural graph queries: import cycles or orphan files.",
    intent: ["найди циклы", "find cycles", "orphan files", "сироты в графе"],
    args: [
      { name: "<cycles|orphans>", type: "enum", required: true, values: ["cycles", "orphans"], desc: "query kind" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    json: true,
    read: true,
  },
  // ---- gdctx ------------------------------------------------------------
  {
    module: "gdctx",
    command: "ctx rg",
    summary: "Token-aware code search (mandatory instead of raw rg/grep).",
    intent: ["найди в коде", "search code", "grep", "где встречается"],
    args: [
      { name: "<pattern>", type: "string", required: true, desc: "regex / literal pattern" },
      { name: "json", type: "bool", required: false, desc: "structured matches (our summary, not rg --json)" },
    ],
    json: true,
    // Persists a compacted artifact and the raw log on every run, so it is a
    // writer despite reading as a search. Was declared read-only, which would
    // have made it auto-allowable on a consumer that gates writes.
    read: false,
    sideEffects: [
      "writes .metaproject/data/gdctx/raw/**",
      "writes .metaproject/data/gdctx/artifacts/**",
      "spawns ripgrep with the caller's pattern",
    ],
  },
  // ---- gdwiki -----------------------------------------------------------
  {
    module: "gdwiki",
    command: "wiki index",
    summary: "Regenerate the wiki index (wiki/index.md).",
    intent: ["сделай индексацию вики", "reindex wiki", "обнови индекс вики", "wiki index"],
    args: [],
    read: false,
    sideEffects: ["writes wiki/index.md"],
  },
  {
    module: "gdwiki",
    command: "wiki enrich",
    summary: "Enrich draft wiki pages with prose via a model provider.",
    intent: ["обогати вики", "enrich wiki", "допиши страницу вики", "enrich wiki page", "заполни вики"],
    args: [
      { name: "page", type: "string", required: false, desc: "page slug/relative path; default is all draft pages" },
      { name: "all", type: "bool", required: false, desc: "enrich every draft page" },
      { name: "prompt", type: "string", required: false, desc: "extra enrichment instruction merged into the template" },
      { name: "provider", type: "enum", required: false, values: ["anthropic", "ollama", "openrouter", "grok"], desc: "model provider" },
      { name: "model", type: "string", required: false, desc: "model id" },
      { name: "dry-run", type: "bool", required: false, desc: "print the enriched draft without writing" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    model: true,
    promptTemplate: "wiki/enrich.prompt.md",
    json: true,
    read: false,
    sideEffects: ["writes wiki/** page bodies", "calls a model provider"],
  },
  {
    module: "gdwiki",
    command: "wiki freshness",
    summary: "Report which wiki pages a code change puts in doubt, and why. Read-only.",
    intent: [
      "какие страницы вики устарели",
      "wiki freshness",
      "свежесть вики",
      "what documentation is stale",
      "which wiki pages need updating",
    ],
    args: [
      { name: "since", type: "string", required: false, desc: "base revision; defaults to the freshness queue, then HEAD~1" },
      { name: "all", type: "bool", required: false, desc: "include advisory (fyi) rows, hidden by default" },
      { name: "json", type: "bool", required: false, desc: "structured report (schemas/freshness-report.schema.json)" },
    ],
    json: true,
    // `read: false`, despite changing no wiki page and no source file.
    //
    // I first set this `true` on the reasoning that it is read-only "in the
    // sense that matters", and the registry's own coverage guard rejected it:
    // a descriptor may not claim read-only while declaring side effects. The
    // guard is right and the reasoning was not. `read` feeds `isAutoAllowable`,
    // so `true` here would let an agent invoke it with no approval — and it
    // writes. Whether the write is small is beside the point.
    //
    // The MCP surface `wiki_freshness` is the genuinely read-only way to ask
    // this question: it reads the report and writes nothing at all.
    read: false,
    sideEffects: ["writes data/wiki/freshness/latest.{json,md}"],
  },
  {
    module: "gdwiki",
    command: "wiki refresh",
    summary: "Regenerate managed Reference blocks from the code graph. Deterministic; calls no model.",
    intent: ["обнови reference вики", "wiki refresh", "перегенерируй справочник страницы", "refresh wiki reference"],
    args: [
      { name: "page", type: "string", required: false, desc: "wiki-relative page path; default is every page with a managed block" },
      { name: "force", type: "bool", required: false, desc: "overwrite a block that was edited by hand" },
      { name: "dry-run", type: "bool", required: false, desc: "report what would change without writing" },
      { name: "json", type: "bool", required: false, desc: "structured result" },
    ],
    json: true,
    read: false,
    sideEffects: [
      "rewrites the managed Reference block of affected pages",
      "bumps page Version and appends one Changelog line",
      "stamps VerifiedAt and VerifiedScope on refreshed pages",
    ],
  },
  {
    module: "gdwiki",
    command: "wiki verify",
    summary: "Stamp page provenance. --page records a review; --baseline sets a measurement starting line.",
    intent: ["подтверди страницу вики", "wiki verify", "отметь страницу как проверенную", "stamp wiki provenance"],
    args: [
      { name: "page", type: "string", required: false, desc: "wiki-relative page path — records that this page was reviewed" },
      { name: "baseline", type: "bool", required: false, desc: "stamp the whole corpus as a starting line; NOT a claim the pages were read" },
      { name: "json", type: "bool", required: false, desc: "structured result" },
    ],
    json: true,
    read: false,
    sideEffects: ["writes VerifiedAt and VerifiedScope into page frontmatter"],
  },
  {
    module: "gdwiki",
    command: "wiki migrate-markers",
    summary: "One-off: wrap existing Reference sections in managed-block markers. Idempotent; authors no content.",
    intent: ["добавь маркеры в вики", "wiki migrate markers", "разметь reference блоки"],
    args: [
      { name: "dry-run", type: "bool", required: false, desc: "report what would change without writing" },
      { name: "json", type: "bool", required: false, desc: "structured result" },
    ],
    json: true,
    read: false,
    sideEffects: ["inserts marker comments around the Reference section of pages that have one"],
  },
  // ---- memory -----------------------------------------------------------
  {
    module: "memory",
    command: "memory reflect",
    summary: "Cluster related memory; --narrate adds a model summary of themes.",
    intent: ["обобщи память", "reflect memory", "consolidate memory", "темы в памяти"],
    args: [
      { name: "narrate", type: "bool", required: false, desc: "add a model narration of clusters" },
      { name: "provider", type: "enum", required: false, values: ["anthropic", "ollama", "openrouter", "grok"], desc: "model provider (with --narrate)" },
    ],
    model: true,
    promptTemplate: "(inline: memory reflect narration)",
    read: false,
    sideEffects: ["writes pattern drafts under memory/"],
  },
  {
    module: "memory",
    command: "memory search",
    summary: "Pure ranked search over canonical Markdown memory; optional explicit bounded report publication.",
    intent: ["вспомни", "search memory", "были ли решения по", "past decisions"],
    args: [
      { name: "<query>", type: "string", required: true, desc: "search query" },
      { name: "status", type: "string", required: false, desc: "filter by status (e.g. accepted)" },
      { name: "module", type: "string", required: false, desc: "filter by module" },
      { name: "entity", type: "string", required: false, desc: "filter by entity" },
      { name: "limit", type: "number", required: false, desc: "result limit from 1 to 100" },
      { name: "as-of", type: "string", required: false, desc: "calendar date for point-in-time validity" },
      { name: "class", type: "enum", required: false, values: ["semantic", "episodic", "procedural"], desc: "filter by memory class" },
      { name: "semantic", type: "bool", required: false, desc: "request optional semantic reranking; falls back to lexical" },
      { name: "save-report", type: "bool", required: false, desc: "explicitly persist a bounded per-run report under ignored runtime storage" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    json: true,
    read: true,
  },
  {
    module: "memory",
    command: "memory transition",
    summary: "Explicitly transition a canonical memory entry through the validated guarded lifecycle seam.",
    intent: ["transition memory", "change memory status", "accept memory", "deprecate memory"],
    args: [
      { name: "<path>", type: "path", required: true, desc: "memory-root-relative entry path" },
      { name: "to", type: "enum", required: true, values: ["draft", "accepted", "conflict", "deprecated"], desc: "target lifecycle status" },
      { name: "reason", type: "string", required: false, desc: "bounded transition reason recorded in provenance/changelog" },
    ],
    read: false,
    sideEffects: ["validates and atomically updates one canonical Markdown entry", "may be blocked by security policy"],
  },
  {
    module: "memory",
    command: "memory supersede",
    summary: "Explicitly supersede one canonical memory entry with another using guarded atomic pair persistence.",
    intent: ["supersede memory", "replace memory entry", "retire memory decision"],
    args: [
      { name: "<old-path>", type: "path", required: true, desc: "entry to mark superseded" },
      { name: "by", type: "path", required: true, desc: "replacement entry path" },
      { name: "date", type: "string", required: false, desc: "effective calendar date" },
    ],
    read: false,
    sideEffects: ["validates and atomically updates both canonical Markdown entries", "may be blocked by security policy"],
  },
  // ---- health -----------------------------------------------------------
  {
    module: "health",
    command: "health run",
    summary: "Run the aggregate quality gate (lint/type/test/complexity).",
    intent: ["проверь качество", "run health", "quality gate", "прогони health"],
    args: [
      { name: "strict", type: "bool", required: false, desc: "fail on warnings" },
      { name: "json", type: "bool", required: false, desc: "structured JSON report" },
    ],
    json: true,
    read: false,
    // The subprocess entry is not padding: an approval rendered from these
    // effects would otherwise present arbitrary command execution — the lint and
    // test commands come from the checked-out project's own config — as a
    // benign artifact write.
    sideEffects: [
      "writes data/health/artifacts/**",
      "executes the project's configured lint / type-check / test commands",
    ],
  },
  {
    module: "health",
    command: "health explain",
    summary: "Explain a file/module's health; --narrate adds model remediation steps.",
    intent: ["объясни health", "explain health", "почему низкий score", "how to fix health"],
    args: [
      { name: "<file-or-module>", type: "string", required: true, desc: "target scope" },
      { name: "narrate", type: "bool", required: false, desc: "add a model narration + fixes" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result (with --narrate)" },
    ],
    model: true,
    promptTemplate: "(inline: health explain narration)",
    json: true,
    read: true,
  },
  // ---- testing ----------------------------------------------------------
  {
    module: "testing",
    command: "test suggest",
    summary: "Model-generated test plan for a file, matching project frameworks.",
    intent: ["предложи тесты", "suggest tests", "какие тесты написать", "test plan for file"],
    args: [
      { name: "<file>", type: "path", required: true, desc: "source file to plan tests for" },
      { name: "provider", type: "enum", required: false, values: ["anthropic", "ollama", "openrouter", "grok"], desc: "model provider" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    model: true,
    promptTemplate: "(inline: test suggest)",
    json: true,
    read: true,
  },
  {
    module: "testing",
    command: "test run",
    summary: "Run tests through the project runner and normalize the report.",
    intent: ["прогони тесты", "run tests", "запусти тесты", "test changed"],
    args: [
      { name: "changed", type: "bool", required: false, desc: "only tests affected by changes" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    json: true,
    read: false,
    sideEffects: [
      "writes data/testing/artifacts/**",
      "executes the project's configured test command",
    ],
  },
  // ---- tasks / flow -----------------------------------------------------
  {
    module: "tasks",
    command: "flow plan",
    summary: "Model-suggested atomic task breakdown from a flow's description + AC.",
    intent: ["разбей на задачи", "plan flow", "decompose flow", "task breakdown"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "flow id" },
      { name: "provider", type: "enum", required: false, values: ["anthropic", "ollama", "openrouter", "grok"], desc: "model provider" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    model: true,
    promptTemplate: "(inline: flow plan)",
    json: true,
    read: true,
  },
  {
    module: "tasks",
    command: "flow list",
    summary: "List managed work items (flows) and their status.",
    intent: ["покажи флоу", "list flows", "какие задачи в работе", "active flows"],
    args: [{ name: "json", type: "bool", required: false, desc: "structured JSON result" }],
    json: true,
    read: true,
  },
  // ---- gdskills / job packages ------------------------------------------
  {
    module: "gdskills",
    command: "job init",
    summary: "Create a job package (.metaproject/jobs/<name>/) with a plan for the intent.",
    intent: ["создай job", "start a job", "new job package", "job-orchestrator init"],
    args: [
      { name: "name", type: "string", required: true, desc: "job slug, lowercase/digits/hyphens" },
      {
        name: "intent",
        type: "enum",
        required: false,
        values: ["implement", "analyze", "review", "custom"],
        desc: "which default plan to build (default: implement)",
      },
      { name: "project", type: "path", required: false, desc: "project dir recorded in context" },
    ],
    json: false,
    read: false,
    sideEffects: [
      "creates .metaproject/jobs/<name>/",
      "writes .metaproject/jobs/<name>/state.json",
      "writes .metaproject/jobs/<name>/journal.md",
    ],
  },
  {
    module: "gdskills",
    command: "job list",
    summary: "List job packages with phase, intent, step progress and next open step.",
    intent: ["покажи джобы", "list jobs", "какие job пакеты есть", "job packages"],
    args: [{ name: "json", type: "bool", required: false, desc: "structured JSON result" }],
    json: true,
    read: true,
  },
  {
    module: "gdskills",
    command: "job status",
    summary: "Report a job's phase, per-step status, retry counts and the first non-terminal step.",
    intent: ["статус job", "job status", "где остановился job", "resume job"],
    args: [
      { name: "<name>", type: "string", required: true, desc: "job name" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    json: true,
    read: true,
  },
  {
    module: "gdskills",
    command: "job step",
    summary: "Record a plan step's status; re-entering a step increments its retry counter.",
    intent: ["отметь шаг job", "record job step", "job step status", "mark step completed"],
    args: [
      { name: "<name>", type: "string", required: true, desc: "job name" },
      { name: "<step-id>", type: "string", required: true, desc: "step id from the job's plan" },
      {
        name: "status",
        type: "enum",
        required: true,
        values: ["pending", "in-progress", "completed", "skipped", "failed"],
        desc: "new step status",
      },
      { name: "reason", type: "string", required: false, desc: "why the step ended this way" },
    ],
    json: false,
    read: false,
    sideEffects: [
      "writes .metaproject/jobs/<name>/state.json",
      "appends .metaproject/jobs/<name>/journal.md",
    ],
  },
  {
    module: "gdskills",
    command: "job document",
    summary: "Record a job document into the package and list it in the state file.",
    intent: ["добавь документ в job", "record job document", "attach analysis to job"],
    args: [
      { name: "<name>", type: "string", required: true, desc: "job name" },
      {
        name: "type",
        type: "enum",
        required: true,
        values: ["analysis", "implementation-report", "review", "verification-report"],
        desc: "document kind",
      },
      { name: "file", type: "path", required: true, desc: "existing file to record" },
    ],
    json: false,
    read: false,
    sideEffects: [
      "copies the file into .metaproject/jobs/<name>/",
      "writes .metaproject/jobs/<name>/state.json",
      "appends .metaproject/jobs/<name>/journal.md",
    ],
  },
  {
    module: "gdskills",
    command: "job complete",
    summary: "Close a job; refuses while any plan step is non-terminal or failed.",
    intent: ["заверши job", "complete job", "close job package"],
    args: [{ name: "<name>", type: "string", required: true, desc: "job name" }],
    json: false,
    read: false,
    sideEffects: [
      "writes .metaproject/jobs/<name>/state.json",
      "appends .metaproject/jobs/<name>/journal.md",
    ],
  },
  {
    module: "tasks",
    command: "flow renumber",
    summary: "Give a flow a new number and record the move (repairs duplicate ids).",
    intent: [
      "переномеруй флоу",
      "дубликаты номеров флоу",
      "renumber flow",
      "duplicate flow id",
      "fix flow numbering",
    ],
    args: [
      { name: "<dir>", type: "string", required: true, desc: "flow directory name" },
      { name: "to", type: "string", required: true, desc: "free three-digit id" },
      { name: "reason", type: "string", required: true, desc: "why the flow is being renumbered" },
    ],
    json: false,
    read: false,
    sideEffects: ["renames .metaproject/flows/**", "writes .metaproject/flows/id-map.json"],
  },
  // ---- sandbox (OS containment visibility) ------------------------------
  {
    module: "sandbox",
    command: "sandbox status",
    summary:
      "OS sandbox launcher availability and the per-capability containment matrix for this platform. Report only — never runs a contained command, always exits 0.",
    intent: [
      "проверь sandbox",
      "статус песочницы",
      "sandbox status",
      "is bubblewrap installed",
      "установлен ли bubblewrap",
      "os containment status",
      "check os sandbox",
      "какая изоляция доступна",
    ],
    args: [{ name: "json", type: "bool", required: false, desc: "structured JSON report" }],
    json: true,
    read: true,
  },
  // ---- security ---------------------------------------------------------
  {
    module: "security",
    command: "security scan",
    summary: "Policy-based scan for secrets / PII / injection over a path.",
    intent: ["проверь на секреты", "security scan", "просканируй", "scan for secrets"],
    args: [
      { name: "<path>", type: "path", required: true, desc: "file or directory to scan" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    json: true,
    read: false,
    sideEffects: [
      "writes .metaproject/data/security/artifacts/latest.md",
      "writes .metaproject/data/security/artifacts/latest.json",
    ],
  },
  // ---- agents (subagent fleet) ------------------------------------------
  {
    module: "agents",
    command: "agents monitor",
    summary: "Fold a subagent agent-event stream into a fleet snapshot (status/model/tokens).",
    intent: ["покажи сабагентов", "статус флота агентов", "monitor subagents", "fleet status", "agents snapshot"],
    args: [
      { name: "<events-file>", type: "path", required: true, desc: "agent-event source (JSON array or JSONL)" },
      { name: "json", type: "bool", required: false, desc: "emit the raw AgentsSnapshot as JSON" },
    ],
    json: true,
    read: true,
  },
  // ---- maintenance ------------------------------------------------------
  // The "bring a project up" commands. They were absent while the registry
  // covered only query surfaces, which left an agent no machine-readable way to
  // learn they exist. `read: false` here is literal: each writes into
  // `.metaproject/`, and a consumer that classifies write operations as
  // approval-gated depends on that flag being honest.
  {
    module: "gdgraph",
    command: "gdgraph build",
    summary: "Build or refresh the code dependency graph for this project.",
    intent: ["построй граф", "обнови граф", "build the code graph", "rebuild graph", "reindex dependencies"],
    args: [],
    json: false,
    read: false,
    sideEffects: ["writes .metaproject/data/gdgraph/**"],
  },
  {
    module: "gdctx",
    command: "ctx status",
    summary: "Compact-context module status: artifact counts and last run.",
    intent: ["статус ctx", "ctx status", "compact context status"],
    args: [],
    json: false,
    read: true,
  },
  {
    module: "gdwiki",
    command: "wiki collect",
    summary: "Collect wiki pages from the codebase into the knowledge base.",
    intent: ["собери вики", "collect wiki", "wiki collect", "заполни вики"],
    args: [
      { name: "force", type: "bool", required: false, desc: "recollect pages that already exist" },
      { name: "changed", type: "bool", required: false, desc: "only pages affected by changed files" },
      { name: "since", type: "string", required: false, desc: "git ref to diff against when --changed is set" },
      { name: "limit", type: "number", required: false, desc: "maximum pages to collect" },
    ],
    json: false,
    read: false,
    sideEffects: ["writes .metaproject/wiki/**"],
  },
  {
    module: "gdwiki",
    command: "wiki check-links",
    summary: "Verify every wiki link resolves; reports broken references.",
    intent: ["проверь ссылки вики", "check wiki links", "broken links", "битые ссылки"],
    args: [],
    json: false,
    // Reads the wiki but persists a report, so it is not read-only. Named as a
    // writer because a consumer gating writes must gate this one too.
    read: false,
    sideEffects: ["writes .metaproject/data/gdwiki/link-check/latest.md"],
  },
  {
    module: "memory",
    command: "memory index",
    summary: "Rebuild the project memory index.",
    intent: ["переиндексируй память", "reindex memory", "memory index", "обнови индекс памяти"],
    args: [
      { name: "embeddings", type: "bool", required: false, desc: "also build local embeddings (requires the model asset)" },
    ],
    json: false,
    read: false,
    sideEffects: [
      "writes .metaproject/data/memory/index/**",
      "writes the memory provenance record",
    ],
  },
  {
    module: "testing",
    command: "test analyze",
    summary: "Analyze the test suite and refresh the testing context report.",
    intent: ["проанализируй тесты", "analyze tests", "test analyze", "обнови контекст тестов"],
    args: [],
    json: false,
    read: false,
    sideEffects: ["writes .metaproject/data/testing/**"],
  },
  {
    module: "testing",
    command: "test status",
    summary: "Testing module status: last analysis and report freshness.",
    intent: ["статус тестов", "test status", "testing status"],
    args: [],
    json: false,
    read: true,
  },
  // ---- core (toolkit itself) --------------------------------------------
  {
    module: "core",
    command: "status",
    summary: "Metaproject workspace status: enabled modules and artifact freshness.",
    intent: ["статус проекта", "project status", "keryx status", "что включено"],
    args: [],
    json: false,
    read: true,
  },
  {
    module: "core",
    command: "projects list",
    summary: "List the projects this keryx install has been initialized in.",
    intent: ["какие проекты", "list projects", "где развёрнут keryx", "registered projects", "покажи проекты"],
    args: [{ name: "json", type: "bool", required: false, desc: "structured registry projection" }],
    json: true,
    read: true,
  },
  {
    module: "core",
    command: "projects register",
    summary: "Register an already-initialized project in the user-global registry.",
    intent: ["зарегистрируй проект", "register project", "добавь проект в реестр"],
    args: [{ name: "<path>", type: "path", required: true, desc: "path to an initialized keryx project" }],
    json: false,
    read: false,
    sideEffects: ["writes the user-global projects.json"],
  },
  {
    module: "core",
    command: "projects forget",
    summary: "Remove one project from the user-global registry.",
    intent: ["забудь проект", "forget project", "убери проект из реестра"],
    args: [{ name: "<id>", type: "string", required: true, desc: "project id from `keryx projects list --json`" }],
    json: false,
    read: false,
    sideEffects: ["writes the user-global projects.json"],
  },
  {
    module: "core",
    command: "modules status",
    summary: "Which Metaproject modules are enabled for this project.",
    intent: ["какие модули включены", "module status", "list modules", "статус модулей"],
    args: [{ name: "json", type: "bool", required: false, desc: "structured module state" }],
    json: true,
    read: true,
  },
  {
    module: "core",
    command: "version check",
    summary: "Check the fixed npm latest endpoint for a newer Keryx release.",
    intent: ["check keryx version", "check for update", "проверь версию keryx"],
    args: [{ name: "json", type: "bool", required: false, desc: "typed structured result" }],
    json: true,
    read: true,
  },
  // ---- providers --------------------------------------------------------
  // Both are read-only and network-free: they report over `llm-providers.json`
  // plus the built-in registry and exit. `model: false` is therefore honest —
  // neither spends a token. `cross-family` in particular never DISPATCHES a
  // review; it decides whether one may cross families and prints the record.
  {
    module: "providers",
    command: "providers list",
    summary: "Providers this operator has configured, and the model family of each.",
    intent: ["какие провайдеры настроены", "list providers", "configured providers", "провайдеры"],
    args: [{ name: "json", type: "bool", required: false, desc: "structured provider/family list" }],
    json: true,
    read: true,
  },
  {
    module: "providers",
    command: "providers cross-family",
    summary: "Whether review may run on a different model family than authored the change (opt-in).",
    intent: [
      "кросс-фэмили ревью",
      "cross family review",
      "review with a different model family",
      "какой семьёй ревьюить",
    ],
    args: [
      { name: "opt-in", type: "bool", required: false, desc: "request cross-family review; without it the answer is single-family" },
      { name: "session-provider", type: "string", required: false, desc: "provider that authored the change; defaults to the persisted shell selection" },
      { name: "session-model", type: "string", required: false, desc: "model that authored the change; defaults to the persisted shell selection" },
      { name: "json", type: "bool", required: false, desc: "the record a round should carry" },
    ],
    json: true,
    read: true,
  },
];

/**
 * Whether a consumer may run this command without asking the operator.
 *
 * `read` answers one question only — does it mutate the workspace. It is NOT
 * the same question as "is it safe to run unattended", and conflating the two
 * is how three model-backed commands ended up eligible for silent execution:
 * `health explain`, `test suggest` and `flow plan` write nothing, so `read` is
 * legitimately true, but each spends provider tokens and makes an outbound call
 * carrying the operator's credential. Cost is a consequence the operator is
 * entitled to approve even when nothing is written.
 *
 * So auto-allow requires both: it does not write, and it does not spend.
 */
export function isAutoAllowable(descriptor: CommandDescriptor): boolean {
  return descriptor.read === true && descriptor.model !== true;
}

/** Deterministic sort key: module then command. */
function sortKey(descriptor: CommandDescriptor): string {
  // Separator is a real NUL, written as the escape \u0000 so this source
  // file stays plain text. A literal NUL byte makes ripgrep classify the
  // whole file as binary and silently skip it, and this registry is the
  // command-routing source of truth agents are told to search. NUL sorts
  // below every real character, giving an unambiguous module|command
  // boundary even though command values contain spaces (e.g. 'flow plan').
  return `${descriptor.module}\u0000${descriptor.command}`;
}

/** Return descriptors sorted deterministically, optionally filtered by module. */
export function listDescriptors(module?: string): CommandDescriptor[] {
  const filtered = module
    ? COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.module === module)
    : COMMAND_DESCRIPTORS;
  return [...filtered].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/** Find the descriptor whose intent phrases best match a natural-language query. */
export function matchIntent(query: string): CommandDescriptor[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [];
  }
  const scored = listDescriptors()
    .map((descriptor) => {
      let score = 0;
      for (const phrase of descriptor.intent) {
        const needle = phrase.toLowerCase();
        if (normalized.includes(needle) || needle.includes(normalized)) {
          score = Math.max(score, needle.length);
        }
      }
      return { descriptor, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.descriptor);
}

/** Machine-readable JSON payload (stable shape for the harness / MCP). */
export function emitCommandsJson(module?: string): string {
  const payload = {
    schemaVersion: 1,
    commands: listDescriptors(module),
  };
  return JSON.stringify(payload, null, 2);
}

/** Human/agent-facing Markdown rendering of the registry. */
export function renderCommandsMarkdown(module?: string): string {
  const descriptors = listDescriptors(module);
  const lines: string[] = [];
  lines.push("# keryx commands");
  lines.push("");
  lines.push("> Agent-callable command registry: intents, argument schema, output shape, and model usage.");
  lines.push("");

  let currentModule = "";
  for (const descriptor of descriptors) {
    if (descriptor.module !== currentModule) {
      currentModule = descriptor.module;
      lines.push(`## ${currentModule}`);
      lines.push("");
    }
    const badges: string[] = [];
    if (descriptor.model) badges.push("model");
    if (descriptor.json) badges.push("json");
    if (descriptor.read) badges.push("read-only");
    const badgeNote = badges.length > 0 ? ` _(${badges.join(", ")})_` : "";
    lines.push(`### \`keryx ${descriptor.command}\`${badgeNote}`);
    lines.push("");
    lines.push(descriptor.summary);
    lines.push("");
    lines.push(`- intents: ${descriptor.intent.map((phrase) => `\`${phrase}\``).join(", ")}`);
    if (descriptor.args.length > 0) {
      lines.push("- args:");
      for (const arg of descriptor.args) {
        const req = arg.required ? " (required)" : "";
        const values = arg.values ? ` [${arg.values.join("|")}]` : "";
        lines.push(`  - \`${arg.name}\`${req}: ${arg.type}${values} — ${arg.desc}`);
      }
    }
    if (descriptor.promptTemplate) {
      lines.push(`- prompt template: \`${descriptor.promptTemplate}\``);
    }
    if (descriptor.sideEffects && descriptor.sideEffects.length > 0) {
      lines.push(`- side effects: ${descriptor.sideEffects.join("; ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Render the compact intent → command table used by `.metaproject/index.md`. */
export function renderIntentTable(): string {
  const lines: string[] = [];
  lines.push("| User intent | Command |");
  lines.push("|-------------|---------|");
  for (const descriptor of listDescriptors()) {
    for (const phrase of descriptor.intent) {
      lines.push(`| ${phrase} | \`keryx ${descriptor.command}\` |`);
    }
  }
  return `${lines.join("\n")}\n`;
}
