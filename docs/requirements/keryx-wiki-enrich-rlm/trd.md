# TRD: RLM-Style Recursive Enrichment for Keryx Wiki

Upstream: [prd.md](prd.md) (source of truth for scope/requirements). [README.md](README.md)
holds the discovery notes this TRD grounds against actual code. No BRD exists for this
package — PRD is the highest upstream document.

Grounding pass: read `src/wiki/enrich.ts`, `src/harness/provider/single-turn.ts`,
`src/gdgraph/staleness.ts`, `src/gdgraph/repomap.ts`, `src/gdgraph/config.ts`,
`src/harness/tool/metaproject-operations.ts`, `src/harness/tool/builtin/metaproject-tools.ts`,
`src/harness/tool/builtin/spawn-subagent-tool.ts`, `src/harness/tool/builtin/shell-exec-tool.ts`
(2026-08-18). Three PRD assumptions do not match current code as-is; each is called out inline
under **Grounding correction** and resolved with a concrete design, not left open.

## 1. Architecture

### 1.1 Current pipeline (unchanged parts)

```
collect.ts (deterministic, hard-capped template)
      │
      ▼
enrich.ts: wikiEnrich() ── selectPages() ── mapPool(pages, concurrency, worker)
                                                   │
                                                   ▼
                                     runModelTurn() [single-turn.ts]
                                     "No tools, no policy loop."
                                                   │
                                                   ▼
                                repairEnrichedFrontmatter → validateEnrichedMarkdown → write
```

`wikiEnrich` (`src/wiki/enrich.ts:617`) already owns page selection, concurrency (`mapPool`,
`enrich.ts:584`), resume state (`enrich-resume.json`, `enrich.ts:176`), and batch-end
validation. This TRD's changes are additive inside that same function — no new CLI command,
no new orchestrator process.

### 1.2 New per-page decision layer

Insert one pure classification step between `selectPages()` and the per-page worker body:

```
selectPages() → classifyPages(pages, graph, config, resumeState)
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
        skip          light          deep
   (template as-is)  (existing     (bounded child turn,
                    single-turn    §1.3, new)
                       path)
```

New module: `src/wiki/classify.ts`, pure function
`classifyPage(page, graphSignals, config): "skip" | "light" | "deep"`. Pure over inputs already
available — no I/O of its own; `wikiEnrich` gathers `graphSignals` once per run (§3) and passes
them in per page. This mirrors `computeRepomap`'s existing purity contract
(`repomap.ts:111`: "Pure over the in-memory graph + config; no I/O").

### 1.3 `deep`-path execution — grounding correction on how, not whether

**Grounding correction (PRD §"Proposed insertion point" / FR-2).** The PRD's sketch says
"spawn one bounded child subagent per page ... via `spawn-subagent-tool`". `spawn-subagent-tool.ts`
defines the `spawn_subagent` *InteractiveTool* — a tool a model calls **from inside** an
already-running interactive agent turn (`src/commands/agent.ts`'s tool-calling loop). `wiki
enrich` is a batch CLI command with no interactive agent turn of its own; there is no parent
model turn for it to be "called from". Literally wiring `wikiEnrich` to invoke the
`spawn_subagent` tool's `invoke()` function would work mechanically but drags in state that
belongs to an interactive session (`deps.getParentModel()`, `deps.getSlateSession`, TUI fleet
events via `emitSubagentFleet`) that a batch pipeline doesn't have and shouldn't fake.

The correct integration point is one layer down, at what `spawn_subagent` itself calls:

- `spawnSubagent()` from `src/harness/child/orchestrate.ts` — MAE budget/policy admission
  (`RemainingBudgetLedger`, `childReadOnlyPolicy()`), returns a `runModel` + reservation or a
  denial.
- `runAgentTurn()` from `src/commands/agent.ts` — the actual model turn loop with a supplied
  tool array, exactly as `spawn-subagent-tool.ts:280-379` assembles it for its own children.

`wikiEnrich`'s worker, for a `deep`-classified page, becomes the "parent" that calls these two
primitives directly — same admission and same turn mechanics as an interactive `spawn_subagent`
call, minus the interactive-only plumbing (slate, TUI fleet, parent-model lookup) that a CLI
batch run has no use for. This keeps `deep` pages using the *same* child-budget/policy
enforcement path as everywhere else in the harness (no new admission logic), while staying a
plain async call inside `mapPool`'s existing worker — no new process, no new IPC.

### 1.4 `deep`-path tool grant — grounding correction on tool source

**Grounding correction (PRD FR-2 / Constraints).** The PRD asks for "`shell-exec-tool` scoped to
read-only graph queries (`gdgraph query/find/path`)". `shell_exec_tool` (`shell-exec-tool.ts:1-14`)
is `risk: "shell"`, gated by the interactive agent's **default-deny human-approval flow**
(`commands/agent.ts`) — every single command it runs, including a would-be
`gdgraph query cycles`, blocks on a human `y` before executing. That is fundamentally
incompatible with an unattended batch pipeline enriching N pages with no human present per
call. It also has no built-in allowlist — "scope it to gdgraph subcommands only" would mean
building a new command-string parser/allowlist from scratch, duplicating work that already
exists elsewhere in the codebase (next paragraph).

That existing work is `src/harness/tool/metaproject-operations.ts`: eleven descriptors
(`search_code`, `graph_affected`, `graph_query`, `memory_search`, `read_wiki`, `graph_path`,
`test_related`, `health_status`, `graph_symbol`, `repomap`, `wiki_ask`, `wiki_backlinks`;
`metaproject-operations.ts:391-667`), every one `risk: "read"`, and `toToolDefinitions()`
(`metaproject-operations.ts:704`) stamps each with
`classification: { read: true, write: false, network: false, subprocess: false, credential: false }`.
These are the "`gdgraph query/find/path`, read-only" tools the PRD is actually asking for —
already built, already zero-approval, already deterministic and replay-supported. Confirming
this is the intended shape: `spawn_subagent`'s own child tool assembly
(`spawn-subagent-tool.ts:369-379`) **never** includes `shell_exec_tool` in either `read_only` or
`general` mode ("v1 general: still no shell_exec (parent owns mutations)", `spawn-subagent-tool.ts:376`)
— shell access for a spawned child is already an explicit non-goal elsewhere in the harness, not
a new restriction this TRD is inventing.

One more gap to close: `spawn_subagent`'s current child toolset is `builtinReadOnlyTools(cwd)` +
`builtinMetaprojectTools(cwd, ...)` (`spawn-subagent-tool.ts:371-374`), and
`builtinMetaprojectTools` (`metaproject-tools.ts:130-258`) is a **narrower, separately
hand-written** set of exactly 3 tools (`search_code`, `graph_affected`, `memory_search`) — it
does not project the full `METAPROJECT_OPERATIONS` array and is missing `graph_query`,
`graph_path`, `graph_symbol`, `repomap` (the ones the PRD explicitly wants). `deep`-path children
therefore get a purpose-built tool array, not the generic `spawn_subagent` default:

```ts
const DEEP_ENRICH_OPS = ["graph_query", "graph_path", "graph_symbol", "graph_affected", "repomap", "read_wiki"];
const deepTools = toInteractiveTools(
  METAPROJECT_OPERATIONS.filter((op) => DEEP_ENRICH_OPS.includes(op.name)),
  metaprojectPort,
);
```

reusing `toInteractiveTools()` (`metaproject-operations.ts:677-690`) as-is — no new tool
plumbing, just a narrower `ops` filter than the generic agent gets. This satisfies FR-2's "not
arbitrary shell access" constraint by construction (the grant is an explicit allowlist of
read-only operations, never a shell string) and FR-6 (flat recursion) for free: none of these six
operations is `spawn_subagent`, so a `deep` child has no mechanism to spawn a grandchild.

### 1.5 Batching (`light` path, FR-5)

No architectural change to `single-turn.ts` needed. `wikiEnrich`'s worker groups sibling `light`
pages (same module, per `collect.ts`'s existing module grouping) into one `buildUserPrompt`-style
call carrying multiple pages' content, fitting inside `repomap.ts`'s existing token-budget
mechanism (§1.2 of PRD; `repomap.ts:144-149`'s greedy-fill-with-truncate-marker pattern is reused
verbatim for the overflow-split behavior FR-5/Edge-Cases requires — no new truncation logic).

## 2. Tech Stack

No new language, runtime, or external dependency. Everything below already exists in this
TypeScript/Bun codebase:

| Concern | Component (existing) |
|---|---|
| Batch orchestration | `src/wiki/enrich.ts` (`wikiEnrich`, `mapPool`) |
| Classification (new, pure) | `src/wiki/classify.ts` |
| Config load/merge (new file, existing pattern) | `src/wiki/config.ts`, mirroring `src/gdgraph/config.ts` |
| `light`/fallback model call | `src/harness/provider/single-turn.ts` (`runModelTurn`) — unchanged |
| `deep`-path child admission | `src/harness/child/orchestrate.ts` (`spawnSubagent`) — reused, not modified |
| `deep`-path child turn loop | `src/commands/agent.ts` (`runAgentTurn`) — reused, not modified |
| `deep`-path tool grant | `src/harness/tool/metaproject-operations.ts` (`toInteractiveTools`, filtered `METAPROJECT_OPERATIONS`) — reused, not modified |
| Graph signals for classification | `src/gdgraph/build.ts` (graph nodes: `fanIn`, PageRank via `personalizedPageRank`) |
| Staleness (repo-wide, existing) | `src/gdgraph/staleness.ts` (`graphMaybeStale`) — reused for the "is it worth reading the graph at all" pre-check only, see §3.3 |
| Per-page staleness (new) | `src/wiki/enrich.ts`'s existing `enrich-resume.json` state file, extended (§3.3) |

## 3. Data Models

### 3.1 `wiki.config.json` (new, FR-8)

`.metaproject/wiki.config.json`, OPTIONAL, deep-merged over defaults — same idiom as
`gdgraph.config.json` (`gdgraph/config.ts:1-6`: "OPTIONAL file, deep-merged over the built-in
defaults. Missing OR malformed JSON degrades to the defaults... Every field falls back
individually"). `src/wiki/config.ts` mirrors `gdgraph/config.ts:14-94`'s
`WikiConfig` / `DEFAULT_WIKI_CONFIG` / `mergeWikiConfig` / `loadWikiConfig` shape exactly:

```ts
export interface WikiConfig {
  rlm: {
    enabled: boolean;               // FR-8 default: false — reproduces today's behavior
    classify: {
      skipMaxBytes: number;         // page template ≤ this size + low complexity → "skip"
      deepMinPageRank: number;      // normalized 0..1 score threshold → "deep"
      deepMinFanIn: number;         // graph fan-in threshold → "deep"
    };
    deep: {
      maxToolCalls: number;         // per-child ceiling, passed to spawnSubagent's budgetRequest
      maxRuntimeMs: number;
    };
    batch: {
      enabled: boolean;             // FR-5
      maxPagesPerBatch: number;
    };
  };
}
```

Numeric defaults (thresholds, `maxToolCalls`, `maxRuntimeMs`) are deliberately left for the
implementer to set from the baseline measurement PRD §11 calls for — this TRD fixes the
*shape*, not the numbers, since the PRD explicitly defers the numeric target (NFR-1).

### 3.2 Classification signals (in-memory, not persisted)

```ts
interface PageGraphSignals {
  templateBytes: number;       // collect.ts output size for this page
  pageRankScore: number;       // from personalizedPageRank over this page's key files (repomap.ts:131)
  fanIn: number;                 // max fanIn across the page's key files (graph node field, see formatAffected's `node.fanIn`, metaproject-operations.ts)
  stale: boolean;                 // per-page, see §3.3 — NOT src/gdgraph/staleness.ts's repo-wide boolean
}
```

Computed once per `wikiEnrich` run (one graph load, one `personalizedPageRank` pass reusing
`repomap.ts`'s existing ranking, not a per-page graph rebuild) and passed into `classifyPage`
per page.

### 3.3 Per-page staleness — grounding correction on FR-7's stated mechanism

**Grounding correction (PRD FR-7).** FR-7 says skipping "MUST" happen "via `staleness.ts`". Read
in full, `src/gdgraph/staleness.ts` (20 lines) is a single repo-wide boolean:
`graphMaybeStale()` compares `.git/HEAD`'s mtime against `nodes.jsonl`'s build mtime — "is the
*whole* graph maybe stale", not "did *this page's* underlying nodes change". It has no per-node
or per-page granularity and cannot answer FR-7's actual question ("is *this* page's content
still current") on its own.

The mechanism that already has the right shape is `enrich.ts`'s existing resume-state file
(`enrich-resume.json`, written by `saveResumeState`, `enrich.ts:211-219`), which already
persists `{ path, completed[] }` per run. Extend its per-entry shape:

```ts
interface ResumeState {
  updatedAt: string;
  provider?: string;
  model?: string;
  completed: string[];                                   // unchanged
  completedNodeHashes?: Record<string, string>;           // NEW: page path → hash of its key-files' graph node content at last successful enrich
  failed: Array<{ path: string; reason: string }>;
}
```

`completedNodeHashes[page]` is a hash (e.g. sha256) over the sorted `{path, hash-or-mtime}` pairs
of the page's key files as recorded in the graph (`collectPages`/`collect.ts` already knows a
page's key files). On a re-run, `classifyPage` (or a pre-filter before it) recomputes that same
hash from the *current* graph and compares — unchanged hash ⇒ FR-7 skip, regardless of
classification tier, matching the PRD's Gherkin scenario "Unchanged page is skipped on re-run".
`graphMaybeStale()` is still useful as a cheap upfront gate (§ Verification): if the whole repo
hasn't moved since the last graph build, per-page hashes cannot have changed either, so the
per-page hash computation can be skipped entirely for that run.

## 4. API / Tool Contracts

| Contract | Direction | Shape |
|---|---|---|
| `classifyPage(page, signals, config)` | internal, pure | `(WikiPage, PageGraphSignals, WikiConfig["rlm"]) => "skip" \| "light" \| "deep"` |
| `deep` child admission | `wikiEnrich` → `harness/child/orchestrate.ts` | `spawnSubagent({ budgetRequest: { maxRuntimeMs, maxToolCalls }, policyRequest: childReadOnlyPolicy(), ... }, ctx, deps)` — same call shape `spawn-subagent-tool.ts:319-337` already uses |
| `deep` child turn | `wikiEnrich` → `commands/agent.ts` | `runAgentTurn({ tools: deepTools, task: <page enrich prompt>, ... })` — `deepTools` per §1.4 |
| `deep` child tool grant | `harness/tool/metaproject-operations.ts` | `toInteractiveTools(METAPROJECT_OPERATIONS.filter(op => DEEP_ENRICH_OPS.includes(op.name)), port)` — all `risk: "read"`, zero-approval |
| Provenance (FR-9) | `deep` child → harness provenance store | Reuses the harness's existing per-tool-call provenance recording (already wired for every `ToolDefinition` via `toToolDefinitions`'s `replay: { deterministic: true, recordedResultSupported: true }`, `metaproject-operations.ts:719`) — no new provenance mechanism |
| `light` path | `wikiEnrich` → `harness/provider/single-turn.ts` | `runModelTurn({ system, user, maxOutputTokens, ... })` — **unchanged**, existing call at `enrich.ts:704` |
| Config load | `wikiEnrich` → `src/wiki/config.ts` | `loadWikiConfig(cwd): Promise<WikiConfig>` — mirrors `loadGdgraphConfig` (`gdgraph/config.ts:98`) |

## 5. Non-Functional Requirements

- **NFR-1 (fewer LLM calls):** `skip` classification (FR-1/FR-4) and staleness skip (FR-7,
  §3.3) both reduce call count directly; batching (FR-5, §1.5) reduces call count for `light`
  pages without reducing token volume. Concrete before/after numbers deferred to the baseline
  measurement PRD §11 already specifies — not fixed by this TRD.
- **NFR-2 (bounded deep-path cost):** enforced at the `spawnSubagent` call (§4) via
  `budgetRequest.maxRuntimeMs` / `maxToolCalls`, sourced from `wiki.config.json`'s
  `rlm.deep.maxRuntimeMs` / `maxToolCalls` (§3.1) — the same `RemainingBudgetLedger` enforcement
  every other spawned child in the harness already goes through
  (`spawn-subagent-tool.ts` imports `RemainingBudgetLedger` from `harness/child/ledger.ts`), not
  a new budget mechanism.
- **NFR-3 (local CPU-only backend):** no new dependency on a provider capability; `runModelTurn`
  and `runAgentTurn` already work against any `ProviderPort` implementation, including the
  existing Ollama path (`single-turn.ts:41`: `ollama: "llama3.2"` default model, and
  `hasCredential`'s `provider === "ollama"` early-return `true` for "local loopback, no key
  required", `single-turn.ts:55-57`).
- **NFR-4 (RLM-off parity):** `wiki.config.json` absent or `rlm.enabled: false` (§3.1 default)
  ⇒ `classifyPage` is never called; `wikiEnrich`'s existing per-page loop
  (`enrich.ts:688-776`) runs byte-for-byte as today. This is a single early branch at the top of
  the per-page worker, not a parallel code path to maintain.

## 6. Integration Points

- **`src/gdgraph/build.ts` / `src/gdgraph/repomap.ts`** — read-only: reuse
  `personalizedPageRank` (already exported for `computeRepomap`) to score pages for
  classification; no changes to graph storage format or query surface (PRD Constraints).
- **`src/harness/child/orchestrate.ts`, `src/harness/child/ledger.ts`** — read-only: `deep`-path
  admission reuses `spawnSubagent` and `RemainingBudgetLedger` exactly as `spawn-subagent-tool.ts`
  does; no new admission/budget code.
- **`src/harness/tool/metaproject-operations.ts`** — read-only: `deep`-path tool grant is a
  filtered `toInteractiveTools()` call; no new tool descriptors need to be added for the FR-2
  operation set (`graph_query`, `graph_path`, `graph_symbol`, `graph_affected`, `repomap`,
  `read_wiki` all already exist).
- **`.metaproject/data/wiki/enrich-resume.json`** — extended (additive field
  `completedNodeHashes`, §3.3), not replaced; existing `resume`/`--limit` CLI behavior in
  `enrich.ts` is unaffected.
- **`.metaproject/skills/gdwiki/SKILL.md`** — unchanged; remains the documented manual-override
  escape hatch (PRD Edge Cases "Misclassification").
- **`src/wiki/ask.ts`** — explicitly untouched (PRD Non-Goals); no synthesis step added here.

## 7. Deployment Notes

- No new environment variables required for default operation (`rlm.enabled: false` by
  default). If an env override is later wanted for ops convenience (e.g. force-enable RLM mode
  for a CI dogfood run without editing `wiki.config.json`), follow the existing precedent —
  `resolveShellSandboxMode`/`resolveShellTimeoutMs`-style env-first-then-config-then-default
  resolution already used elsewhere in the harness (`shell-exec-tool.ts:82-99`) — but this is not
  required to satisfy the PRD and is left as an implementer's option, not a requirement.
- No migration step: `wiki.config.json` is optional and additive; `enrich-resume.json`'s new
  field is additive and ignored by any code path that predates it (the existing loader already
  treats unknown/missing fields as absent, `enrich.ts:190-205`'s `loadResumeState` parsing).
- No infra/rollout changes: `keryx wiki enrich` remains a local CLI command; `deep`-path children
  run in-process via the same harness primitives as an interactive `spawn_subagent` call, not a
  separate service or worker pool.
- Dogfood target for the NFR-1/NFR-2/NFR-3 measurements: Keryx's own repo, on the reference
  hardware noted in the PRD (8-core AMD Ryzen, no GPU, ~12 tok/s) — consistent with the existing
  `keryx-benchmark-suite` dogfooding convention the PRD already cites.
