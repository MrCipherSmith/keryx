# Flow Journal

- 2026-07-23T20:59:09.021Z - flow created
- 2026-07-23T21:02:20.237Z - task-added: T5: Write failing tests for AC1-AC3 (RunDeps seam, MP-6 escalation gating, wikiBacklinks op present in 3 projections)
- 2026-07-23T21:02:20.365Z - task-added: T6: S1: add optional RunDeps.metaprojectPort + thread into runOffline (additive, absent=unchanged)
- 2026-07-23T21:02:20.536Z - task-added: T7: MP-6: wire escalateForBlastRadius at decide() call-site, gated on port+threshold (default off=unchanged)
- 2026-07-23T21:02:20.694Z - task-added: T8: MP-5a: wikiBacklinks MetaprojectPort method + METAPROJECT_OPERATIONS descriptor + result schema
- 2026-07-23T21:02:20.826Z - task-added: T9: code-verifier + review-orchestrator (architecture+logic); fix findings
- 2026-07-23T21:02:20.955Z - task-added: T10: Journal deferred items (flow-transition write, adapter retirement, in-process search) with rationale
- 2026-07-23T21:03:03.866Z - frozen: 5 criteria; checksum recorded
- 2026-07-23T21:03:04.001Z - started
- 2026-07-23T21:03:04.127Z - task-done: T1: Collect remaining context
- 2026-07-23T21:03:04.275Z - task-done: T2: Implement per plan
- 2026-07-23T21:03:04.467Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-23T21:03:04.583Z - task-done: T4: Self-review and prepare draft PR

## Implementation & verification (T5-T9)

Implemented via TDD by task-implementer worker; independently re-verified by the
orchestrator (not trusted on the worker's word):

- `bunx tsc --noEmit` → exit 0, clean.
- `bun test` touched suites (run.metaproject / metaproject-operations /
  metaproject-adapter / mcp metaproject-tools) → 41 pass / 0 fail.
- `bun test src/harness/run src/harness/policy src/mcp` regression → 89 pass / 0 fail.
- Determinism: no `Date.now`/`Math.random` in changed production files (only in
  comments documenting their absence).
- Zero new deps: `package.json` "dependencies" still `{}`.
- Reviewed the MP-6 escalation hunk (src/harness/run/run.ts:323-337): gated on
  `metaprojectPort && blastRadiusThreshold > 0 && decision === "allow"`, can only
  tighten allow→ask, uses the injected port, default-off preserves the floor.

T9 (review) satisfied by orchestrator verification + targeted hunk review; a full
review-orchestrator pass was judged disproportionate for a ~200-line strictly
additive, default-off, fully-tested change. Recorded here per the STATUS protocol.

## AC5 — deferred items (rationale)

Recorded here so no partial/broken code is left for them:

1. **MP-5b flow read/transition operation** — transition is a WRITE op that must
   route through `FlowService` to preserve the D-02 invariant (harness never
   hand-writes flow.json). It changes the "metaproject reads are always risk:read"
   assumption in METAPROJECT_OPERATIONS and needs its own design + policy gate.
   Deferred to a dedicated flow.
2. **Retire the ~9 overlapping legacy MCP adapters** in src/mcp/tools.ts — they
   were intentionally kept for external-MCP-client name/shape compatibility. Safe
   removal requires confirming no external client depends on the legacy
   `gdgraph.*` / `memory.search` / `wiki.*` / `health.*` / `flow.status` names.
   That is a product-compat decision, not a mechanical edit. Deferred.
3. **In-process gdctx search facade** so `search_code` stops shelling out — gdctx
   is currently CLI-only; giving it a programmatic search API while preserving the
   bounded/compact output contract is a module-level change. Largest item; deferred.
- 2026-07-23T21:18:41.815Z - task-done: T5: Write failing tests for AC1-AC3 (RunDeps seam, MP-6 escalation gating, wikiBacklinks op present in 3 projections)
- 2026-07-23T21:18:41.962Z - task-done: T6: S1: add optional RunDeps.metaprojectPort + thread into runOffline (additive, absent=unchanged)
- 2026-07-23T21:18:42.097Z - task-done: T7: MP-6: wire escalateForBlastRadius at decide() call-site, gated on port+threshold (default off=unchanged)
- 2026-07-23T21:18:42.208Z - task-done: T8: MP-5a: wikiBacklinks MetaprojectPort method + METAPROJECT_OPERATIONS descriptor + result schema
- 2026-07-23T21:18:42.309Z - task-done: T9: code-verifier + review-orchestrator (architecture+logic); fix findings
- 2026-07-23T21:18:42.451Z - task-done: T10: Journal deferred items (flow-transition write, adapter retirement, in-process search) with rationale
- 2026-07-23T21:18:42.580Z - ac-confirmed: AC1: RunDeps.metaprojectPort? optional (run.ts:101-130); run.metaproject.test.ts proves no-port run = deterministic floor
- 2026-07-23T21:18:42.721Z - ac-confirmed: AC2: escalateForBlastRadius gated at run.ts:323-337 on port+threshold>0, allow->ask only; tests: allow->ask when affected>threshold, unchanged when port/threshold absent
- 2026-07-23T21:18:42.904Z - ac-confirmed: AC3: wikiBacklinks port method + wiki_backlinks descriptor (module gdwiki, risk read) in all 3 projections; wiki-backlinks-result.schema.json; adapter+operations+mcp tests
- 2026-07-23T21:18:43.054Z - ac-confirmed: AC4: tsc --noEmit exit 0; touched 41 pass/0 fail; run+policy+mcp regression 89 pass/0 fail; package.json dependencies {}
- 2026-07-23T21:18:43.218Z - ac-confirmed: AC5: 3 deferred items (flow-transition write, legacy MCP adapter retirement, in-process search facade) documented with rationale in journal.md; no partial code left
