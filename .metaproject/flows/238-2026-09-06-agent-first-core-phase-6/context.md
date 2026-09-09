# Контекст этапа 6
Version: 0.1.0

Project: /Users/Goodea/goodea/keryx. Integration branch: codex/agent-first-core; recorded base main@0bc6418fa1a038f8ec909cf949fecba077acf9a4.

Specs: docs/requirements/keryx-agent-first-core/README.md, specification.md, implementation-plan.md, decision-traceability.md and associated contract documents.

Зависимости: этапы 3, 5. Root проверяет delivery evidence каждого prerequisite до dependent implementation: CLI зависит только от задач одного flow, межflow DAG обеспечивается оркестратором явно. Независимый контекст/тест-дизайн можно собрать заранее.

Перед стартом: перечитать index, relevant graph/wiki/memory, current source и testing/health. Historical PASS и старый .worktrees inventory не доказательство текущего состояния. Stats disabled. Workers никогда не меняют flow.json/frozen AC/git; код по непересекающимся ownership.

---

# Implementation inventory — phase 6 (flow 238)

Version: 0.1.0. Compiled 2026-09-07, read-only pass, branch `codex/agent-first-core`.
Scope: the ten substantive criteria AC1–AC10 (AC-16, AC-23, AC-31, AC-32, AC-M05..M09, AC-W06).
AC11 is the evidence criterion and is not inventoried here.

## 0. Method, and what is measured vs inferred

Everything under "measured" was produced by a command run in this session. Everything
else is marked inferred and says what it was inferred from.

**Measured in this session**

| Fact | How |
|---|---|
| MCP tool registry = **40 tools**, all 40 visible under this project's config | in-process probe of `buildToolRegistry()` + `dispatchListTools(await buildMcpContext(root))` |
| Agent-callable CLI command registry = **44 descriptors** across 13 modules (`agents 1, core 6, gdctx 2, gdgraph 3, gdskills 6, gdwiki 8, health 2, memory 5, providers 2, sandbox 1, security 1, tasks 3, testing 4`) | `keryx commands --json` |
| **No `exports` field** in package.json; `dependencies: []`; `optionalDependencies: @modelcontextprotocol/sdk, @opentui/core, web-tree-sitter` | package.json read |
| `keryx orient` emits **9 441 bytes** | `keryx orient \| wc -c` |
| `keryx ctx read` on a **4-byte** file returns **311 bytes**; `keryx ctx rg` with **one** hit returns **496 bytes** | direct run against a scratchpad fixture |
| `keryx ctx status` reports **no cost figure at all** — module paths and an enabled flag only | `keryx ctx status` |
| The proposed operation IDs (`operations.list/describe/batch`, `context.change/expand/handoff/resume`, `knowledge.preview/apply/forget.*`, `graph.find/affected`, `wiki.search/readSection`) appear **nowhere** in `src/` | `keryx ctx rg` over `src/` |
| Of the M03 typed error codes, only **`format-unsafe`** exists, and only as `throw new Error("format-unsafe: …")` in 3 files (`src/mcp/dispatch.ts`, `src/security/guard.ts`, `src/security/service.ts`) | `keryx ctx rg` |
| `changeset` / `expectedVersion` appear **nowhere in `src/`** — only in gdskills feature-analyzer templates | `keryx ctx rg` |
| No experiment `preflight`, pair manifest, or `protocolDigest` anywhere in `src/` or `scripts/` | `keryx ctx rg` |
| The six proposed schemas and six examples under `docs/requirements/keryx-agent-first-core/{schemas,examples}/` have **zero consumers** in `src/` or `scripts/` | `keryx ctx rg "keryx-agent-first-core"` → only 4 hits, all prose comments |
| Prerequisite flows **235 (phase 3)** and **237 (phase 5)** are `in-progress` with **0 confirmed AC** | `keryx flow status 235/237` |
| Phase 0 recorded its AFC-16 contribution as **zero**, in writing | `.metaproject/flows/232-…/artifacts/DELIVERY.md` line 44 |
| Model-spending surfaces: `keryx security eval --with-model`, and 6 benchmark scripts that throw without `DEEPSEEK_API_KEY` (`run-ablation.ts`, `run-ablation-raw.ts`, `run-ablation-mutating.ts`, `run-safety.ts`, `run-containment.ts`, plus the `-codex`/`-grok`/`-opencode` variants that spend on their own accounts) | `keryx ctx rg` |
| `keryx metrics benchmark run` / `src/metrics/oracle-runner.ts` import only `node:fs`, `node:path` and `./ir` — no provider, no network | import inspection |

**Inferred, not measured**
- That the metastore ladder actually completes offline. I inspected its imports; I did
  **not** execute `keryx metrics benchmark run` (the sandbox classifier refused the run).
  Treat "the ladder is offline" as an import-level claim to be confirmed by the first lane
  that touches it.
- Whether phase 3's M03 typed errors are in flight in a worktree. I read the flow state,
  not other agents' uncommitted trees.

## 1. Programme-level findings that constrain every lane

1. **There is no SDK.** `package.json` has no `exports` map and ships only `bin.keryx`.
   Every criterion that says "CLI/MCP/SDK parity" (AC-16) or "thin SDK" (AC-32) is asking
   for a surface that does not exist yet. This is not a gap in a helper; it is a missing
   third adapter.
2. **The dependency chain is not satisfied.** The implementation plan makes wave 6 depend
   on wave 3, with write batch after wave 5. Both prerequisite flows are `in-progress`
   with zero confirmed criteria. AC-32's typed handle errors reuse the M03 taxonomy
   (wave 3) and its changeset clause reuses SAC CAS (wave 5); neither exists today.
3. **The normative source explicitly licenses an offline phase 6.** implementation-plan.md
   line 28: *"Волна 6 не обязана запускать модели: сначала только offline runner и guard
   tests."* This is the single most important sentence for the paid-run question below —
   the spec itself says phase 6 begins offline.
4. **A large measurement programme already exists** and is not part of this docpack:
   `docs/requirements/keryx-benchmark-suite/` (M1 marked complete 2026-08-14 with live
   captured data), plus `keryx-context-measurement/` and `keryx-execution-observability/`.
   Phase 6 should extend that machinery, not rebuild it. Several AC1–AC10 clauses are
   already half-satisfied there.

## 2. Per-criterion inventory

For each: **surfaces a real caller uses** (from a listing or search actually run),
**what exists**, **files that would change**, and the **two defect classes** —
(a) a capability nothing calls, (b) a failure rendered as a clean empty success.

---

### AC1 — AC-16, a usable agent contract
Normative source: `agent-protocol.md` §§ "Вход и справка по необходимости", "Обычный цикл",
"Shell как клиент"; `specification.md` §3 (typed error codes), §7 (operation surface).

**Surfaces a real caller uses**
- CLI: `keryx commands [--json|--intents|--intent "<phrase>"]` — the pointer surface.
  Measured: 44 descriptors. Backed by `src/standard/command-registry.ts` with a real
  coverage guard (`command-registry.coverage.test.ts`) derived from `CLI_ROUTES`, not from
  a hand-copied list, plus **20 top-level verbs excluded with a written reason each**.
  This is the strongest existing piece of AC-16.
- MCP: 40 tools from `buildToolRegistry()` (`src/mcp/tools.ts`), filtered by
  `src/mcp/discovery.ts` + `src/mcp/config.ts`, dispatched by `src/mcp/dispatch.ts`.
- Orientation pointer: `keryx orient` (`src/ctx/orient.ts`, `src/ctx/orient-runtimes.ts`),
  `keryx agents bootstrap` (`src/agents/bootstrap.ts`).
- SDK: **none**.

**What exists / what it does not do**
- The CLI registry gives an agent a machine-readable pointer with intents, args, `json`,
  `read`, and `sideEffects`. It does **not** carry an operation-level `describe` with
  schema/risk/cache semantics, which §3 of agent-protocol.md requires.
- The MCP surface carries **two naming families for the same capability** — measured:
  `graph_affected` **and** `gdgraph.affected`; `memory_search` **and** `memory.search`;
  `wiki_ask` **and** `wiki.ask`; `health_status` **and** `health.status`; `flow_status`
  **and** `flow.status`. An agent choosing "the right operation from a pointer" is being
  handed two answers. Nothing reconciles the two families, and neither family is projected
  from `COMMAND_DESCRIPTORS`.
- **CLI↔MCP parity is asserted for exactly three tools** (`gdgraph.cycles`,
  `gdgraph.orphans`, `standard.validate` — `src/mcp/mcp.test.ts` "AC1 parity"), out of 40.
- **Typed error recovery does not exist.** The whole M03 taxonomy is absent; the one code
  present (`format-unsafe`) is a message prefix on a bare `Error`, so no caller can branch
  on it. There is no error envelope with `code` + safe explanation + allowed next actions.
- **Routing cost is not measured anywhere.** `keryx orient` emits a measured 9 441 bytes
  per install; nothing records that as a cost, and `ctx status` reports no cost.

**Files that would change** — `src/standard/command-registry.ts`,
`src/standard/command-registry.coverage.test.ts`, `src/commands/commands.ts`,
`src/mcp/tools.ts`, `src/mcp/dispatch.ts`, `src/mcp/types.ts`, `src/ctx/orient.ts`,
new `src/contracts/operation-error.ts` (+ tests), new `src/sdk/` (if the SDK lane runs).

**Defect classes**
- (a) *Nothing calls it*: the 20 exclusions are principled, but they mean the registry
  describes 44 of ~50 verbs while MCP exposes 40 tools that the registry does not mention
  at all. A "pointer" that omits the entire MCP surface is a pointer half the callers
  cannot use.
- (b) *Clean empty success*: `dispatchListTools` returns `[]` when `mcpEnabled` is false
  (`src/mcp/dispatch.ts:50`). An agent that reads "no tools" cannot distinguish a disabled
  module from a project with nothing to offer. That is exactly the shape §3 forbids
  ("Нулевой массив при unknown coverage не означает «ничего нет»").

**Offline or paid?** **Fully offline.** Parity, typed errors and the pointer are
deterministic contract work. The one clause with a measurement flavour — "routing costs
measured separately" — is a byte/turn accounting of the orient block and can be measured
against recorded traces and synthetic sessions. **No paid runs.**

---

### AC2 — AC-23, an experiment protocol that shows wins and losses
Normative source: `metrics-and-validation.md` §M08 (arm families, task families) and
§"M09/M05/22"; `docs/requirements/keryx-benchmark-suite/plan.md` M1/M2.

**Surfaces a real caller uses**
- `keryx metrics benchmark init|validate|run --ladder metastore` (`src/commands/metrics.ts`).
- Producer scripts: `scripts/benchmark/run-ablation.ts`, `run-ablation-raw.ts`,
  `run-ablation-codex.ts`, `run-ablation-mutating*.ts`, `build-comparative-report.ts`.
- Pure scorers: `src/metrics/ablation-runner.ts` (`buildAblationManifest`,
  `computeAblationDelta`, `buildRawBaselineManifest`), `src/metrics/comparative.ts`
  (`buildComparativeReport`, `validateComparativeReport`).

**What exists**
- A real, reproducible arm protocol: context-on / context-off / raw-model, each in its own
  isolated git worktree from the same base ref, fixed seeds, N-run distributions with
  median + spread, Wilson CIs, and an explicit `fairness: met|caveat|not-met` +
  `non-publishable` marking for the codex leg whose model differs. The plan records the
  *negative* opencode result in full rather than hiding it. This is genuinely good prior
  art for "shows wins and losses".
- `computeAblationDelta` has 8 referencing files; the scorers are unit-tested offline.

**What does not exist**
- The arm families the norm requires are only partly covered. metrics-and-validation.md
  line 48 names six: *plain search/read; graph; substantive wiki/memory; graph+wiki; ctx;
  full selected composition*. The built ablation is binary (context-on/off) plus a raw leg.
  There are no `graph`-only, `wiki/memory`-only, `graph+wiki`, or `ctx`-only arms.
- The five task families (`description→files`, `symbol→impact`, `why/rule`, `safe patch
  with checks`, `continuation by another agent`) are not all represented;
  `ablation-tasks.ts` + `mutating-tasks.ts` cover roughly the first, second and fourth.
- **"A saving on the first answer is not the same as a benefit to the task"** has no
  mechanism at all. Nothing separates first-response token saving from end-to-end task
  cost including repeated reads, setup, and maintenance.
- `buildComparativeReport` is reachable only from a script, never from `keryx metrics`.

**Files that would change** — `src/metrics/ablation-runner.ts`, `src/metrics/comparative.ts`,
`src/commands/metrics.ts`, `scripts/benchmark/ablation-tasks.ts`,
`scripts/benchmark/build-comparative-report.ts`, new arm definitions under
`src/metrics/arms.ts`, `docs/requirements/keryx-benchmark-suite/plan.md`.

**Defect classes**
- (a) *Nothing calls it*: the comparative report has no CLI path — an agent or CI job
  cannot produce it without knowing a script path.
- (b) *Clean empty success*: `buildComparativeReport` intersects the three legs' task ids
  (`src/metrics/comparative.ts:118`). If a leg is missing tasks, the intersection silently
  shrinks and the report is produced with fewer cells and no error — a smaller comparison
  presented as a complete one.

**Offline or paid?** **Split, and the split matters.**
- The *protocol*, the arm definitions, the scorers, the equivalence of arms, the
  wins/ties/losses rendering, and the first-answer-vs-task-benefit separation are **all
  offline** and can be driven from synthetic and replayed fixtures.
- Producing *new comparative numbers* across the six arm families requires model runs.
  Those runs can be local (`rapid-mlx`/ollama, no key, already supported by
  `run-ablation.ts --provider`) or paid (`DEEPSEEK_API_KEY`, codex account).
- **Recommendation: build the protocol offline; do not run new arms in this phase.** The
  implementation plan explicitly permits this ("волна 6 не обязана запускать модели").

---

### AC3 — AC-31, defect regressions with oracles, and a bounded semantic judge
Normative source: `metrics-and-validation.md` §"Детерминированные блокирующие gates" and
§W06's judge clause; `decision-traceability.md` row 31.

**Surfaces a real caller uses**
- `keryx security eval [--corpus injection|exfil|structured-pii|secret|all] [--with-model]`
  (`src/commands/security.ts:824`), backed by `src/eval/corpus.ts` (`loadCorpusCases`,
  `runCorpus`) and `src/eval/gate.ts` (`gateCorpus`).
- Corpora on disk: `fixtures/exfil`, `fixtures/injection`, `fixtures/secret`,
  `fixtures/structured-pii`, `fixtures/paraphrase`, `fixtures/mcp-threat`, and 15 more.
- `keryx metrics benchmark run --ladder metastore` for the retrieval oracles.
- `src/metrics/benchmark.ts` `judgePanel()` / `JudgePanel`.

**What exists**
- A working labeled-corpus harness with TP/FN/FP/TN and a threshold gate
  (`fixtures/thresholds.json`), plus 20+ corpora. That is a real "starting state and
  oracle" mechanism — but it covers the **security** surface only.
- The semantic judge is already the right shape: `JudgePanel` is a *data structure* of
  three externally-supplied 0–2 scores with `strict` (all three) and `lenient` (two of
  three) both recorded. `judgePanel()` does not call a model; the wiki groundedness scores
  are hand-labeled in `fixtures/benchmark/keryx/wiki-groundedness.json`. So "the judge does
  not run from the core" is close to true today — **but only by construction, with no
  guard test asserting it**.

**What does not exist**
- There is no cross-module **known-defect register**. AC-31 says *every* known defect has a
  starting state and an oracle; today only security defects do. The gdgraph/gdwiki/ctx/
  memory/testing defect history lives in `.metaproject/memory/` prose and flow journals,
  in no executable form.
- No mechanism enforces "a repeat catches a regression" — no per-defect replay gate that
  fails when a fixed defect returns.
- No guard forbids a judge score from *substituting* for a strict deterministic check.

**Files that would change** — `src/eval/corpus.ts`, `src/eval/gate.ts`,
`src/commands/security.ts` (or a new `src/commands/regressions.ts`), new
`fixtures/regressions/` corpus, new `src/eval/defect-register.ts`, plus a new guard test
next to `src/capability/no-optional-imports.test.ts` asserting no model import reaches the
judge path.

**Defect classes**
- (a) *Nothing calls it*: `judgePanel()` is referenced by `oracle-runner.ts` and its tests,
  but no production path feeds it real panel scores; the wiki groundedness fixture is the
  only supply. A judge with one hand-written input set is not yet a capability.
- (b) *Clean empty success*: `loadCorpusCases` returns `[]` when `cases.json` is missing
  (`src/eval/corpus.ts:42-46`), and `runCorpus` on an empty case list yields all-zero
  counters. A deleted or mistyped corpus path therefore reports a clean run with nothing
  detected, which the gate can read as "no failures".

**Offline or paid?** **Fully offline.** Every clause — defect register, starting states,
oracles, replay, and the "judge neither replaces strict checks nor runs from the core"
guard — is deterministic. `--with-model` exists but AC-31 does not require it; the judge
clause is *about restricting* model use, and is best proven with a static guard.
**No paid runs.**

---

### AC4 — AC-32, batch/sequential equivalence, typed handles, changesets
Normative source: `specification.md` §8 (batch, handles, related writes), §6 (continuations);
`agent-protocol.md` §"Конкурентное изменение"; `schemas/batch.schema.json`.

**Surfaces a real caller uses** — **none exist.** Measured: no `operations.batch` in `src/`;
no `expectedVersion`; no `changeset`; no handle type. The nearest real surfaces are
`src/sac/proposal-lifecycle.ts`, `src/sac/guarded-owner-writer.ts`,
`src/sac/receipt-integrity.ts` and the MCP `sac.propose` / `sac.review` tools, which
implement proposal→review→receipt but not compare-and-swap on an expected version.

**What exists** — the *contract* only: `docs/requirements/keryx-agent-first-core/schemas/
batch.schema.json`, `change-set.schema.json`, `handoff.schema.json`,
`operation-response.schema.json`, `common.schema.json`, `wiki-evidence.schema.json`, six
positive examples, and `examples/validation-cases.json` carrying the schema-negative and
service-negative mutations. **Nothing reads any of them.**

Crucially, the *machinery* to consume them already exists and is proven on a different
docpack: `src/contracts/validator.ts` + `src/contracts/resolver.ts` +
`src/contracts/keyword-coverage.ts`, driven by `src/contracts/fixtures.test.ts` over
`docs/requirements/keryx-project-agent-harness/schemas/` with six matrices (positive,
negative, keyword coverage, mutation, migration, …). Pointing that harness at the
agent-first-core schemas is a small, high-value change.

**Files that would change** — new `src/contracts/agent-first-core.fixtures.test.ts`;
new `src/operations/batch.ts`, `src/operations/handle.ts`, `src/operations/envelope.ts`;
`src/sac/proposal-lifecycle.ts`, `src/sac/guarded-owner-writer.ts`;
`src/commands/*` for the CLI projection; `src/mcp/tools.ts` for the MCP projection.

**Defect classes**
- (a) *Nothing calls it*: the seven schema/example artefacts are the clearest instance of
  this class in the whole phase — a complete, well-formed contract with zero executable
  consumers. Exactly the "satisfied in a helper nothing calls" failure the previous phase
  hit five times.
- (b) *Clean empty success*: §8 warns that "one failed step must not become an overall
  ok". With no batch implementation there is nothing to measure yet, but the same risk
  already lives in the SAC path: a receipt is produced per proposal with no aggregate
  status across a related set, so a partially-applied related edit has no failure surface.

**Offline or paid?** **Fully offline.** Batch, handles and CAS are deterministic
concurrency work. **No paid runs.** But: **blocked on phases 3 and 5** — the typed error
taxonomy is wave 3 and SAC CAS is wave 5, and both are unconfirmed.

---

### AC5 — AC-M05, output size discipline and honest measured cost
Normative source: `specification.md` §6 ("Маленький ввод в пределах бюджета возвращается без
лишней обвязки"); `metrics-and-validation.md` §"M09/M05/22" (critical lines, envelope
overhead, further reads, aggregate tokens).

**Surfaces a real caller uses**
- `keryx ctx read|rg|run|status` (`src/commands/ctx.ts`, 1200+ lines), the PreToolUse hook
  (`src/ctx/hook.ts`, `hook-pipeline`, `hook-classify`, `hook-native-search`), and the MCP
  `search_code` tool. Every routed command in this repository goes through it — this is the
  most heavily exercised surface in the phase.

**What exists**
- Real compaction with a reported ratio: `src/commands/ctx.ts:1219` prints
  `compacted: <bytesIn> → <bytesOut> bytes (<n>% saved; full output in raw)`, and every
  call writes a raw log plus a summary artifact under `.metaproject/data/gdctx/`.
- Format-aware strategies and an outline mode.

**What is measurably broken**
- **The short-result clause fails today, measured.** A 4-byte file returns 311 bytes
  (≈78×); a single-hit `rg` returns 496 bytes where the raw hit is well under 100. The
  envelope (`# gdctx …` header, Command, Exit code, Matches, Files, Raw lines, Top Files,
  Matches, raw:, summary:) is emitted unconditionally, so the smallest possible answer
  carries the largest relative overhead.
- **The measured-cost clause has no implementation.** Measured: `keryx ctx status` reports
  paths and an enabled flag, no cost. The per-call `bytesIn → bytesOut` line counts only the
  compacted region — it excludes the envelope, and it is not printed at all when no
  compaction occurred (the 4-byte case printed no accounting line). So the one number that
  exists systematically understates cost, and nothing aggregates across calls.
- Nothing counts "further reads" — the norm's point that a compact first answer that forces
  three follow-up reads is not a saving.

**Files that would change** — `src/commands/ctx.ts`, `src/ctx/assembly.ts`, `src/ctx/hook.ts`,
`src/ctx/hook-pipeline.test.ts`, new `src/ctx/accounting.ts`, `src/metrics/events.ts`
(to receive ctx call costs).

**Defect classes**
- (a) *Nothing calls it*: the `.metaproject/data/gdctx/artifacts/*.md` summaries are written
  on every call and read by nothing — a per-call cost record with no aggregator.
- (b) *Clean empty success*: a routed command whose compaction is skipped prints no
  accounting line at all, which reads as "no cost", not "cost not measured". Same shape as
  M09's "missing must not become zero", one layer down.

**Offline or paid?** **Fully offline.** Envelope overhead, critical-line preservation,
addressable expansion, and total byte accounting are all deterministic and measurable with
`wc -c` against fixtures — as demonstrated above. The only clause with any model flavour is
`estimatedTokens`, and §6 already forbids that estimator from knowing a provider.
**No paid runs.**

---

### AC6 — AC-M06, public export audit and a model-free core
Normative source: `metrics-and-validation.md` §"M06/M07 — независимый runner и preflight".

**Surfaces a real caller uses**
- `scripts/benchmark/run-leakage-check.ts` → `src/metrics/leakage.ts` `checkGoldLeakage`,
  which is called from **7 real producers** (`run-ablation.ts`, `run-ablation-codex.ts`,
  `run-ablation-mutating{,-codex,-grok,-opencode}.ts`, `ablation-tasks.ts`) — not just tests.
- `keryx security scan <path>` / `security check-output` / `security redact`
  (`src/security/service.ts`, `src/security/guard.ts`) — the existing redaction floor. Note
  it is live: it redacted a token in one of my own reads during this pass.
- `src/capability/no-optional-imports.test.ts`, `src/capability/seam.ts`,
  `src/mcp/boundary.test.ts` — the existing import-boundary guards.

**What exists / partly holds**
- **"Core dependencies contain no model runner" is already true at the package-manifest
  level**, measured: `dependencies: []`, and the three optionalDependencies are an MCP SDK,
  a TUI renderer and a tree-sitter binding. No provider SDK is a dependency.
- **But the core *source tree* contains a full model runner**: `src/harness/provider/`
  ships `anthropic/`, `openai/`, `gemini/`, `ollama/`, `compat/`, plus `single-turn.ts` and
  `make-provider.ts`, and `src/harness/external/` drives third-party agent CLIs. They use
  no dependency because they call `fetch` directly. So the norm's real requirement — that
  the external runner has its own package/repository boundary and owns model/API adapters —
  is **not** met, and this overlaps squarely with wave 7 (AFC-19/20).
- Gold-leakage checking exists and is wired into real producers, but it is
  **path-existence only** (`existsSync` per gold path). It cannot detect gold *content*
  copied into a wiki page, a fixture, or a task description.

**Files that would change** — `src/metrics/leakage.ts`, `scripts/benchmark/run-leakage-check.ts`,
new `src/metrics/export-audit.ts`, `package.json`, `src/capability/no-optional-imports.test.ts`,
and — if the runner is actually extracted — `src/harness/**` (which is a wave-7-sized move).

**Defect classes**
- (a) *Nothing calls it*: nothing audits the *selected diff* for private names/paths/results
  before export. `keryx security scan` exists and could do it, but no export path invokes it.
- (b) *Clean empty success*: `checkGoldLeakage` filters gold paths by `existsSync` — if a
  gold path is renamed or mistyped it simply does not appear in `reachablePaths`, and the
  check reports clean. A leakage check that passes because it was pointed at nothing is the
  archetype of this class, and it currently guards seven live producers.

**Offline or paid?** **Fully offline.** An export audit is a static scan. **No paid runs.**
Caveat: the "core has no model runner" clause is *architecturally* entangled with wave 7 and
should not be closed here beyond the dependency-manifest guard.

---

### AC7 — AC-M07, preflight and a crash-safe pair store
Normative source: `metrics-and-validation.md` §"M06/M07" paragraphs 2–4.

**Surfaces a real caller uses** — **none.** Measured: no `preflight`, no pair manifest, no
`protocolDigest` in `src/` or `scripts/`. The nearest existing pieces are:
- `src/metrics/provenance.ts` (commit/branch/worktree + per-source reliability),
- `src/metrics/leakage.ts` (the reachable-answer check, partial),
- `keryx gdgraph context` freshness reporting and `.metaproject/data/gdgraph/.provenance.json`,
- `src/harness/resume/{resume,recovery,store,fingerprint}.ts` — a real crash→resume store
  for harness runs, with hardening tests. This is the closest thing to the pair store's
  resume semantics and is the right place to borrow from.

**What does not exist**
- Every clause: empty/corrupt-graph blocking, mismatched manifest/model/task/arm blocking,
  standalone-checkout-from-parent verification, remote/answer-commit unreachability,
  identical tool roster/model/budget, operator-memory absence, isolation manifest,
  before/after inventory, the immutable arm artifact keyed by
  `(runId, taskId, repetition, arm, protocolDigest)`, atomic pair manifest, orphan
  quarantine, and `INCOMPLETE`-not-zero-recall.

**Files that would change** — new `src/metrics/preflight.ts`, new `src/metrics/pair-store.ts`,
`src/metrics/provenance.ts`, `src/metrics/leakage.ts`, `src/commands/metrics.ts`,
new `src/metrics/inventory.ts`; test neighbours in `src/harness/resume/` for the crash matrix
pattern.

**Defect classes**
- (a) *Nothing calls it*: this is the whole criterion — there is no preflight to call.
- (b) *Clean empty success*: the norm names this failure precisely — *"пустая директория
  `data/gdgraph` не проходит"* and *"Неполная подготовка → INCOMPLETE, не нулевой recall"*.
  An unbuilt graph today produces an empty answer, not a refusal; the whole point of the
  preflight is to convert that into a block.

**Offline or paid?** **Fully offline.** A preflight is a set of refusals evaluated *before*
any model spend, and the pair store's crash→resume→resume property is proven with injected
faults on synthetic artifacts. This criterion is precisely the guard that must exist
*before* any paid run is authorised. **No paid runs — and this one is the prerequisite for
ever asking for them.**

---

### AC8 — AC-M08, honest statistics
Normative source: `metrics-and-validation.md` §"M08 — preregistration до нового опыта".

**Surfaces a real caller uses**
- `keryx metrics benchmark validate <manifest.json>` and `... run --ladder metastore`
  (`src/commands/metrics.ts`).
- `src/metrics/benchmark.ts` (`validatePairedBenchmark`, `wilsonInterval`, `deriveRate`,
  `judgePanel`, `BenchmarkValue`, `BenchmarkDistribution`, `TokenCostValue`, `RateWithCI`).
- `src/metrics/ir.ts` (`precision`, `recall`, `f1`, `ndcg`, `recallAtK`, `factPreservation`)
  — 6–8 referencing files each, so these are genuinely used, not orphan helpers.
- `src/metrics/comparative.ts` for the report shape.

**What exists (a lot)**
- recall / precision / F1 / nDCG / recall@k, all implemented and tested offline.
- `RateWithCI` with a 95% Wilson interval, and a validator that recomputes the interval and
  rejects a mismatch (`benchmark.ts:496`, `comparative.ts:195`) — so uncertainty cannot be
  hand-written.
- N-run distributions with `median` + `spread` and `STOCHASTIC_MIN_RUNS = 3`.
- `BenchmarkValue = {value: number|null, reliability}` — missing is null with a reliability,
  never zero-filled, at this layer.
- Both golds reported separately and explicitly never averaged (`buildOracleManifestsByGold`).

**What is missing**
- **No latency percentiles.** Measured: `p50`/`p95` appear nowhere in `src/metrics/`.
  `BenchmarkCost.latency` is a single `BenchmarkValue`. AC-M08 names P50 and P95 explicitly.
- **No strata.** No `strata`/`stratum` field anywhere; nothing enforces "strata fixed before
  outcomes", and nothing prevents a favourable subsample from displacing the primary.
- **No preregistration record.** No structure holds eligible tasks, gold construction, sample
  sizes, repeats, arm order (randomized/counterbalanced), stop rules, primary/secondary
  metrics, or the non-inferiority margin ε. `plan.md` is prose, not a checkable artifact.
- **No guard against claiming equivalence from a failed superiority test.** Nothing in the
  validator refuses that inference.
- "Double zeros stay in primary" is not enforced — there is no primary/secondary split.
- "`candidates`" (the max predicted-candidate cap that makes precision comparable) is not a
  manifest field.

**Files that would change** — `src/metrics/benchmark.ts` (types + validator),
`src/metrics/comparative.ts`, `src/metrics/ir.ts` (candidate caps), `src/commands/metrics.ts`,
new `src/metrics/preregistration.ts`, new `src/metrics/latency.ts`,
`docs/requirements/keryx-benchmark-suite/plan.md`.

**Defect classes**
- (a) *Nothing calls it*: `factPreservation` and `ndcg` are implemented and tested, but the
  gdgraph/testing ladders do not use them — they are reachable only through the wiki slice.
- (b) *Clean empty success*: `deriveRate(successes, n)` with `n = 0` returns
  `{rate: 0, ci95: {0, 0}}` (via `wilsonInterval`'s `n <= 0` guard). A stratum with no
  eligible tasks therefore reports a **0% success rate with a zero-width confidence
  interval** — a total absence of data rendered as a maximally confident failure. This is
  the single most dangerous instance of the class in the phase, because it appears in a
  publishable number.

**Offline or paid?** **Fully offline.** Percentiles, strata, preregistration structure, the
equivalence guard and the null-vs-zero handling are all schema-and-validator work provable
with synthetic manifests. Preregistration is *by definition* written before any run.
**No paid runs.** (Applying the preregistration to new data later would need runs; writing
and enforcing it does not.)

---

### AC9 — AC-M09, correct cost accounting
Normative source: `metrics-and-validation.md` §"M09/M05/22 — телеметрия и калибровка".

**Surfaces a real caller uses**
- `keryx metrics collect --events <events.json>` / `validate` / `show` / `compare` /
  `rebuild` (`src/commands/metrics.ts`), over `src/metrics/collector.ts`,
  `src/metrics/events.ts`, `src/metrics/record.ts`, `src/metrics/schema.ts`.
- `src/harness/provider/types.ts` `NormalizedUsage` — the only place provider token counts
  enter the system — and `src/harness/budget/reconcile.ts`.

**What exists**
- `ExecutionEvent` has a `event_id`, `run_id`, `parent_run_id`, `dispatch_id`, `type`,
  `timestamp_utc`, `details`. `MetricValue` carries `{value|null, reliability, source}`.
- `NormalizedUsage` fields are **optional and absent** when the provider did not report
  them, with an explicit `exact` flag — the right instinct for "missing is not zero".
- A `usage_update` event type exists in the provider event stream.

**What is missing or broken**
- **No cache token split.** Measured: `NormalizedUsage` is
  `{inputTokens?, outputTokens?, totalTokens?, exact?}`. AC-M09 requires
  input / cache-create / cache-read / output **separately**, and requires the provider's
  inclusive-vs-exclusive semantics pinned in the adapter contract so cache tokens are not
  double-counted. Neither exists.
- **No arm/task keys, no requested-vs-resolved model, no latency, no measurement source**
  on the usage event. `ExecutionEvent` has none of `attempt`, `task`, `arm`,
  `requestedModel`, `resolvedModel`, `latencyMs`.
- **Aggregation does not deduplicate by `event_id`.** `aggregateExecutionEvents`
  (`src/metrics/events.ts:24-33`) counts `commandEvents.filter(...).length` directly; the
  `unique()` helper is applied to only some types. A replayed or double-written event
  therefore **increases** the recorded cost, which is exactly what the norm forbids
  ("Агрегирование сначала дедуплицирует stable event IDs; replay не увеличивает cost").
- **No separation of "monetary estimate" from "actual charge"**, no rate version / currency
  / accounting basis, and no guard that a subscription allocation is not presented as a
  bank charge.
- Total cost does not include setup, index build, wiki authoring/review, refresh, repeated
  reads, failures/retries or runner overhead.

**Files that would change** — `src/metrics/types.ts`, `src/metrics/events.ts`,
`src/metrics/schema.ts`, `src/metrics/collector.ts`, `src/metrics/record.ts`,
`src/harness/provider/types.ts`, each `src/harness/provider/<vendor>/` normalizer,
`src/harness/budget/reconcile.ts`, `src/commands/metrics.ts`.

**Defect classes**
- (a) *Nothing calls it*: the `usage_update` provider event carries `NormalizedUsage`, but
  nothing routes it into `ExecutionEvent`/`aggregateExecutionEvents`. Token cost is captured
  at the provider boundary and never reaches the aggregator — a capability with no consumer.
- (b) *Clean empty success*: `sourceReliability = events.length > 0 ? "exact" : "unknown"`
  (`src/metrics/events.ts:13`). Any non-empty event array is declared **exact**, regardless
  of whether the events actually carry the field being aggregated. A run with a hundred
  irrelevant events reports exact zeros rather than unknown.

**Offline or paid?** **Fully offline.** The criterion literally says *"Из synthetic events
агрегаты воспроизводятся"* — synthetic events are the specified input. The provider-semantics
part (inclusive vs exclusive cache counters per vendor) is settled from vendor documentation
and recorded fixtures, not from live calls. The one clause that *would* need spend —
"bounded smoke after guards" — is explicitly gated: *"После успешных offline guards можно
отдельно разрешить bounded external smoke"*, i.e. a separate authorisation, and *"Smoke не
scored experiment"*. **No paid runs in this phase.**

---

### AC10 — AC-W06, wiki contribution measured as a diagnostic chain
Normative source: `metrics-and-validation.md` §"W06 — источник пользы wiki";
`wiki-specification.md` §8 line 102.

**Surfaces a real caller uses**
- `keryx wiki ask` (`src/wiki/ask.ts`, `src/commands/wiki.ts` `runAsk`), the MCP tools
  `wiki_ask`, `wiki.ask`, `wiki.query`, `read_wiki`, `wiki_backlinks`, `wiki_freshness`.
- `scripts/benchmark/run-gdwiki-oracle.ts` → `src/metrics/oracle-runner.ts`
  `buildWikiAskManifest`, scored against `fixtures/benchmark/keryx/wiki-gold.json` and
  `wiki-groundedness.json`.

**What exists**
- A genuinely good offline slice: hand-curated gold with one line of justification per
  query, a separate hand-labeled 3-judge groundedness panel, nDCG + recall@k, and a producer
  that imports the **working-tree** `wikiAsk` rather than the installed binary (with a
  recorded memory constraint explaining why). It calls no model.

**What does not exist**
- **The five-stage diagnostic chain is not implemented.** W06 requires distinguishing:
  page absent → page exists but has no content → relevant section indexed → candidate
  retrieved → evidence delivered → source actually used → answer/patch correct. The current
  oracle collapses all of this into one ranked-path score. A missing page and a retrieval
  miss are indistinguishable in the output today.
- No `boilerplate-only`, `stale`, `conflicting`, `no-answer`, or `missing-page` fixtures.
- No source correctness, no task checks, no patch behavioural oracle, no stale-reuse count,
  no unsafe-permission-inference count, no handoff-constraint retention, no repeated-reads
  or maintenance cost.
- **"Gold never reaches the wiki before the task"** has no enforcement for wiki content —
  `checkGoldLeakage` is path-existence only (see AC6).

**Files that would change** — `src/metrics/oracle-runner.ts`, `src/wiki/ask.ts` (to emit
stage markers), new `src/metrics/wiki-diagnosis.ts`, `scripts/benchmark/run-gdwiki-oracle.ts`,
new fixtures under `fixtures/benchmark/keryx/wiki-{boilerplate,stale,conflicting,no-answer,
missing}.json`, `src/metrics/leakage.ts` (content-level gold check).

**Defect classes**
- (a) *Nothing calls it*: `wiki-groundedness.json` is a hand-labeled panel consumed by one
  script; no CLI path and no gate reads it, so a regression in groundedness is invisible.
- (b) *Clean empty success*: `wikiAsk` returning no citations scores as recall 0 — identical
  to a page that exists but was not retrieved, and identical to a page that does not exist.
  W06's entire point is that these three must be distinguishable, and today they produce the
  same number.

**Offline or paid?** **Mostly offline, with one honest exception.**
- The chain instrumentation, the six fixture classes, the gold-leakage content check, the
  no-answer correctness scoring and the maintenance accounting are **all offline**.
- The clause *"источник использован"* (evidence actually used) needs a trace or answer
  citation from a real agent run, and the patch behavioural oracle needs an agent to produce
  a patch. Those need model runs — **but they can be local models**, and W06 itself says
  *"новые model calls этим пакетом не разрешены"*.
- **Recommendation: build the diagnostic ladder and its fixtures offline; leave the
  "used"/"patch" stages as instrumented-but-unpopulated, reported as `INCOMPLETE`, not
  zero.** That is exactly the M07 discipline applied here.

---

## 3. The paid-model judgement, consolidated

| Criterion | Can be satisfied offline with synthetic fixtures? | Notes |
|---|---|---|
| AC1 / AC-16 | **Yes, entirely** | Contract + parity + typed errors + byte accounting |
| AC2 / AC-23 | **Protocol yes; new comparative numbers no** | Build arms/scorers offline; running the six arm families needs models (local models suffice for most of it) |
| AC3 / AC-31 | **Yes, entirely** | The judge clause is a *restriction* on model use — prove it with a static guard |
| AC4 / AC-32 | **Yes, entirely** | Deterministic concurrency; blocked on phases 3 & 5, not on spend |
| AC5 / AC-M05 | **Yes, entirely** | Demonstrated in this pass with `wc -c` |
| AC6 / AC-M06 | **Yes, entirely** | Static export audit + dependency guard |
| AC7 / AC-M07 | **Yes, entirely** | A preflight is *by definition* pre-spend; the pair store uses injected faults |
| AC8 / AC-M08 | **Yes, entirely** | Preregistration is written *before* runs; percentiles/strata/guards are validator work |
| AC9 / AC-M09 | **Yes, entirely** | The norm names synthetic events as the input; bounded smoke is explicitly a *separate* authorisation |
| AC10 / AC-W06 | **Structure yes; two stages no** | "Evidence used" and "patch correct" need an agent run; report them `INCOMPLETE` rather than 0 |

**The bottom line: nine of ten criteria can be fully satisfied with no model spend at all,
and the tenth can be satisfied structurally with two stages honestly marked incomplete.**
This is not a convenient reading — it is what implementation-plan.md line 28 says
("волна 6 не обязана запускать модели: сначала только offline runner и guard tests") and
what metrics-and-validation.md line 66 says (bounded external smoke requires a *separate*
permission after successful offline guards). Anyone proposing a paid benchmark run inside
this phase is proposing something the frozen spec does not ask for.

The counter-error is equally costly and should be named: **AC-23 and AC-W06 will produce no
new comparative or use-stage numbers in this phase.** If the phase is judged on "did the
wiki help?", it will fail, because answering that needs runs. It should be judged on
"is the apparatus that would answer that correct, honest, and refusing to run when
unprepared?" — which is what AC-M07 and AC-M08 actually require.

## 4. Proposed lanes

Ten criteria in one phase is too many for one integration lane. Six lanes, disjoint file
sets, ranked by delivered value.

### Lane A — Cost honesty (AC5/M05 + AC9/M09) — **rank 1**
Owns: `src/commands/ctx.ts`, `src/ctx/assembly.ts`, `src/ctx/accounting.ts` (new),
`src/metrics/events.ts`, `src/metrics/types.ts`, `src/metrics/schema.ts`,
`src/metrics/collector.ts`, `src/metrics/record.ts`, `src/harness/provider/types.ts`,
`src/harness/provider/*/` normalizers, `src/harness/budget/reconcile.ts`.

Why first: it has the two measured, reproducible defects in the whole phase (the 78× short-
result envelope; `reliability="exact"` from any non-empty array), it needs no prerequisite
flow, it is fully offline, and every other lane's numbers depend on cost being counted
correctly. Fixing the `event_id` dedup alone changes what every future benchmark reports.

### Lane B — Preflight and pair store (AC7/M07) — **rank 2**
Owns: `src/metrics/preflight.ts` (new), `src/metrics/pair-store.ts` (new),
`src/metrics/provenance.ts`, `src/metrics/inventory.ts` (new), `src/metrics/leakage.ts`,
`src/commands/metrics.ts` (preflight subcommand only).

Why second: this is the gate that must exist before anyone can responsibly ask for spend.
It is also the criterion with the least prior art, so it is the longest pole. Borrow the
crash→resume→resume pattern from `src/harness/resume/`.

### Lane C — Statistics discipline (AC8/M08) — **rank 3**
Owns: `src/metrics/benchmark.ts`, `src/metrics/comparative.ts`, `src/metrics/ir.ts`,
`src/metrics/preregistration.ts` (new), `src/metrics/latency.ts` (new).

Why third: high leverage on a small surface, and it contains the phase's most dangerous
existing defect — `deriveRate(0, 0)` publishing a 0% rate with a zero-width CI. Depends on
Lane A's event fields only at the boundary; sequence C after A or agree the shared type
edits in `src/metrics/types.ts` up front.

### Lane D — Contract fixtures and the export audit (AC4-partial + AC6/M06) — **rank 4**
Owns: `src/contracts/agent-first-core.fixtures.test.ts` (new),
`src/metrics/export-audit.ts` (new), `scripts/benchmark/run-leakage-check.ts`,
`src/capability/no-optional-imports.test.ts`, `package.json` guard test.

Why fourth: the cheapest real win in the phase. `src/contracts/` already has a proven
six-matrix fixture harness running against another docpack's schemas; pointing it at
`docs/requirements/keryx-agent-first-core/schemas/` turns seven currently-dead artefacts,
including `validation-cases.json`, into executing checks in a day, not a week. Note it
delivers AC4's *schema boundary*, not AC4's batch runtime.

### Lane E — Defect register and judge containment (AC3/M31) — **rank 5**
Owns: `src/eval/corpus.ts`, `src/eval/gate.ts`, `src/eval/defect-register.ts` (new),
`fixtures/regressions/` (new), a judge-containment guard test.

Why fifth: valuable and fully offline, but it needs a defect inventory assembled from
`.metaproject/memory/` and the flow journals first, which is prose work before it is code.

### Lane F — Agent contract (AC1/AC-16) — **rank 6, and I would split it**
Owns: `src/standard/command-registry.ts`, `src/commands/commands.ts`, `src/mcp/tools.ts`,
`src/mcp/dispatch.ts`, `src/ctx/orient.ts`, `src/contracts/operation-error.ts` (new).

Why last of the buildable lanes: the pointer half is tractable (reconciling the two MCP
naming families, projecting descriptors into MCP, extending the parity assertion beyond
three tools, measuring the 9 441-byte orient block). The typed-error half depends on wave
3's M03 taxonomy, which is unconfirmed. Ship the pointer/parity half; hold the typed-error
half.

### Not a lane: AC2/AC-23 and AC10/AC-W06 protocol work
Both are protocol-and-fixture work that lands *inside* Lanes B and C rather than beside
them (arm definitions and task families in C; the wiki diagnostic ladder in a small
extension of C). Neither should be scheduled as an independent implementation lane in this
phase, because neither can be completed here.

## 5. What I would defer or split out

1. **AC4 / AC-32's batch runtime — defer to its own flow, after phases 3 and 5 land.**
   Measured: no batch, no handles, no `expectedVersion`, no changeset. It depends on the
   M03 error taxonomy (wave 3, unconfirmed) and SAC CAS (wave 5, unconfirmed). Building it
   now means inventing both prerequisites inside this flow, which is how ownership
   boundaries get violated. Keep only the schema-fixture half (Lane D) in this phase.
2. **AC1 / AC-16 — split.** Pointer + parity + routing-cost measurement here; typed-error
   recovery moves to whichever flow lands M03. Phase 0 already recorded a zero contribution
   to this norm and explicitly assigned it to phases 4 and 6; splitting it again should be
   recorded the same way, in writing, not implied.
3. **AC6 / AC-M06's "core has no model runner" — split.** The dependency-manifest guard
   belongs here (it already passes; it just needs a test). Extracting
   `src/harness/provider/**` into its own package is wave 7's AFC-19/20 work and is weeks,
   not hours. Do not attempt it inside phase 6.
4. **AC2 / AC-23 and AC10 / AC-W06 — descope to apparatus, explicitly.** Deliver the arm
   definitions, the six arm families' fixtures, the wiki diagnostic ladder and its six
   fixture classes; deliver **no new comparative numbers**. Record the un-run stages as
   `INCOMPLETE`, never as zero. Any request to actually run arms must go to the user as a
   separate, costed authorisation naming the provider, the model, the task count and the
   stop budget.
5. **Sequencing note.** Lanes A and C both touch `src/metrics/types.ts`. Either run A first
   and C after, or agree the shared type additions (`arm`, `task`, `requestedModel`,
   `resolvedModel`, `latencyMs`, cache token fields) in a single up-front edit owned by A
   before both start. This is the shared-schema coordination the phase plan already requires.

## 6. Routing audit

`graph_used: no` — gdgraph's recorded provenance predates uncommitted working-tree changes
on this branch (git status shows modified graph artifacts), so a graph answer would have
been stale; I used the module registries and `keryx ctx rg` instead, which read the live
tree. `wiki_used: no` — not-relevant: this inventory is about source and contract surfaces,
not domain concepts. `ctx_used: yes` — all searches and large reads via `keryx ctx rg` /
`keryx ctx read`. `raw_rg_used: no`.
