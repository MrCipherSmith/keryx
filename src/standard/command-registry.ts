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

import { SCHEDULE_DESCRIPTORS } from "./schedule-descriptors";

/**
 * `src/harness/routing/table.ts`'s `ROUTING_CATEGORIES`, restated as a
 * literal — NOT imported. `src/standard/` is a CORE zone module
 * (`src/lib/import-zones.ts`) and `src/harness/` is CLIENT; core never
 * imports client, no exception (`src/lib/import-policy.ts`), the same reason
 * `help-groups.ts` in this same directory restates its own summaries by hand
 * rather than importing `CLI_ROUTES`/`AGENT_SLASH_COMMANDS`. Kept in sync by
 * `command-registry.routing-categories.test.ts`.
 */
const ROUTING_CATEGORIES_LITERAL = [
  "default",
  "review",
  "subagents",
  "quick",
  "coding",
  "planning",
  "docs",
  "unattended",
] as const;

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
    summary:
      "Report which wiki pages a code change puts in doubt, and why. NOT read-only: " +
      "overwrites the report artifacts and consumes (deletes) the accumulated freshness queue.",
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
    // CORRECTION (flow 236 T9): the `sideEffects` list below named the two
    // artifact overwrites and stopped there, and the summary above still said
    // "Read-only." — both wrong the same way `read: true` would have been
    // wrong. `runFreshnessCommand` (`commands/wiki.ts`) calls `runFreshness`
    // (`wiki/freshness/run.ts`), which — whenever it drained anything —
    // deletes `data/wiki/freshness-queue.jsonl` outright. A consumer reading
    // only the old two-item list would have no way to know the accumulated
    // backlog is gone once the report lands, which is exactly the gap this
    // registry exists to close: a machine-readable side-effect declaration an
    // agent may act on without asking is the one place understating a delete
    // is least survivable.
    //
    // The MCP surface `wiki_freshness` is the genuinely read-only way to ask
    // this question: it reads the report and writes nothing at all.
    read: false,
    sideEffects: [
      "writes data/wiki/freshness/latest.{json,md}",
      "DELETES data/wiki/freshness-queue.jsonl once the report is on disk (whenever it drained anything)",
    ],
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
    // CORRECTION (flow 236 T9): "stamps VerifiedAt and VerifiedScope on
    // refreshed pages" used to be unconditional. It is not: `resolveWikiSourceGate`
    // (`wiki/staleness.ts`, AFC-08) makes the stamp conditional on the code
    // graph demonstrably being current. A stale-but-not-errored graph still
    // gets its Reference block repaired (the content is still what that graph
    // says), but VerifiedAt/VerifiedScope are left untouched — an unstamped
    // page, not a dishonestly-stamped one. A graph in ERROR preserves the
    // existing block entirely (action `stale-source`) rather than rewriting
    // it from a source that could not be interrogated.
    sideEffects: [
      "rewrites the managed Reference block of affected pages (preserved, not rewritten, when the source graph is in error)",
      "bumps page Version and appends one Changelog line for each page actually rewritten",
      "stamps VerifiedAt and VerifiedScope on refreshed pages ONLY when the code graph is demonstrably current (resolveWikiSourceGate); otherwise the stamp is left exactly as it was",
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
  {
    module: "tasks",
    command: "flow status",
    summary: "One flow's full status: lifecycle state, AC freeze/confirmation count, PR, owner, latest signature, task list, and recent history.",
    intent: ["статус флоу", "flow status", "flow details", "show one flow"],
    args: [{ name: "<id>", type: "string", required: true, desc: "flow id" }],
    json: false,
    read: true,
  },
  {
    module: "tasks",
    command: "flow init",
    summary:
      "Create a new flow (managed work item): allocates an id, scaffolds its directory, and collects initial " +
      "context from the source issue if one is given. `--owner` is NEVER inferred — only an explicit value " +
      "on this command populates it.",
    intent: ["создай флоу", "flow init", "start a new flow", "new managed work item", "заведи флоу"],
    args: [
      { name: "title", type: "string", required: false, desc: "work title; required unless --issue is given" },
      { name: "issue", type: "string", required: false, desc: "tracker issue URL; required unless --title is given" },
      { name: "slug", type: "string", required: false, desc: "override the slug the directory name derives from the title" },
      { name: "base", type: "string", required: false, desc: "the branch this work is intended to land on; read back by `flow complete`'s base-branch gate" },
      { name: "owner", type: "string", required: false, desc: "the human accountable for this flow; left unset (not inferred) when omitted" },
      {
        name: "require-confirmation",
        type: "bool",
        required: false,
        desc: "opt this flow into the confirmation gate: `flow complete` then needs a token minted by `flow confirm` (flow 299)",
      },
    ],
    json: false,
    read: false,
    sideEffects: [
      "creates .metaproject/flows/<id>-<date>-<slug>/",
      "writes description.md, context.md, plan.md, tasks.md, acceptance-criteria.md, journal.md and flow.json in that directory",
    ],
  },
  {
    module: "tasks",
    command: "flow owner set",
    summary: 'Set the human accountable for a flow. Never inferred — only this command, or `--owner` on `flow init`, populates it.',
    intent: ["назначь владельца флоу", "flow owner set", "set flow owner", "who owns this flow", "владелец флоу"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "flow id" },
      { name: "owner", type: "string", required: true, desc: "the accountable human's name/identity" },
      { name: "reason", type: "string", required: true, desc: "why the owner is being set" },
    ],
    json: false,
    read: false,
    sideEffects: ["writes flow.json's owner field (basis: stated) and appends a history entry"],
  },
  {
    module: "tasks",
    command: "flow ac confirm",
    summary:
      "Confirm one frozen acceptance criterion as satisfied, with optional evidence. Appends a NEW signature " +
      "rather than replacing an existing one, so re-confirming a criterion keeps the full signing history.",
    intent: ["подтверди критерий", "flow ac confirm", "confirm acceptance criterion", "mark AC done", "подтверди AC"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "flow id" },
      { name: "<ACn>", type: "string", required: true, desc: "criterion id, e.g. AC1" },
      { name: "note", type: "string", required: false, desc: "evidence recorded alongside the confirmation" },
      {
        name: "signed-by",
        type: "string",
        required: false,
        desc:
          "explicit signer identity (stated); falls back to KERYX_ACTOR (stated), then the local git identity " +
          '(derived), then "unknown" — none of these is proof a human signed',
      },
    ],
    json: false,
    read: false,
    sideEffects: ["writes flow.json's acConfirmed map for that criterion and appends a signature record"],
  },
  {
    module: "tasks",
    command: "flow ac update",
    summary:
      "Re-freeze acceptance-criteria.md, VOIDING every prior confirmation. With --criterion and --text " +
      "together, also rewrites that one criterion (or appends the next unused one) before re-freezing; without " +
      "them, re-checksums the file as already edited by hand. Refuses an extra positional, an unknown flag, or " +
      "--criterion/--text given alone.",
    intent: ["обнови критерии", "flow ac update", "rewrite acceptance criterion", "re-freeze acceptance criteria", "измени AC"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "flow id" },
      { name: "reason", type: "string", required: true, desc: "why the criteria changed" },
      { name: "criterion", type: "string", required: false, desc: "an existing ACn to rewrite, or the next unused ACn to append; requires --text" },
      { name: "text", type: "string", required: false, desc: "the criterion's new text; requires --criterion" },
    ],
    json: false,
    read: false,
    sideEffects: [
      "with --criterion and --text: rewrites acceptance-criteria.md (replaces an existing ACn's text, or appends the next one)",
      "re-checksums acceptance-criteria.md into flow.json's acChecksum",
      "clears flow.json's acConfirmed map — every prior confirmation is voided",
    ],
  },
  {
    module: "tasks",
    command: "flow ac reseal",
    summary:
      "Re-seal a stale checksum over an acceptance-criteria.md file git shows is UNCHANGED since HEAD. Refuses " +
      "if the file actually changed (use `flow ac update` instead) or the checksum already matches. KEEPS " +
      "existing confirmations, unlike `flow ac update`.",
    intent: ["пересчитай checksum критериев", "flow ac reseal", "reseal acceptance criteria checksum"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "flow id" },
      { name: "reason", type: "string", required: true, desc: "why the checksum is stale" },
    ],
    json: false,
    read: false,
    sideEffects: ["writes flow.json's acChecksum to match the file on disk; acConfirmed is left untouched"],
  },
  {
    module: "tasks",
    command: "flow complete",
    summary:
      "Run the completion gates (acceptance criteria, pull-request or main-merge, base branch, tasks, owner, " +
      'review) and close the flow when every gate passes; otherwise returns it to in-progress. Records a ' +
      'signature; `--signed-by` (falling back to KERYX_ACTOR, then the local git identity, then "unknown") is ' +
      "never proof a human signed.",
    intent: ["заверши флоу", "flow complete", "close flow", "complete flow"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "flow id" },
      { name: "comment", type: "bool", required: false, desc: "post the completion summary as a tracker issue comment, for a github-issue-sourced flow that passes" },
      { name: "merged", type: "string", required: false, desc: "commit sha for a direct-merge handoff, evaluated against origin/main instead of the pull-request gate" },
      { name: "signed-by", type: "string", required: false, desc: "explicit signer identity for the completion signature" },
      {
        name: "confirm-token",
        type: "string",
        required: false,
        desc: "a token minted by `flow confirm`; checked only for a flow that opted into the confirmation gate, spent only on a passing completion",
      },
    ],
    json: false,
    read: false,
    sideEffects: [
      "writes flow.json (status, every gate's outcome, and a completion signature)",
      "with a valid --confirm-token on a passing completion: marks the flow's confirm-token.json spent",
      "with --comment, on a github-issue-sourced flow that passes: posts a comment on the source issue",
    ],
  },
  {
    module: "tasks",
    command: "flow confirm",
    summary:
      "OPERATOR-ONLY — not for agents to run. A person mints, in their own terminal, the completion confirmation " +
      "token a flow that requires one needs; an agent asked to confirm a completion should ask the operator to run " +
      "this, not run it. Refuses unless stdin and stdout are TTYs, shows what is being confirmed, and reads a typed " +
      "challenge from /dev/tty; every approval mode asks before it runs. An interactive step, not proof of a person (TM-03).",
    // Operator-phrased only (security re-review of PR #661): no agent-facing
    // "confirm completion" phrasing, so an agent is never routed to a
    // human-only verb by intent matching.
    intent: ["flow confirm", "operator mints flow confirmation token"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "flow id" },
      { name: "merged", type: "bool", required: false, desc: "confirm a direct-merge completion of an in-progress flow" },
    ],
    json: false,
    read: false,
    sideEffects: [
      "writes .metaproject/flows/<dir>/confirm-token.json (the token's sha256 and binding, never the token)",
      "appends a confirmation-minted history entry naming only a hash prefix",
    ],
  },
  {
    module: "tasks",
    command: "flow recover",
    summary:
      "Move a flow left in `completing` by an interrupted `flow complete` back to in-progress, recording the " +
      "reason. Refuses from any other status and while the flow lock is held; never touches signatures or attempts.",
    intent: ["восстанови флоу", "flow recover", "flow stuck in completing", "recover interrupted completion"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "flow id" },
      { name: "reason", type: "string", required: true, desc: "why the completion was interrupted" },
    ],
    json: false,
    read: false,
    sideEffects: ["writes flow.json's status (completing -> in-progress) and appends a completion-recovered history entry"],
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
    sideEffects: [
      "renames .metaproject/flows/**",
      "writes .metaproject/flows/id-map.json",
      "rewrites the flow's review package records (manifest.json, scope.md, findings.json) and review-note links",
    ],
  },
  {
    module: "tasks",
    command: "flow repair-reviews",
    summary:
      "Re-point review records of flows renumbered before renumber rewrote them, by replaying id-map.json. Idempotent.",
    intent: [
      "почини ревью после переномерации",
      "старые номера флоу в ревью",
      "repair review records after renumber",
      "stale flow id in review manifest",
    ],
    args: [],
    json: false,
    read: false,
    sideEffects: [
      "rewrites review package records (manifest.json, scope.md, findings.json) under renumbered flows",
      "rewrites review-note links",
    ],
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
  // Flow 310 (W2 agent-definitions catalog): `list`/`show`/`verify` are
  // read-only; `export` is the one subcommand that writes, and only into a
  // keryx-managed path (a file lacking the managed sentinel is refused, never
  // overwritten).
  {
    module: "agents",
    command: "agents list",
    summary: "List the agent-definitions catalog (bundled + project), optionally filtered to one stack.",
    intent: ["список агентов", "list agent definitions", "agent catalog", "which agents are available"],
    args: [
      { name: "stack", type: "string", required: false, desc: "only definitions whose stacks[] names this stack id" },
      { name: "json", type: "bool", required: false, desc: "emit the catalog summary as JSON" },
    ],
    json: true,
    read: true,
  },
  {
    module: "agents",
    command: "agents show",
    summary: "Render one agent definition's frontmatter and compiled keryx-shell task.",
    intent: ["покажи агента", "show agent definition", "agent details"],
    args: [
      { name: "<name>", type: "string", required: true, desc: "agent name, from `agents list`" },
      { name: "json", type: "bool", required: false, desc: "emit the definition + compiled result as JSON" },
    ],
    json: true,
    read: true,
  },
  {
    module: "agents",
    command: "agents export",
    summary: "Compile and write (or preview with --dry-run) one agent definition for one export runtime.",
    intent: ["экспортируй агента", "export agent definition", "write agent file for claude/codex/kiro/opencode"],
    args: [
      { name: "runtime", type: "string", required: true, desc: "claude | codex | kiro | opencode | keryx-shell" },
      { name: "<name>", type: "string", required: true, desc: "agent name, from `agents list`" },
      { name: "dry-run", type: "bool", required: false, desc: "plan and print without writing a file" },
      { name: "json", type: "bool", required: false, desc: "emit the export plan and outcome as JSON" },
    ],
    json: true,
    read: false,
    sideEffects: ["writes the runtime's managed agent file (e.g. .claude/agents/<name>.md) unless --dry-run"],
  },
  {
    module: "agents",
    command: "agents verify",
    summary: "Verify the agent-definitions catalog against its schema, tool/skill vocabulary, policy profiles, and origin rules.",
    intent: ["проверь агентов", "verify agent definitions", "agent catalog health"],
    args: [
      { name: "<name>", type: "string", required: false, desc: "verify only this agent name" },
      { name: "json", type: "bool", required: false, desc: "emit the full verification report as JSON" },
    ],
    json: true,
    read: true,
  },
  // `agents external list`/`probe`: flow 176 made both read-only and
  // quota-free — they run the candidate CLI's own `--version` and nothing
  // else (`agents.ts`: "list/probe are read-only and quota-free"). Safe to
  // describe and auto-allow.
  {
    module: "agents",
    command: "agents external list",
    summary: "The external ACP-agent registry: known agent CLIs and, unless --no-probe, whether each is installed (probes with the candidate's own `--version`, nothing else).",
    intent: ["внешние агенты", "list external agents", "external agent registry", "which agent clis are installed"],
    args: [
      { name: "json", type: "bool", required: false, desc: "emit the registry + availability document as JSON" },
      { name: "no-probe", type: "bool", required: false, desc: "skip detection entirely; every entry reports not-probed" },
    ],
    json: true,
    read: true,
  },
  {
    module: "agents",
    command: "agents external probe",
    summary: "Detect one external agent by registry id (probes with its own `--version`, nothing else).",
    intent: ["проверь внешнего агента", "probe external agent", "is this agent cli installed"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "registry id, from `agents external list`" },
      { name: "json", type: "bool", required: false, desc: "emit the availability document as JSON" },
    ],
    json: true,
    read: true,
  },
  // `agents external run` is deliberately NOT described here (flow 292).
  // Unlike `list`/`probe`, it drives one ACP agent end-to-end — it spends the
  // operator's provider quota and, being an ordinary subcommand of an already-
  // described verb, would otherwise be silently reachable by a consumer that
  // projects this registry onto a remote/MCP surface and trusts an absent
  // entry to mean "does not exist" only at the VERB level. That is the same
  // reasoning `harness` is excluded for entirely (see EXCLUSIONS in
  // command-registry.coverage.test.ts): a descriptor is a query with no cost
  // or an action the operator explicitly approves in the moment, never a
  // model-spending action offered up for silent or remote discovery.
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
    intent: [
      "построй граф",
      "обнови граф",
      "перестрой граф",
      "build the code graph",
      "rebuild graph",
      "update graph",
      "reindex dependencies",
    ],
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
    // CORRECTION (flow 236 T9): `wikiCollect` (`wiki/service.ts`) also
    // conditionally records the gdwiki sync-provenance file — outside
    // `.metaproject/wiki/**` — whenever `resolveWikiSourceGate` finds the code
    // graph demonstrably current. The old list stopped at the page tree and
    // silently understated this write, the same gap corrected on `wiki
    // freshness` and `wiki refresh` above.
    sideEffects: [
      "writes .metaproject/wiki/**",
      "writes .metaproject/data/gdwiki/.provenance.json, but only when the code graph is demonstrably current (resolveWikiSourceGate)",
    ],
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
  // ---- forgetting -------------------------------------------------------
  // Flow 242 T9/F9. Both are pure reads of
  // `.metaproject/data/forgetting/journal.jsonl` — the trail is append-only and
  // only `keryx sync --apply` writes it, so neither of these can shorten a
  // history and both are safe to call speculatively.
  {
    module: "forgetting",
    command: "forgetting trail",
    summary: "Read the deletion trail: what was removed, when, at whose request, on what basis.",
    intent: ["что было удалено", "deletion trail", "removal history", "журнал удалений"],
    args: [
      { name: "limit", type: "number", required: false, desc: "how many records to show (newest first)" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    json: true,
    read: true,
  },
  {
    module: "forgetting",
    command: "forgetting lookup",
    summary: 'Was this removed, or is there simply no record of a removal? Never answers "never existed".',
    intent: ["это удалили или не существовало", "was this deleted", "removed or never existed", "когда это удалили"],
    args: [
      { name: "<ref-or-path>", type: "string", required: true, desc: "identity, wiki page path or file path" },
      { name: "layer", type: "string", required: false, desc: "narrow to one knowledge layer" },
      { name: "search", type: "bool", required: false, desc: "phrase match over ref/page/title instead of exact identity" },
      { name: "json", type: "bool", required: false, desc: "structured JSON result" },
    ],
    json: true,
    read: true,
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
    module: "trigger",
    command: "trigger run",
    summary:
      'Perform exactly one pass of a declared trigger\'s action (.metaproject/triggers.json): "reconcile" -> ' +
      '"keryx sync --apply", "rebuild" -> "keryx gdgraph build", "open-flow" opens a flow from a template ' +
      '(skipIfOpen skips a second one while an equivalent flow is open), and "flow-next" is REPORT-ONLY unless ' +
      'the entry declares a "dispatch" block — with one, it DISPATCHES an unattended keryx agent, in a throwaway ' +
      "git worktree, to work the flow's next task. \"agent-task\" (flow 295) runs one unattended agent turn for a " +
      "schedule the operator confirmed with `keryx schedule add`, and leaves a report.",
    intent: ["запусти триггер", "run trigger", "fire trigger", "trigger run"],
    args: [
      { name: "<name>", type: "string", required: true, desc: "the trigger's name, as declared in .metaproject/triggers.json or the local schedule store" },
      {
        name: "schedule",
        type: "bool",
        required: false,
        desc: "resolve only a local schedule (.metaproject/data/trigger/schedules.json), never a committed trigger — what an installed timer runs",
      },
    ],
    json: false,
    read: false,
    sideEffects: [
      'reconcile: writes graph/wiki/memory via "keryx sync --apply"; holds the project\'s shared maintenance lock (.metaproject/data/.locks/maintenance.lock) for the duration and refuses cleanly (exit 0) rather than waiting when another run already holds it',
      'rebuild: writes the code graph via "keryx gdgraph build"; holds the same shared maintenance lock (.metaproject/data/.locks/maintenance.lock) and refuses cleanly the same way as reconcile',
      'open-flow: creates a flow via "keryx flow init --title <template>", unless skipIfOpen finds an equivalent flow already open; the whole check-then-create sequence runs under the SAME shared maintenance lock (.metaproject/data/.locks/maintenance.lock) as reconcile/rebuild, with the same clean refusal',
      'flow-next with NO dispatch block: report-only ("keryx flow next <flow>") — takes no lock at all',
      "flow-next WITH a dispatch block: does NOT take the shared maintenance lock (so the dispatched agent's own \"keryx gdgraph build\" can take it) — instead takes a PER-FLOW dispatch lock (.metaproject/data/.locks/dispatch-<flow>.lock, no wait) that refuses only a second dispatch on the SAME flow, so dispatches on different flows run concurrently; briefly takes a separate project-wide spend lock (.metaproject/data/.locks/spend.lock) just to decide and record the spend reservation before the first model call; then runs an unattended keryx agent in a throwaway git worktree on branch trigger/<flow>-<task> (committed, never pushed), which may leave a commit there, and records a task-attempt / task-done / attempt-failed-or-blocked outcome on the flow",
      "agent-task: refuses unless this machine's signature (HMAC) over the stored schedule still verifies; runs one unattended agent turn in a scratch directory with the project read-only; granted tools run outside the sandbox; the dispatcher writes .metaproject/data/trigger/reports/<name>/<runId>.md",
      "appends one record to .metaproject/data/trigger/runs.jsonl",
    ],
  },
  {
    module: "trigger",
    command: "trigger list",
    summary: "List every declared trigger entry: enabled state, what fires it, its action, and hook-install status; also lists any entry rejected at load and why.",
    intent: ["список триггеров", "list triggers", "declared triggers", "trigger list"],
    args: [],
    json: false,
    read: true,
  },
  {
    module: "trigger",
    command: "trigger status",
    summary: "Last recorded outcome for one or every declared trigger (from the run record), plus any open spend reservation that a killed dispatch left behind.",
    intent: ["статус триггера", "trigger status", "last trigger run", "открытые резервации расхода"],
    args: [{ name: "<name>", type: "string", required: false, desc: "narrow to one trigger; omit for every declared entry" }],
    json: false,
    read: true,
  },
  {
    module: "trigger",
    command: "trigger schedule",
    summary: "Print the cron line and systemd service/timer pair for a schedule-fired trigger entry. keryx runs no daemon of its own — the operator installs one of the two with their own scheduler.",
    intent: ["расписание триггера", "trigger schedule", "cron line for trigger", "systemd timer for trigger"],
    args: [{ name: "<name>", type: "string", required: true, desc: "a schedule-fired entry's name" }],
    json: false,
    read: true,
  },
  {
    module: "trigger",
    command: "trigger install",
    summary: "Install a managed git hook block for every declared, event-fired trigger entry (enabled or not). Schedule-fired and ci-fired entries install no hook.",
    intent: ["установи триггеры", "install trigger hooks", "trigger install"],
    args: [],
    json: false,
    read: false,
    sideEffects: [
      "writes a managed hook block into the matching post-merge/post-commit/post-checkout .git/hooks/* file(s) for each event-fired entry",
      "other managed blocks already in those hook files (e.g. keryx sync install-hooks's block) are untouched and still run",
    ],
  },
  {
    module: "trigger",
    command: "trigger uninstall",
    summary: "Remove the trigger hook blocks previously written by `trigger install`. Other managed blocks in the same hook files are untouched.",
    intent: ["удали триггеры", "uninstall trigger hooks", "trigger uninstall"],
    args: [],
    json: false,
    read: false,
    sideEffects: ["removes the managed trigger hook block(s) from .git/hooks/* file(s)"],
  },
  {
    module: "trigger",
    command: "trigger resolve",
    summary: "Close a killed dispatch's open spend reservation by stating what it actually spent, so it stops counting against the project and trigger spend ceilings. There is no default figure — it must be stated.",
    intent: ["закрой резервацию расхода", "trigger resolve", "close spend reservation", "resolve killed dispatch"],
    args: [
      { name: "<runId>", type: "string", required: true, desc: "the run id, from an open-reservation line in `trigger status`" },
      { name: "spent", type: "number", required: true, desc: "non-negative USD the run actually spent" },
    ],
    json: false,
    read: false,
    sideEffects: ["appends a reservation-resolved record to .metaproject/data/trigger/runs.jsonl"],
  },
  {
    module: "governance",
    command: "governance report",
    summary:
      "Spend, confirmations, signatures and gate outcomes, unified across flows (and optionally projects). " +
      'Read-only over already-recorded artifacts; a figure nobody recorded is "not recorded", never zero.',
    intent: [
      "governance report",
      "отчёт по governance",
      "сколько потрачено на флоу",
      "who confirmed this flow",
      "gate outcomes",
      "spend per flow",
    ],
    args: [
      { name: "flow", type: "string", required: false, desc: "narrow to one flow id, e.g. 291" },
      { name: "owner", type: "string", required: false, desc: "narrow to flows whose owner identity matches exactly" },
      { name: "since", type: "string", required: false, desc: "ISO timestamp lower bound, applied to each record's own timestamp" },
      { name: "until", type: "string", required: false, desc: "ISO timestamp upper bound, applied to each record's own timestamp" },
      { name: "all-projects", type: "bool", required: false, desc: "also cover every project in the user-global registry (keryx projects)" },
      { name: "json", type: "bool", required: false, desc: "print the report as JSON instead of markdown" },
    ],
    json: true,
    read: false,
    sideEffects: [
      "writes .metaproject/data/governance/artifacts/latest.md",
      "writes .metaproject/data/governance/artifacts/latest.json",
    ],
  },
  {
    module: "governance",
    command: "governance show",
    summary: "Reprint the most recently written governance report, without regenerating it.",
    intent: ["show governance report", "покажи governance report", "last governance report"],
    args: [{ name: "json", type: "bool", required: false, desc: "print the stored report as JSON instead of markdown" }],
    json: true,
    read: true,
  },
  {
    module: "hooks",
    command: "hooks list",
    summary:
      "The merged, resolved keryx shell lifecycle hook set (built-in -> user -> project), with id, event(s), matcher, class, scope and enabled state. With no config files present, exactly the five built-ins, all enabled.",
    intent: ["hooks list", "покажи хуки", "list lifecycle hooks", "какие хуки зарегистрированы"],
    args: [{ name: "json", type: "bool", required: false, desc: "print the merged list as JSON instead of text" }],
    json: true,
    read: true,
  },
  {
    module: "hooks",
    command: "hooks validate",
    summary:
      "Validate .metaproject/hooks.json and ~/.keryx/hooks.json against hook-config.schema.json, reject an id colliding with a built-in, and best-effort (no execution) check that each hook command's argv[0] resolves.",
    intent: ["hooks validate", "проверь конфиг хуков", "validate hook config"],
    args: [
      { name: "json", type: "bool", required: false, desc: "print diagnostics/result as JSON" },
      { name: "ci", type: "bool", required: false, desc: "machine-friendly invocation for CI; same non-zero-on-error semantics as without it" },
    ],
    json: true,
    read: true,
  },
  {
    module: "hooks",
    command: "hooks test",
    summary:
      "Run one registered hook once, through the real runner, against a synthetic (or --payload-file) event payload, and report its decision, exit code, stdout/stderr, duration and failure class.",
    intent: ["hooks test", "протестируй хук", "test a lifecycle hook"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "the hook's registered id, from `keryx hooks list`" },
      { name: "event", type: "string", required: false, desc: "which event to run it under, when the id is registered on more than one" },
      { name: "payload-file", type: "path", required: false, desc: "JSON file to use as the event payload instead of a synthetic one" },
      { name: "json", type: "bool", required: false, desc: "print the run report as JSON" },
      {
        name: "profile",
        type: "enum",
        required: false,
        values: ["read-only-review", "monitored-trusted-local", "unattended-untrusted"],
        desc: "policy profile to evaluate failure-semantics effects under",
      },
    ],
    json: true,
    read: false,
    sideEffects: [
      "spawns the hook's own command (or invokes its in-process port), which may itself write or read arbitrary state — this command's own state is unaffected",
    ],
  },
  {
    module: "hooks",
    command: "hooks enable",
    summary:
      "Re-enable a hook registration: removes a Keryx-managed disable override for a built-in, or flips `enabled: true` on a project/user hook.",
    intent: ["hooks enable", "включи хук", "enable a lifecycle hook"],
    args: [
      { name: "<id>", type: "string", required: true, desc: "the hook id to enable" },
      { name: "user", type: "bool", required: false, desc: "target ~/.keryx/hooks.json instead of .metaproject/hooks.json" },
    ],
    json: false,
    read: false,
    sideEffects: ["rewrites .metaproject/hooks.json, or ~/.keryx/hooks.json with --user, updating _keryxManaged.managedHookIds"],
  },
  {
    module: "bundle",
    command: "bundle export",
    summary:
      "Export skills, rules, agents, memory entries, learned patterns and hook config from one scope (project/team/user) into a portable bundle (directory or .tar.gz), sha256-content-addressed and manifest-described.",
    intent: ["bundle export", "экспортируй bundle", "export a portable bundle"],
    args: [
      { name: "scope", type: "enum", required: true, values: ["project", "team", "user"], desc: "the scope to export from" },
      { name: "include", type: "string", required: false, desc: "glob(s) restricting which bundle-relative paths are exported; repeatable" },
      { name: "kind", type: "string", required: false, desc: "comma-separated content kinds to export (skill,rule,agent,learned-pattern,memory-entry,hook-config)" },
      { name: "id", type: "string", required: false, desc: "override the default deterministic bundleId" },
      { name: "target-harness", type: "string", required: false, desc: "comma-separated harness ids to record in the manifest's compat.targetHarnesses" },
      { name: "<out>", type: "path", required: true, desc: "output directory or .tar.gz path; refuses if it already exists and is non-empty" },
      { name: "json", type: "bool", required: false, desc: "print the export result as JSON" },
    ],
    json: true,
    read: false,
    sideEffects: ["writes a new bundle directory or .tar.gz archive at <out>; never touches the source scope's own files"],
  },
  {
    module: "bundle",
    command: "bundle import",
    summary:
      "Plan -> W8 audit -> apply a bundle into a target scope, all-or-nothing: any unresolved conflict or audit failure writes nothing. --external instead vets and records-by-reference an Agent-Skills-standard catalog directory, copying no skill file anywhere.",
    intent: ["bundle import", "импортируй bundle", "import a portable bundle"],
    args: [
      { name: "<bundle>", type: "path", required: true, desc: "bundle directory or .tar.gz (or, with --external, an Agent-Skills-standard catalog directory)" },
      { name: "target-scope", type: "enum", required: false, values: ["project", "team", "user"], desc: "retarget every entry to this scope; defaults to each entry's own recorded scope" },
      { name: "render-for", type: "string", required: false, desc: "comma-separated harness ids to render imported rules into; defaults to the harnesses with rules-export already installed" },
      { name: "force", type: "string", required: false, desc: "targetRelative or displayId (scope:path) of a conflicting entry to overwrite anyway; repeatable" },
      { name: "external", type: "bool", required: false, desc: "treat <bundle> as an Agent-Skills-standard catalog directory instead of a portable bundle" },
      { name: "allow-hooks", type: "bool", required: false, desc: "required to import any hook-config (hooks.json) entry; without it, a bundle carrying one is refused" },
      { name: "dry-run", type: "bool", required: false, desc: "plan (and, for --external, vet) without writing anything" },
      { name: "json", type: "bool", required: false, desc: "print the plan/result as JSON" },
    ],
    json: true,
    read: false,
    sideEffects: [
      "writes new/updated files into the target scope root (.metaproject/ or ~/.keryx/) and updates that scope's applied-state ledger",
      "may render rules into one or more installed harnesses' own instruction files",
      "--external writes only a reference entry into ~/.keryx/skills/external-imports.json; never copies a skill file",
    ],
  },
  {
    module: "bundle",
    command: "bundle inspect",
    summary: "Read-only preview of what `bundle import` would do: verification status, per-entry plan bucket (new/identical/update/conflict), and capability-matrix warnings for the manifest's declared target harnesses.",
    intent: ["bundle inspect", "покажи содержимое bundle", "inspect a portable bundle"],
    args: [
      { name: "<bundle>", type: "path", required: true, desc: "bundle directory or .tar.gz" },
      { name: "target-scope", type: "enum", required: false, values: ["project", "team", "user"], desc: "preview against this target scope instead of each entry's own recorded scope" },
      { name: "json", type: "bool", required: false, desc: "print the inspection result as JSON" },
    ],
    json: true,
    read: true,
  },
  {
    module: "bundle",
    command: "bundle verify",
    summary: "Recompute every manifest entry's sha256 against the bundle's actual bytes, or (--external-imports) re-check every recorded external skill import's source files against their recorded hashes.",
    intent: ["bundle verify", "проверь bundle", "verify a portable bundle"],
    args: [
      { name: "<bundle>", type: "path", required: false, desc: "bundle directory or .tar.gz; omit with --external-imports" },
      { name: "external-imports", type: "bool", required: false, desc: "verify the recorded external skill imports instead of a bundle file" },
      { name: "json", type: "bool", required: false, desc: "print the verification result as JSON" },
    ],
    json: true,
    read: true,
  },
  {
    module: "bundle",
    command: "bundle uninstall",
    summary: "Remove only the files a bundleId's applied-state ledger records AND that are still byte-identical to what Keryx last wrote; a file a person has since hand-edited is kept, reported, never overwritten.",
    intent: ["bundle uninstall", "удали bundle", "uninstall a portable bundle"],
    args: [
      { name: "<bundleId>", type: "string", required: true, desc: "the bundleId to uninstall (from the manifest, or a prior import's report)" },
      { name: "target-scope", type: "enum", required: true, values: ["project", "team", "user"], desc: "scope to uninstall from" },
      { name: "dry-run", type: "bool", required: false, desc: "report what would be removed/kept without writing" },
      { name: "json", type: "bool", required: false, desc: "print the uninstall result as JSON" },
    ],
    json: true,
    read: false,
    sideEffects: ["deletes files this bundleId's applied-state ledger records as unmodified, and updates that ledger"],
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
    command: "help",
    summary: "Grouped command help by task: every group, a group, or one command's/slash-command's full usage.",
    intent: ["keryx help", "покажи команды", "list commands", "how do I use keryx", "какие есть команды"],
    args: [
      {
        name: "<group-or-command>",
        type: "string",
        required: false,
        desc: "group slug, CLI verb, or slash-command name; omit for the full grouped listing",
      },
    ],
    json: false,
    read: true,
  },
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
    // CORRECTION (flow 236 T9): found while auditing this file for the same
    // defect class as `wiki freshness` below — `read: true` here made this
    // auto-allowable, and it is not read-only. `checkVersion`
    // (`lib/version-check.ts`) is served from a local cache/backoff window on
    // some calls, but on every other call it makes a live outbound HTTPS
    // request to `REGISTRY_URL` (a third-party npm registry) and then writes
    // the result into `<keryx-config-dir>/version-check.json` — the per-user
    // config directory, OUTSIDE this project — via `updateCache`. A descriptor
    // cannot promise a caller which path a given invocation takes, so it
    // cannot claim `read: true` for the paths that do neither.
    read: false,
    sideEffects: [
      "makes an outbound HTTPS request to the npm registry, unless served from the local cache or failure-backoff window",
      "writes <per-user keryx config dir>/version-check.json (outside this project)",
    ],
  },
  // ---- auth -------------------------------------------------------------
  {
    module: "providers",
    command: "auth list",
    summary: "Which providers have a stored OAuth grant, and which subscription logins are offered.",
    intent: ["keryx auth list", "какие провайдеры авторизованы", "oauth status"],
    args: [{ name: "json", type: "bool", required: false, desc: "authorized grants without secrets" }],
    json: true,
    read: true,
  },
  {
    module: "providers",
    command: "auth status",
    summary: "Authorization method, expiry and refreshability for one provider. Never prints a token.",
    intent: ["keryx auth status", "oauth grant expiry"],
    args: [
      { name: "<provider>", type: "string", required: true, desc: "provider id (grok, openai, github-copilot)" },
      { name: "json", type: "bool", required: false, desc: "status without secrets" },
    ],
    json: true,
    read: true,
  },
  {
    module: "providers",
    command: "auth login",
    summary: "Authorize a sanctioned subscription via device-code (SuperGrok, ChatGPT Plus/Pro, Copilot).",
    intent: ["keryx auth login", "подключить SuperGrok", "login grok oauth"],
    args: [{ name: "<provider>", type: "string", required: true, desc: "grok, openai, or github-copilot" }],
    sideEffects: ["writes an OAuth grant to user-global auth.json (0600)"],
  },
  {
    module: "providers",
    command: "auth logout",
    summary: "Discard a stored OAuth grant.",
    intent: ["keryx auth logout", "отозвать grok oauth"],
    args: [{ name: "<provider>", type: "string", required: true, desc: "provider id" }],
    sideEffects: ["deletes the OAuth grant from user-global auth.json"],
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
  // ---- routing (flow 305) --------------------------------------------------
  // Category -> model routing table. `list` is read-only; `set`/`unset` write
  // to the per-user layer by default (shell config), or the project layer
  // with `--project` — never the network, never a model call.
  {
    module: "routing",
    command: "routing list",
    summary: "Every routing category, its resolved model, and which layer (project/user/default) answered.",
    intent: ["какая модель для ревью", "routing table", "keryx routing list", "категория модель"],
    args: [{ name: "json", type: "bool", required: false, desc: "structured category -> assignment/source map" }],
    json: true,
    read: true,
  },
  {
    module: "routing",
    command: "routing set",
    summary: "Pin a category to an exact model, or to a provider's own default model (no `/model`).",
    intent: ["маршрутизация ревью на модель", "route category to model", "set routing category"],
    args: [
      { name: "<category>", type: "enum", required: true, values: [...ROUTING_CATEGORIES_LITERAL], desc: "routing category" },
      { name: "<provider>/<model>|<provider>", type: "string", required: true, desc: "an exact model, or a bare provider for its default" },
      { name: "user", type: "bool", required: false, desc: "write layer: per-user (default)" },
      { name: "project", type: "bool", required: false, desc: "write layer: per-project routing.config.json" },
    ],
    sideEffects: ["writes the chosen category's assignment to the selected layer's routing config"],
  },
  {
    module: "routing",
    command: "routing unset",
    summary: "Clear a category back to session default.",
    intent: ["сбросить маршрутизацию категории", "unset routing category", "clear routing category"],
    args: [
      { name: "<category>", type: "enum", required: true, values: [...ROUTING_CATEGORIES_LITERAL], desc: "routing category" },
      { name: "user", type: "bool", required: false, desc: "write layer: per-user (default)" },
      { name: "project", type: "bool", required: false, desc: "write layer: per-project routing.config.json" },
    ],
    sideEffects: ["removes the chosen category's assignment from the selected layer's routing config"],
  },
  {
    module: "routing",
    command: "routing trust",
    summary:
      "Print routing.config.json's entries and approve its current content — required before the project layer applies (AC11).",
    intent: ["одобрить routing.config.json", "approve project routing", "trust routing config", "keryx routing trust"],
    args: [],
    sideEffects: ["records the project's routing.config.json content fingerprint as approved, in the operator's own config dir"],
  },
  // ---- retention ----------------------------------------------------------
  {
    module: "retention",
    command: "retention status",
    summary: "Read-only inventory of gdctx raw/artifacts logs and owner write-conflict sidecars against their retention caps.",
    intent: [
      "статус хранения",
      "retention status",
      "сколько логов накопилось",
      "how big are the ctx logs",
      "retention inventory",
    ],
    args: [{ name: "json", type: "bool", required: false, desc: "structured per-target counts/bytes" }],
    json: true,
    read: true,
  },
  {
    module: "retention",
    command: "retention sweep",
    summary:
      "Apply the retention policy (age cutoff, then a total-byte cap evicting oldest-first) to gdctx raw/artifacts logs " +
      "and owner write-conflict sidecars. DRY RUN BY DEFAULT — nothing is removed unless --apply is passed.",
    intent: [
      "почисти логи ctx",
      "retention sweep",
      "clean up gdctx logs",
      "prune raw logs",
      "sweep old context logs",
    ],
    args: [
      { name: "apply", type: "bool", required: false, desc: "actually remove eligible entries; without it, nothing is deleted" },
      { name: "target", type: "string", required: false, desc: "restrict to one target id from `retention status` (repeatable)" },
      { name: "max-age-days", type: "number", required: false, desc: "override every target's age cutoff for this run only" },
      { name: "max-bytes", type: "number", required: false, desc: "override every target's byte cap for this run only" },
      { name: "json", type: "bool", required: false, desc: "structured per-target sweep report" },
    ],
    json: true,
    // `read: false` unconditionally, even though the default invocation (no
    // `--apply`) deletes nothing — the same reasoning `wiki freshness` above
    // documents: a descriptor cannot promise a caller which path a given
    // invocation takes, and `read` feeds `isAutoAllowable`. A consumer that
    // auto-allows this because "it's usually just a dry run" would auto-allow
    // exactly the invocation that deletes files under .metaproject/. An
    // unreachable store or a failed removal also makes this exit 1 with
    // `status: "incomplete"` — never a silent partial success.
    read: false,
    sideEffects: [
      "dry run by default: reports what would be removed under .metaproject/data/gdctx/raw, " +
        ".metaproject/data/gdctx/artifacts, and .metaproject/workspaces/**/*-write-conflicts/**, without touching disk",
      "--apply PERMANENTLY REMOVES eligible files/directories under those same paths",
      "does not touch content already relayed to an agent, exported copies, or git history",
    ],
  },
  // ---- bus ------------------------------------------------------------------
  // The agent bus (flow 272; docs/requirements/keryx-agent-bus). It lives in the
  // git common directory, outside `.metaproject/`, and never writes flow state.
  {
    module: "bus",
    command: "bus list",
    summary: "Live and stale keryx shells of this clone (name, status, activity, checkout, branch) and active pause leases.",
    intent: ["кто ещё работает в этом репо", "bus list", "list bus peers", "which agents are running", "пиры шины"],
    args: [{ name: "json", type: "bool", required: false, desc: "structured peers and leases" }],
    json: true,
    read: true,
  },
  {
    module: "bus",
    command: "bus log",
    summary: "Read the agent bus event log, oldest first.",
    intent: ["лог шины", "bus log", "show bus messages", "what did the agents say", "сообщения агентов"],
    args: [
      { name: "since", type: "number", required: false, desc: "only events after this seq" },
      { name: "limit", type: "number", required: false, desc: "only the last N events" },
      { name: "json", type: "bool", required: false, desc: "structured events" },
    ],
    json: true,
    read: true,
  },
  {
    module: "bus",
    command: "bus send",
    summary:
      "Send a notice, question, handoff or reply to a live @name or @all as \"cli\". Refused inside a keryx tool call " +
      "(use-agent-tool), when the bus is disabled (bus-disabled), and past 30 CLI messages per minute per clone (rate-limited).",
    intent: ["отправь сообщение агенту", "bus send", "message another agent", "tell the other shell", "напиши агенту"],
    args: [
      { name: "<to>", type: "string", required: true, desc: "@<name> of a live instance, or @all" },
      { name: "kind", type: "enum", values: ["notice", "question", "handoff", "reply"], required: false, desc: "message kind; default notice" },
      { name: "reply-to", type: "string", required: false, desc: "event id being answered; required for --kind reply" },
      { name: "<text>", type: "string", required: true, desc: "message body, at most 2048 bytes after redaction" },
      { name: "json", type: "bool", required: false, desc: "structured { seq, id, resolvedTo }" },
    ],
    json: true,
    read: false,
    sideEffects: [
      "appends one redacted event to the clone's bus log under <git-common-dir>/keryx/bus/",
      "the addressed shells see the message when they read the bus log",
    ],
  },
  {
    module: "bus",
    command: "bus pause",
    summary:
      "Create a pause lease (default scope turns, default ttl 30m, max 4h) held by \"cli\" against a live @name or @all. " +
      "Refused inside a keryx tool call (use-agent-tool), when the bus is disabled (bus-disabled), and when another " +
      "CLI-origin lease is already active in the clone (lease-already-held).",
    intent: ["останови агентов", "bus pause", "pause the other agents", "hold the bus", "поставь агентов на паузу"],
    args: [
      { name: "<to>", type: "string", required: true, desc: "@<name> of a live instance, or @all" },
      { name: "reason", type: "string", required: true, desc: "why, shown to whoever is held" },
      { name: "scope", type: "enum", values: ["turns", "git-publish", "advisory"], required: false, desc: "what the lease enforces; default turns" },
      { name: "ttl", type: "string", required: false, desc: "e.g. 30m, 2h, 45s; default 30m, max 4h" },
      { name: "json", type: "bool", required: false, desc: "structured { leaseId, scope, targets, expiresAt }" },
    ],
    json: true,
    read: false,
    sideEffects: [
      "writes one pause-lease file plus its pause-request event under <git-common-dir>/keryx/bus/",
      "held instances stop starting new main-agent turns from an operator line (turns scope) or must confirm git-publish commands (git-publish scope) until the lease ends",
    ],
  },
  {
    module: "bus",
    command: "bus resume",
    summary:
      "End any pause lease by id, as \"cli\" (the operator's escape hatch from a terminal). Refused inside a keryx tool " +
      "call (use-agent-tool) and when the bus is disabled (bus-disabled); resuming an already-gone lease is a silent no-op.",
    intent: ["сними паузу", "bus resume", "resume the paused agents", "release the hold", "убери паузу"],
    args: [
      { name: "<leaseId>", type: "string", required: true, desc: "the lease id, from bus list or bus log" },
      { name: "json", type: "bool", required: false, desc: "structured { leaseId }" },
    ],
    json: true,
    read: false,
    sideEffects: [
      "appends one resume event and deletes the lease file under <git-common-dir>/keryx/bus/",
      "every instance the lease targeted may start turns (or shell_exec git-publish commands) again",
    ],
  },
  {
    module: "bus",
    command: "bus prune",
    summary: "Remove presence records gone for more than 24 h, inactive pause leases, and rotated log segments beyond retention.",
    intent: ["почисти шину", "bus prune", "clean up the agent bus", "remove dead bus peers"],
    args: [{ name: "json", type: "bool", required: false, desc: "structured removal report" }],
    json: true,
    read: false,
    sideEffects: [
      "deletes gone presence records, inactive pause leases and old rotated segments under <git-common-dir>/keryx/bus/",
      "appends one lease-expired event per removed lease",
      "never touches live or stale peers, or anything under .metaproject/",
    ],
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
      { name: "session-provider", type: "string", required: false, desc: "provider that authored the change; defaults to KERYX_SESSION_PROVIDER" },
      { name: "session-model", type: "string", required: false, desc: "model that authored the change; defaults to KERYX_SESSION_MODEL" },
      { name: "from-shell-config", type: "bool", required: false, desc: "use the selection keryx shell persisted as the session (off by default)" },
      { name: "json", type: "bool", required: false, desc: "the record a round should carry" },
    ],
    json: true,
    read: true,
  },
  // ---- stack --------------------------------------------------------------
  {
    module: "stack",
    command: "stack detect",
    summary: "Deterministic, offline detection of the repository's stack tags.",
    intent: [
      "определи стек",
      "detect the stack",
      "what stack is this",
      "какой стек проекта",
      "stack tags",
    ],
    args: [
      { name: "cwd", type: "path", required: false, desc: "detect against this directory instead of the current one" },
      { name: "json", type: "bool", required: false, desc: "print exactly the persisted stack.json document" },
      { name: "no-write", type: "bool", required: false, desc: "detect and print without writing stack.json" },
    ],
    json: true,
    read: false,
    sideEffects: ["writes .metaproject/data/stack/stack.json (skipped with --no-write)"],
  },
  // Flow 295: `keryx schedule` (self-contained in ./schedule-descriptors.ts).
  ...SCHEDULE_DESCRIPTORS,
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

/**
 * Words that carry no routing signal, so a phrase must not fail because a query
 * happened to include one. Deliberately tiny: every entry here is a word that
 * cannot distinguish two commands in this registry, and a longer list starts
 * discarding meaning.
 */
const INTENT_FILLER = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "this",
  "that",
  "please",
  "и",
  "мне",
  "этот",
  "эту",
  "это",
  "пожалуйста",
]);

/** Unicode-aware split, so Cyrillic intents tokenise like Latin ones. */
function intentTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((token) => token.length > 0 && !INTENT_FILLER.has(token));
}

/**
 * Find the descriptors whose intent phrases best match a natural-language query.
 *
 * Matching was a contiguous substring test in both directions, which meant one
 * filler word defeated it: `rebuild graph` is an intent, and "rebuild the graph"
 * matched NOTHING, because neither string contains the other. Measured over 22
 * real phrasings, five returned no command at all — including "refresh the wiki"
 * and "rebuild the graph", which are how people actually ask.
 *
 * A phrase now also matches when every one of its meaningful words appears in
 * the query, in any order. That is the same correction #436 made to skill
 * triggers: match on words, not on contiguous strings.
 *
 * The substring rule is KEPT alongside it rather than replaced. Every phrase it
 * matched has all its words present too, so the word rule subsumes it — but
 * keeping both makes "nothing that matched before stops matching" structurally
 * true instead of merely believed, and this registry is what agents route on.
 */
export function matchIntent(query: string): CommandDescriptor[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [];
  }
  const queryTokens = new Set(intentTokens(normalized));

  const scored = listDescriptors()
    .map((descriptor) => {
      let score = 0;
      for (const phrase of descriptor.intent) {
        const needle = phrase.toLowerCase();
        if (normalized.includes(needle) || needle.includes(normalized)) {
          score = Math.max(score, needle.length);
          continue;
        }
        const phraseTokens = intentTokens(needle);
        if (phraseTokens.length > 0 && phraseTokens.every((token) => queryTokens.has(token))) {
          // Scored below an exact substring hit of the same length: a phrase
          // the query contains verbatim is stronger evidence than the same
          // words scattered through it.
          score = Math.max(score, needle.length - 1);
        }
      }
      return { descriptor, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.descriptor);
}

/**
 * Descriptors that share at least one meaningful word with the query, for the
 * case where nothing matched outright.
 *
 * "обнови вики" is the motivating example, and it is genuinely ambiguous: four
 * commands could answer it — `wiki index`, `wiki enrich`, `wiki refresh`,
 * `wiki collect`. Attaching that phrase to one of them would be picking a
 * winner the query does not name. Answering with the candidates is the honest
 * shape: the user asked something real, and the registry knows which commands
 * are in the neighbourhood even when it cannot choose between them.
 *
 * Ranked by how many words they share, so the closest come first. Never a
 * substitute for a match — the caller must present these as suggestions.
 */
export function suggestIntent(query: string, limit = 4): CommandDescriptor[] {
  const queryTokens = new Set(intentTokens(query));
  if (queryTokens.size === 0) {
    return [];
  }
  return listDescriptors()
    .map((descriptor) => {
      let shared = 0;
      for (const phrase of descriptor.intent) {
        const overlap = intentTokens(phrase).filter((token) => queryTokens.has(token)).length;
        shared = Math.max(shared, overlap);
      }
      return { descriptor, shared };
    })
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map((entry) => entry.descriptor);
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
