# Measurement Methodology Review

Version: 1.0.0

## Status

**DONE_WITH_CONCERNS.** The published JSONL supports the stated threshold outcome, but the reusable harness has two guard/resume correctness defects. Current `main` also retains five benchmark call-limit fields that the production agent port never consumes.

## Scope and method

Reviewed the pinned research tip without checkout: all nine `scripts/benchmark/retrieval-*` implementation modules and their nine tests, the runner, both result JSONL files, and the applicable production agent interface on `main`. The graph is built from `main` and does not contain the branch-only retrieval modules; after confirming that absence with `gdgraph`, branch inspection used `git ls-tree`, `git show`, and `git diff`, with `gdctx` summaries first and exact `git show` excerpts where summaries omitted line evidence. No model call or sweep was run.

Verified safeguards include first-parent PR-shaped task extraction, parent-tree isolation, source-only gold sets, test/gold-answer leakage filters with counted exclusions, detached shallow checkouts with remotes removed, fresh graph provisioning, context removal in the control arm, equal model/prompt/tool availability, strict Claude MCP configuration, paired scoring, usage accounting including cache tokens, error/timeout rejection, and before/after context inventories.

## Offline recomputation

Both JSONL files are structurally complete: 126 rows, 63 task pairs, zero duplicate task-arm rows, and zero unpaired tasks.

| Dataset | Pairs | Recall on/off | Gain | Mean context tokens on/off | Wins/ties/losses | On >1.5x tokens |
|---|---:|---:|---:|---:|---:|---:|
| Primary | 50 | 45.61% / 41.92% | +3.69 pp | 1,548,979.5 / 1,338,204.9 | 7 / 39 / 4 | 21 |
| Secondary | 13 | 80.31% / 82.88% | -2.56 pp | 1,272,684.9 / 960,592.0 | 0 / 12 / 1 | 5 |

The pre-registered rule in `retrieval-scoring.ts:163-167,205-207` requires at least +10 recall points and no greater mean context-token cost. Neither dataset meets it. This is a model-independent arithmetic result.

The stronger cost claim needs correction: of the 21 primary tasks above 1.5x control tokens, 18 had no recall gain and 3 did gain recall. In the secondary set, all 5 expensive tasks had no gain. “Zero wins cannot be unlucky” is unsupported: the secondary set has only one discordant pair (0 wins, 1 loss, 12 ties), so a sign test has one informative observation. Failure to cross +10 pp establishes neither equivalence nor statistical significance. The observed JSONL contains no orphan or duplicate rows, so the resume defect below is a future-run integrity risk rather than an explanation of these 126 rows.

## Findings

### [major] Resume can admit a duplicate arm and corrupt paired means

`retrieval-sweep.ts:60-73` loads every valid row. `completedTaskIds` at `:76-88` records only whether both arm names exist. `runSweep` at `:95-100` then retains every row for a completed task. If execution stops between the two appends at `:109-116`, the next run appends a fresh pair but leaves the first orphan in JSONL. On a later resume, all three rows survive. `decide` at `retrieval-scoring.ts:168-199` builds `paired` from context-on rows, so it counts the task twice and averages the arms over unequal row counts.

A clean offline probe against the pinned modules loaded and retained all three rows, reported `verdict.tasks = 2`, and produced recall-on `0.5` versus recall-off `0` for one logical task. The existing test at `retrieval-sweep.test.ts:184-199` checks only the immediate in-memory rerun, before reload.

Fix by canonicalizing one row per `(taskId, arm)` or rewriting/discarding incomplete task rows atomically before rerun; reject duplicates at load and again before scoring. Add an interruption → rerun → reload regression test.

Class scope: `loadResults`, `completedTaskIds`, `runSweep`, and `decide`; these are the only result ingestion/pairing stages among the nine reviewed modules.

### [major] Context-on evidence accepts an empty graph directory

`inventoryContext` sets `hasGraphDb` from directory existence alone at `retrieval-ablation.ts:134-152`. `assertArmContext` at `:169-185` requires only `.metaproject` for context-on. The tests enshrine both weak checks: an empty directory becomes a graph at `retrieval-ablation.test.ts:170-180`, and context-on passes with only the metaproject tree at `:211-218`. The control-rebuild test also simulates a graph using only `mkdir` at `retrieval-run.test.ts:318-339`.

A clean offline probe created an empty `.metaproject/data/gdgraph` directory: inventory returned `hasGraphDb: true` and the context-on guard passed. Successful provisioning still runs `keryx gdgraph build` and rejects nonzero exit (`retrieval-provision.ts:69-92`), so this does not disprove the published recalls. It does mean the stored inventory and guard cannot independently establish that a queryable, fresh graph existed. Wiki inventory has the same evidence-quality issue at `retrieval-ablation.ts:137-146`: every non-index Markdown file counts regardless of status or useful body content.

Validate actual graph storage/schema and a read-only query after build; record build revision/freshness. Require routing index presence and classify wiki pages by accepted status plus nonempty retrievable body.

Class scope: `inventoryContext`, `assertArmContext`, provisioning postconditions, and the runner's before/after inventory assertions.

### [major] Five current-main benchmark limits are ignored

Five current `main` scripts pass `maxToolCalls` into an object typed as `AgentDeps`: `run-ablation-raw.ts:48`, `run-ablation.ts:96`, `run-containment.ts:252`, `run-ablation-mutating.ts:110`, and `run-safety.ts:85`. The production port exposes only `maxRounds` (`src/commands/agent.ts:159-178`); no `resolveAgentMaxToolCalls` definition or import exists on this benchmark-to-`runAgentTurn` path. These keys therefore do not bound tool calls. They are also missed by routine typechecking because `tsconfig.json:12` includes only `src/**/*.ts`.

The research branch removes the unsupported fields. That removes latent type errors; it does **not** restore the intended tool-call caps. Either implement an explicit agent-port tool-call budget with a tested terminal outcome, or rename the benchmark contract and prose to the existing round cap. Add benchmark scripts to a dedicated typecheck target.

Class scope: all five `maxToolCalls` occurrences under `scripts/benchmark`; no other occurrence exists in that directory.

## Methodology limits and plan implications

The runner always executes context-on before context-off (`retrieval-run.ts:179-182`), so future trials should randomize or counterbalance arm order. Report confidence intervals or paired resampling alongside the pre-registered operational threshold; keep the threshold as a decision rule rather than a significance claim.

The current ablation removes the whole project context package, so it cannot attribute effects separately to routing, graph, or wiki. Preserve the graph/wiki direction and run bounded component ablations. For wiki work, measure body retrieval, concept-to-code traversal, page status and content quality, and section-bounded context. Existing graph lookup already has lexical path/name seeds; characterize and improve that composition rather than claiming description-to-file lookup is absent.

The research branch deliberately separates reusable public code from private measurement data. Reuse the methodology and fixes selectively; do not treat private-data separation as missing implementation.

## Routing audit

- `graph_used`: yes; confirmed the main graph predates branch-only retrieval modules.
- `wiki_used`: not-relevant; this review concerns branch benchmark code and offline evidence.
- `ctx_used`: yes; command/search/diff output was compacted before exact branch excerpts.
- `raw_rg_used`: no.
