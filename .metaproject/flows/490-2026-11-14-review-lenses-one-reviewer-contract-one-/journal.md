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
- 2026-11-14T09:25:31.853Z - task-done: T9: Stale references and missing-input fallbacks
- 2026-11-14T09:25:32.292Z - task-done: T11: Pinning test review-lens-contract.test.ts, mirror, versions, ceilings, gdskills tests
- 2026-11-14T09:25:47.154Z - task-attempt: T12: started (attempt 1) — after-arm bench

## T12 — bench repeat (AC8), 2026-11-14

The first bench showed before 14.0 and after 11.5 of 22. All the loss was on c09 and c11, and the unchanged logic lens moved too, so I repeated it. The repeat ran security-code and regression on c09 and c11, two runs per arm. Every arm went through the same blind judges (m01..m08).

| arm | c09 | c11 | total | security-code | regression |
|---|---|---|---|---|---|
| B1 (old) | 1.5 | 4.0 | 5.5 | 3.0 | 2.5 |
| B2 (old) | 0.5 | 4.0 | 4.5 | 2.0 | 2.5 |
| A1 (new) | 0.5 | 3.0 | 3.5 | 2.0 | 1.5 |
| A2 (new) | 2.0 | 3.0 | 5.0 | 3.0 | 2.0 |

- **security-code:** mean 2.5 before and 2.5 after. No change.
- **regression:** mean 2.5 before, 1.75 after (-0.75). This is within AC8's -1 tolerance.
- **c09:** the swing between runs (0.5..2.0) is larger than the gap between arms.
- **c11:** each new run misses one truth item, but a different one each time (A1 T1, A2 T4). That points to sampling, not to a lost check.
- **What changed in regression:** on a non-FIX slice the diff only adds a FIX-slice paragraph, a criteria fallback, and moves "thin test" to testing-practices. No detection check was removed.

AC8: met, with a residual -0.75 on regression noted. **Superseded** by the "AC8 per lens" section below, which gives the verdict "plausibly met, not proven".
- 2026-11-14T09:44:30.023Z - task-done: T12: Recall bench after the edits and comparison with baseline

## AC8 per lens (review round 1 asked for all four), 2026-11-14

The judges matched each truth item to the finding that found it. Score = match + 0.5 x partial. B is the base lens, A is this flow's lens. The first bench covers cases c01, c02, c03, c09 and c11, one run per arm. The repeat covers c09 and c11 for security-code and regression only, two runs per arm. All runs went through the same blind judge brief.

| lens | first bench B -> A | repeat c09+c11, B mean -> A mean | changed by this flow |
|---|---|---|---|
| logic | 3.0 -> 5.0 | not repeated | no (control) |
| security-code | 4.0 -> 2.0 | 2.5 -> 2.5 | yes |
| regression | 2.5 -> 1.0 | 2.5 -> 1.75 | yes |
| testing-practices | 4.5 -> 3.5 | not repeated | yes |

Notes:
- **Attribution.** One truth item can be credited to more than one lens, so per-lens sums can exceed the case total. In this run they happen to equal it: 14.0 before and 11.5 after.
- **Reading.** The unchanged logic lens moved +2 between identical runs, which shows the noise level of a single run.
- **security-code:** the repeat shows no difference on c09 and c11, where its whole first-bench loss on those cases happened. The remaining 1 point of its first-bench loss is on c01-c03, single run, not repeated.
- **testing-practices:** -1 in a single run, which is at the tolerance edge, not repeated.
- **regression:** -0.75 averaged over the two repeat runs on c09 and c11.
- **Tolerance.** AC8 does not say whether its tolerance is per lens or pooled. Read per lens, two lenses exceed -1 in the single first run:
  - **security-code:** -2.0 in the first run, 0.0 averaged over the two repeat runs on c09 and c11.
  - **regression:** -1.5 in the first run, -0.75 averaged over the two repeat runs.
- **Lens text benched.** The "after" arm was benched on the lens text at T12, before review-fix commit fdf0df1f2. That commit edited all four AC8 lenses again: it bumped logic to 1.1.0 (preamble only), changed the security-code law, and changed testing-practices and regression wording. So logic is not an exact control at head, and the head text of these lenses was not benched.

**Verdict for the gate judge: AC8 is plausibly met, not proven.** Proving it needs a pooled bench of at least 3 runs per arm on all five cases, which was not run within this flow's budget.

- **Baseline case set.** The cases differ from plan.md (c02/c03/c05/c09): T5 ran c01, c02, c03, c09 and c11 instead. The reason for the swap was not recorded. c05 does have truth items (4), so this is a deviation from the plan, not a forced substitution.
- **Raw outputs.** They live in the session scratchpad and are not committed.

## Review round 1 notes

- **AC9 locally:** `src/gdskills/install.test.ts` "read-only rules/core directory" fails with EACCES on the base branch too, so it is environmental. Judge AC9 from CI.
- **AC3:** frozen AC3 allows ui-ux to run a server only when the payload supplies its URL. The built lens never starts a server and uses a supplied URL or screenshots only, so AC3's clause is met vacuously; AC3 itself is unchanged.
- **Earlier concern resolved:** the T8 concern that review-frontend still had inline `major` labels was resolved in review-fix commit fdf0df1f2.
- **Plan steps vs flow task ids:** plan step Tn is flow task T(n+5), so plan T1..T7 are flow T6..T12. Flow T5 is the baseline bench from the plan's quality-guard paragraph. Flow T12 is the after-bench (plan T7), and the repeat ran inside it. The scaffold rows T1..T4 were registered by `flow init`. T1..T3 were marked done before the freeze; that is scaffold bookkeeping and no work was done under them. T4 is this review.
