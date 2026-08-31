# Flow Journal

- 2026-08-18T07:03:21.450Z - flow created
- 2026-08-18T07:05:20.572Z - task-added: T5: Per-page staleness: extend enrich-resume.json with completedNodeHashes + graphMaybeStale pre-check
- 2026-08-18T07:05:20.773Z - task-added: T6: deep-path child turn: spawnSubagent + runAgentTurn + filtered read-only METAPROJECT_OPERATIONS tool grant
- 2026-08-18T07:05:20.992Z - task-added: T7: light-path batching + skip-path + rlm.enabled=false byte-for-byte parity branch
- 2026-08-18T07:05:21.197Z - task-added: T8: Update wiki-enrich docs (README/docs-site) for optional RLM mode + wiki.config.json
- 2026-08-18T07:05:48.841Z - frozen: 8 criteria; checksum recorded
- 2026-08-18T07:05:51.017Z - started
- 2026-08-18T07:05:54.361Z - task-done: T1: Collect remaining context
- 2026-08-18T07:10:45.307Z - task-done: T2: Implement per plan
- T2 findings (DONE, 46/46 tests, typecheck clean) that T5/T6/T7 must account for:
  1. `DeepPartial` has no shared export — `src/wiki/config.ts` defines its own private
     copy mirroring `gdgraph/config.ts:111-113`, not a shared import.
  2. `GraphNode` (`gdgraph/types.ts`) has NO stored `fanIn` field — it's computed on
     demand from `graph.edges` (see `gdgraph/affected.ts:53-64`). `classify.ts` added
     `computeGraphFanIn(graph)` mirroring that inbound-edge-count logic locally.
  3. `WikiPage` has NO structured key-files list — `collect.ts`/`service.ts:503-510`
     only render key files into markdown text, no field to read programmatically.
     `classify.ts`'s `computePageGraphSignals()` takes `keyFiles: string[]` as a
     caller-supplied param. **T5/T6/T7 must resolve a page → key-file paths
     themselves** (parse rendered content, or extend `collectPages`/`WikiPage` with a
     structured field — implementer's call, but do it once and reuse, don't
     re-derive per task).
  4. Chosen `DEFAULT_WIKI_CONFIG` starting numbers (conservative, bias toward
     `light`/not-skipping per PRD's deferred-baseline note): `skipMaxBytes: 256`,
     `deepMinPageRank: 0.75`, `deepMinFanIn: 25`, `deep.maxToolCalls: 20`,
     `deep.maxRuntimeMs: 120_000`, `batch.enabled: true`, `batch.maxPagesPerBatch: 5`.
- 2026-08-18 - task-done: T5 (per-page staleness). Full suite: 4058 pass/0 fail. Signatures
  T6/T7 MUST reuse (do not re-derive):
  - `src/wiki/collect.ts`: `computeModuleKeyFiles(graph): Map<string,string[]>`,
    `keyFilesForPage(index, page): string[]`.
  - `src/wiki/enrich.ts`: `ResumeState` (now exported, has `completedNodeHashes?`),
    `resumeStatePath`/`loadResumeState`/`saveResumeState` (now exported, were private).
  - `src/wiki/staleness.ts` (new): `computePageNodeHash(cwd, keyFiles, graph): Promise<string>`,
    `isPageUnchangedSinceLastEnrich(pagePath, currentHash, completedNodeHashes): boolean`,
    `checkPageStalenessGate(cwd): Promise<{repoMaybeStale: boolean}>` (wraps
    `gdgraph/staleness.ts`'s `graphMaybeStale` — call ONCE per run, not per page).
  - Grounding correction: `GraphNode` stores NO content hash/mtime
    (`{id, kind, path, language}` only) — `computePageNodeHash` reads each key file's
    current on-disk content directly (≤6 files/page) and sha256s it; it is NOT reading a
    hash off the graph node itself. Same class of gap as T2's `fanIn` finding.
- 2026-08-18T07:20:50.817Z - task-done: T5: Per-page staleness: extend enrich-resume.json with completedNodeHashes + graphMaybeStale pre-check
- task-done: T6 (deep-path child turn). Full suite: 4063 pass/0 fail (5 new tests).
  New module `src/wiki/deep-enrich.ts` — T7 MUST reuse (do not re-derive):
  - `enrichPageDeep(input: EnrichPageDeepInput): Promise<DeepEnrichResult>` — never
    throws; `DeepEnrichResult = DeepEnrichSuccess{enriched, toolCalls} |
    DeepEnrichFallback{fallback:true, reason, partial?, toolCalls}`. On fallback, T7 must
    fall back to template/partial (AC5), never fail the run.
  - `EnrichPageDeepInput` needs: cwd, page, original (post-`ensureWikiFrontmatter`,
    same as light path's `original`), systemPrompt (same as light's
    `loadSystemPrompt()`), extraInstruction?, provider/model (reuse `wikiEnrich`'s
    already-resolved values), maxToolCalls/maxRuntimeMs (from
    `loadWikiConfig(cwd).rlm.deep.*`), + test-injection seams (providerFactory/fetch/env/
    baseUrl/metaprojectPort/idSeq/clock).
  - `DEEP_ENRICH_OPS` / `buildDeepEnrichTools(port)` — the exact 6-op read-only tool
    grant (AC3/FR-6), already verified by test to contain no spawn/shell capability.
  - Output is RAW model text (not yet frontmatter-repaired/validated) — T7 must run it
    through the SAME `repairEnrichedFrontmatter`/`validateEnrichedMarkdown`/
    `setFrontmatterStatus` pipeline the light path already uses, uniformly for both paths.
  - **AC7 corrected** (see acceptance-criteria.md, `keryx flow ac update` applied): T6
    found `runAgentTurn`'s InteractiveTool path does NOT route through
    `ToolRegistry`/`replay` — `ToolDefinition.replay` records nothing here. Provenance is
    instead the explicit `toolCalls` array on every `DeepEnrichResult` variant.
  - Also fixed en route: `AgentIO.onSystem` must be provided (even as a no-op) or
    `runAgentTurnCore` splices system/diagnostic text into the captured assistant output
    via its `io.write` fallback — silent corruption bug, caught by T6's own test suite.
- task-done: T7 (wire classify/deep/light/skip into wikiEnrich). Full suite: 4071
  pass/1 fail (unrelated pre-existing flaky `src/sac/fwk-service.test.ts`, verified
  flaky in isolation, no diff in `src/sac/`); `src/wiki/*`+`src/harness/*`: 73+1186
  pass/0 fail. NFR-4 isolation point: `enrich.ts:753` `if (!wikiConfig.rlm.enabled)` —
  body is the untouched pre-flow worker; RLM path lives entirely in `runRlmPipeline`
  below, unreachable when disabled. Design calls made worth reviewer attention:
  1. Pages with empty `keyFilesForPage()` (non-`component` pages) are excluded from the
     FR-7 staleness fast-path (empty-list hash would otherwise be a constant, making them
     "unchanged" forever) — they always re-run classify instead.
  2. `computeModuleKeyFiles` is 1 module : 1 page, so "batch sibling pages of the same
     module" (FR-5) had no literal match — `batchGroupKey` approximates via first-two-
     path-segments of a page's primary key file, documented as an implementer's call.
  3. Deep-tier fallback reports `action: "skipped"` (reason `deep enrich fallback: ...`)
     and does NOT cache a `nodeHash`, so a future run retries for real rather than being
     permanently stuck on the un-enriched template (AC5).
  Remaining: T3 (tests — largely already covered incrementally by T2/T6/T7's own test
  files; verify gaps before closing), T8 (docs), T4 (provenance check + review + PR).
- task-done: T3, closed directly (no new subagent dispatch needed) after verifying
  `bun test src/wiki/` = 73 pass/0 fail across 11 files, already covering: classify.ts
  fixture-graph boundaries (`classify.test.ts`, from T2), flat-recursion tool-grant
  assertion (`deep-enrich.test.ts`, from T6), and the NFR-4 byte-for-byte parity +
  AC2/AC4/AC5/AC6 scenarios (`enrich-rlm.test.ts`, from T7). No gaps found against
  plan.md step 9 / acceptance-criteria.md.
- task-done: T8 (docs, dispatched to haiku per project preference for simple
  subagent work). Updated `docs/docs/cli-reference.md`'s `enrich` row with RLM-mode
  description grounded in real `src/wiki/config.ts` shape. Deliberately skipped
  README.md (feature-list line stays one-clause, RLM is a config detail not a
  behavior change), `docs/docs/limitations.md` (existing fail-closed note already
  covers the analogous deep-path fallback), and `.metaproject/modules/gdwiki.md`
  (appears managed/generated, not hand-edited). Verified the actual diff before
  closing — accurate and consistent with the doc's style.
- Only T4 (provenance check + code-verifier + review-orchestrator + PR) remains.
- code-verifier gate (T4, ran before review-orchestrator): FAIL→fixed as T9. 1 HIGH
  (type-only import cycle enrich.ts<->staleness.ts, gdgraph flags type-only edges same
  as value edges) + 3 LOW (unused export, 2 untested exports). T9 fixed all 4: hoisted
  `ResumeState` to new `src/wiki/resume-state.ts`, dropped stray export, added direct
  tests for `parseBatchResponse`/`batchGroupKey`. Cycle count back to baseline 2
  (unrelated, pre-existing: src/sac/*, src/tui/*).
- review-orchestrator (T4, logic+architecture and security reviewers in parallel, path
  mode over full file content): DONE_WITH_CONCERNS, 3 major findings, all real bugs not
  pre-justified tradeoffs. Fixed as T10:
  1. FR-7 staleness gate produced FALSE "unchanged" verdicts — `repoMaybeStale`
     (`.git/HEAD` mtime vs graph mtime) does NOT change on ordinary uncommitted edits,
     so it was used to skip per-page hash recomputation entirely, silently leaving
     genuinely-changed pages un-re-enriched. Fixed: per-page hash is now ALWAYS
     computed/compared; the repo-wide gate no longer bypasses it.
  2. RLM-mode per-unit workers (`runLightBatch`/`runDeepSingle`/`runRlmPipeline`'s
     `mapPool` worker) had no try/catch, unlike the RLM-off path — one page's
     provider/write failure crashed the WHOLE `wikiEnrich` run via `Promise.all`,
     losing resume progress for every other already-succeeded page. Fixed: 3-layer
     isolation added, mirrors RLM-off path's per-page failure containment.
  3. `rlm.deep.maxRuntimeMs`/`maxToolCalls` accepted `0`/negative (config.ts's
     `numberOr` had no lower bound), silently DISABLING the deep-child timeout
     entirely (`deadlineMs > 0` check fell through to unbounded `await turn`). Fixed:
     `positiveNumberOr` floor at config-load layer + `deadlineMs <= 0` treated as
     immediate-exhaustion in `deep-enrich.ts` (defense in depth, both layers).
  Full suite after T10: 4086 pass, 0 fail (391 files). Incidental finding (NOT fixed,
  out of scope, flag for future work): `src/wiki/collect.ts`'s page scan calls
  `readFile` on any `.md`-suffixed directory entry without checking `dirent.isFile()`
  first — a `.md`-named directory would crash the scan. Pre-existing, unrelated to
  this flow's changes, discovered incidentally while writing a T10 test.
- 2026-08-18T07:34:12.706Z - task-done: T6: deep-path child turn: spawnSubagent + runAgentTurn + filtered read-only METAPROJECT_OPERATIONS tool grant
- 2026-08-18T07:34:38.975Z - ac-updated: T6 grounding correction: runAgentTurn's InteractiveTool path does not route through ToolRegistry/replay, so ToolDefinition.replay records nothing for deep-path tool calls; AC7 corrected to describe the explicit toolCalls log actually implemented, same audit intent, no scope change
- 2026-08-18T07:58:33.383Z - task-done: T7: light-path batching + skip-path + rlm.enabled=false byte-for-byte parity branch
- 2026-08-18T07:59:09.845Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-18T08:01:07.161Z - task-done: T8: Update wiki-enrich docs (README/docs-site) for optional RLM mode + wiki.config.json
- 2026-08-18T08:06:36.971Z - task-added: T9: Fix code-verifier findings: break enrich.ts<->staleness.ts cycle, drop/fix unused exports, add missing unit tests
- 2026-08-18T08:11:13.582Z - task-done: T9: Fix code-verifier findings: break enrich.ts<->staleness.ts cycle, drop/fix unused exports, add missing unit tests
- 2026-08-18T08:18:25.767Z - task-added: T10: Fix review findings: FR-7 false-unchanged staleness gate, unhandled exceptions crash whole RLM run, non-positive maxRuntimeMs disables timeout
- 2026-08-18T08:33:35.438Z - task-done: T10: Fix review findings: FR-7 false-unchanged staleness gate, unhandled exceptions crash whole RLM run, non-positive maxRuntimeMs disables timeout
- User selected completion path A (PR + review/fix loop + merge). Base branch: `main`
  (HEAD at merge-base `14ffee13` when the flow branch was cut). Flow branch:
  `feat/wiki-enrich-rlm`. Note: the repo's working tree had substantial PRE-EXISTING
  unrelated dirty state at flow-init time (`.claude/settings.json`, `.gitignore`,
  several `.metaproject/*` config/module files, `AGENTS.md`, `CLAUDE.md`, plus
  regenerated `gdgraph`/`wiki index` artifacts from an unrelated earlier task this
  session) — none of that is staged/committed into this PR; only the flow-169 file set
  (src/wiki/* new+modified, docs/docs/cli-reference.md, and the
  docs/requirements/keryx-wiki-enrich-rlm/ + flow package itself) is committed here.
- 2026-08-18T08:42:07.395Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/326 (warning: PR is not a draft)
- 2026-08-18T08:42:17.231Z - ac-confirmed: AC1: enrich-rlm.test.ts: rlm.enabled:false and absent-config runs produce identical WikiEnrichPageResult[] and identical on-disk content (NFR-4 parity test)
- 2026-08-18T08:42:17.316Z - ac-confirmed: AC2: enrich-rlm.test.ts: skip-classified page makes zero LLM calls, output equals collect.ts template unchanged
- 2026-08-18T08:42:17.401Z - ac-confirmed: AC3: deep-enrich.test.ts: buildDeepEnrichTools tool array asserted to contain exactly the 6 named read-only ops, no spawn/shell capability (FR-6)
- 2026-08-18T08:42:17.485Z - ac-confirmed: AC4: enrich-rlm.test.ts: unchanged page skipped on re-run; T10 fix ensures per-page hash always recomputed/compared (not gated by repo-wide staleness), verified by a changed-content-not-skipped test
- 2026-08-18T08:42:17.573Z - ac-confirmed: AC5: deep-enrich.test.ts: budget/timeout exhaustion returns fallback variant, never throws; T10 added try/catch isolation around all RLM per-unit workers so one page's failure cannot crash the whole wikiEnrich run
- 2026-08-18T08:42:17.655Z - ac-confirmed: AC6: enrich-rlm.test.ts: batch overflow splits into multiple groups via repomap.ts's token-budget pattern rather than truncating
- 2026-08-18T08:42:17.738Z - ac-confirmed: AC7: AC text corrected via ac update (T6 grounding correction): DeepEnrichToolCall[] provenance log verified present on every DeepEnrichResult variant, surfaced via WikiEnrichPageResult's deepToolCalls field
- 2026-08-18T08:42:17.821Z - ac-confirmed: AC8: typecheck clean; full bun test suite 4086 pass/0 fail on the feature branch before merge, 87/87 src/wiki/ tests re-verified green on main post-merge
- 2026-08-18T08:42:21.141Z - completing
- 2026-08-18T08:42:23.168Z - done: all gates passed
- 2026-08-31T10:39:10.416Z - task-done: T4: Self-review and prepare draft PR
