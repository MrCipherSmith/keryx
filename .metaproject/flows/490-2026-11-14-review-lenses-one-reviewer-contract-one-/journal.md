# Flow Journal

- 2026-11-14T09:10:25.236Z - flow created
- 2026-11-14T09:12:41.441Z - task-added: T5: Baseline recall bench for current lenses (testing-practices added)
- 2026-11-14T09:12:41.880Z - task-added: T6: Contract and schema: reviewer command list, empty sites with enumeration_method, one known_findings
- 2026-11-14T09:12:42.339Z - task-added: T7: No in-tree mutation: testing-practices, verifier, degradation, ui-ux
- 2026-11-14T09:12:42.786Z - task-added: T8: One severity rubric across highload, backend, security-code, architecture, clean-code, style, performance, frontend
- 2026-11-14T09:12:43.252Z - task-added: T9: Stale references and missing-input fallbacks
- 2026-11-14T09:12:43.721Z - task-added: T10: Retarget performance and highload to CLI/TUI hot paths and repo concurrency
- 2026-11-14T09:12:44.181Z - task-added: T11: Pinning test review-lens-contract.test.ts, mirror, versions, ceilings, gdskills tests
- 2026-11-14T09:12:44.651Z - task-added: T12: Recall bench after the edits and comparison with baseline
- 2026-11-14T09:12:45.121Z - task-done: T2: Implement per plan
- 2026-11-14T09:12:45.601Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-14T09:12:46.085Z - task-done: T1: Collect remaining context
- 2026-11-14T09:12:46.580Z - frozen: 9 criteria; checksum recorded
- 2026-11-14T09:12:47.059Z - started
- 2026-11-14T09:13:35.789Z - task-attempt: T5: started (attempt 1) — f490-T5 dispatch
- 2026-11-14T09:13:36.249Z - task-attempt: T6: started (attempt 1) — f490-T6 dispatch
- 2026-11-14T09:13:36.709Z - task-attempt: T7: started (attempt 1) — f490-T7 dispatch
- 2026-11-14T09:13:37.175Z - task-attempt: T8: started (attempt 1) — f490-T8 dispatch
- 2026-11-14T09:13:37.629Z - task-attempt: T9: started (attempt 1) — f490-T9 dispatch
- 2026-11-14T09:13:38.102Z - task-attempt: T10: started (attempt 1) — f490-T10 dispatch
- 2026-11-14T09:18:19.299Z - task-done: T6: Contract and schema: reviewer command list, empty sites with enumeration_method, one known_findings
- 2026-11-14T09:19:27.704Z - task-done: T7: No in-tree mutation: testing-practices, verifier, degradation, ui-ux
- 2026-11-14T09:21:48.103Z - task-done: T10: Retarget performance and highload to CLI/TUI hot paths and repo concurrency
- 2026-11-14T09:22:11.397Z - task-done: T5: Baseline recall bench for current lenses (testing-practices added)
- 2026-11-14T09:23:13.862Z - task-done: T8: One severity rubric across highload, backend, security-code, architecture, clean-code, style, performance, frontend

## 2026-11-14 implementation (T5-T11)

- T5 baseline: 21 lens runs (13 reused from the session's 150 KB slice bench, 8 new) on c01, c02, c03, c09, c11 with the bench brief; outputs in the session scratchpad `slicebench/out/`.
- T6 orchestrator spawn bullet now lists git log/blame/show, the layers-block commands and keryx ctx rg/read, and forbids tests/health/servers/mutation/writes; `class_scope.sites` may be empty with a non-empty enumeration_method (also in the strict contracts copy, pinned identical); duplicate `known_findings` merged (the strict definition was already the effective one).
- T7 testing-practices and verifier mutate only through `keryx review mutate`; degradation's red-test/merge-trace only from orchestrator or scratch; ui-ux never starts a server; regression FIX-slice and frozen-criteria fallbacks; pr-contract `keryx wiki query` removed.
- T8 severity: layer violations, structural, duplication, comments, circular imports rated by the canonical boundary test (minor unless a named defect or project rule); unreachable security weakness info; verdict tokens removed. `review-skills-iron-laws.test.ts` "layer violation is major in both" became "rated the same, minor by default": its purpose (the two lenses agree) kept; the old `major` contradicted the canonical boundary test.
- T9 covered inside T7/T8/T10; the code-style-review / code-mobx-store-review hand-offs were already gone on this base (removed with the code-* profiles in PR 1172).
- T10 performance/highload: CLI/TUI hot-path and repo-concurrency sections first; highload's 22 inline Flags severity labels removed (conditions kept); load_profile fallback.
- Concern (out of scope, follow-up): review-frontend still has inline `major` labels on convention conditions with no trigger (missing `private`, `any` in new code, `observer` inside another HOC, public async action doing IO).
- `install.test.ts` "read-only rules/core directory" fails on the base branch too (EACCES in this environment): pre-existing, not this flow.
- Execution-metrics question not asked (owner follows on a phone); no metrics collected.
