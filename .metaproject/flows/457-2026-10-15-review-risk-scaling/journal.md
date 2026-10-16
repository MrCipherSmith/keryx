# Flow Journal

- 2026-10-15T21:34:19.482Z - flow created
- 2026-10-15T21:43:02.876Z - task-done: T1: Collect remaining context
- 2026-10-15T21:43:03.040Z - task-done: T2: Implement per plan
- 2026-10-15T21:43:03.207Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-15T21:43:03.372Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-15T21:43:03.538Z - task-added: T5: A: symbol radius, text links, reasoned omissions, radius bugs
- 2026-10-15T21:43:03.707Z - task-added: T6: B: slice routing, risk depth, audit, escalation, estimate gate, NaN
- 2026-10-15T21:43:03.879Z - task-added: T7: C: harness robustness (raw per package, autonomous, attended, cards, verify-run, item 10, drift)
- 2026-10-15T21:43:04.048Z - task-added: T8: D: review-orchestrator skill across hosts
- 2026-10-15T21:43:04.216Z - task-added: T9: E1: plan-eval offline comparison
- 2026-10-15T21:43:04.378Z - task-added: T10: E2: live eval rounds on #424 #939 #940 #1005
- 2026-10-15T21:43:04.541Z - task-added: T11: Review round + PR + merge
- 2026-10-15T21:43:04.708Z - task-added: T12: Release 0.3.119
- 2026-10-15T21:43:04.870Z - task-added: T13: Owner live check
- 2026-10-15T21:43:05.042Z - frozen: 14 criteria; checksum recorded
- 2026-10-15T21:43:05.216Z - started
- 2026-10-15T22:09:52.303Z - task-done: T6: B: slice routing, risk depth, audit, escalation, estimate gate, NaN
- 2026-10-15T22:16:41.970Z - task-done: T5: A: symbol radius, text links, reasoned omissions, radius bugs
- 2026-10-15T22:28:30.253Z - task-done: T7: C: harness robustness (raw per package, autonomous, attended, cards, verify-run, item 10, drift)

## 2026-10-16 offline plan-eval (T9 / AC10)
`review plan-eval --max-bytes 18000 --wave-bytes 54000` (vantage-sized slices), roles = 8-role keryx roster, after routing fix (lane b2):

| input | slices | dispatches old → new | B/M landed old / new |
|---|---|---|---|
| #424 round1 | 6 | 15 → 9 (-40%) | 13/13 / 13/13 |
| #939 | 14 | 36 → 18 (-50%) | 8/8 / 8/8 |
| #940 | 15 | 37 → 21 (-43%) | 4/4 / 4/4 |
| #1005 round1 | 2 | 8 → 5 | 3/3 in diff |
| #1005 full | 32 | 64 → 21 (-67%) | 6/6 / 6/6 |

Blast radius (real CLI, pinned base...head), mandatory chunks old → new: #940 55 → 0 (161 tests moved to tests-to-run), #1005 48 → 3 (205 tests to run). Dispatches + chunks on the two largest diffs: #940 92 → 21 (-77%), #1005 112 → 24 (-79%). Every ground-truth finding file stays in the reviewed set.
First routing pass missed 3 architecture/security findings (#424 ×2, #939 D2-b, #1005 F-067 only via audit) → routing rules fixed by principle + regression fixtures in plan-eval.test.ts.
- 2026-10-15T22:38:20.428Z - task-done: T9: E1: plan-eval offline comparison
- 2026-10-16T03:56:32.294Z - task-done: T8: D: review-orchestrator skill across hosts
- 2026-10-16T04:50:28.249Z - ac-updated: AC8: "Harness robustness: results and drivers live per package; wave bytes per host; the autonomous prompt passes scope/package and runs one round unless the head moved; attended is derived from mode, and `chunks estimate --mode automatic` / `publish --yes` cannot bypass the operator; mutation waiver, reviewer-set override and `comments reply --final` need a card or TTY; item 10 says "not observable" outside keryx shell; trigger reviews route to the autonomous runner; verification commands can run in the parent and reach the verifier as context; installed host skill copies older than bundled are warned about. [verify: exec `bun test src/review/harness-robustness.test.ts`]" -> "Harness robustness: results and drivers live per package; wave bytes per host; the autonomous prompt passes scope/package and runs one round unless the head moved; attended is derived from mode, and `chunks estimate --mode automatic` / `publish --yes` / `review start --unattended` cannot bypass the operator; mutation waiver, reviewer-set override, plan confirmation and `comments reply --final` need a card or TTY and are bound to what the operator saw; item 10 says "not observable" outside keryx shell; trigger review tasks go through the normal containment, spend and attempt path (routing them to the autonomous runner was reverted: it would bypass the sandbox and budget); verification commands can run in the parent and reach the verifier as context; installed host skill copies older than bundled are warned about. [verify: exec `bun test src/review/harness-robustness.test.ts`]" (security review: routing trigger reviews to the autonomous runner bypassed containment, spend and attempts; reverted; plus decision binding and the --unattended gate)

## 2026-10-16 live evaluation and review rounds
- Live single runs (Opus) scored against multi-round truth looked worse on #424/#939/#1005 → root cause: light depth on code. Fixed (code/instructions/schemas always deep; then full applicable roster on deep slices; minors never dropped — findings cap trims info only; verdict lists minors).
- Fair A/B (old vs new, same model/prompts): #424 new better (6/8 vs 4/8 any), #1005 tie, #939 tie on defects found with one fewer major; 60-80% of cost. #940 single run: 4/4 known + 8 new confirmed; 6 still on main → PR #1037.
- Review round (security + correctness, Opus): blockers — trigger review bypassed containment (reverted), operator commands missing from the CLI allowlist, red tests; majors — env-var exemption forgeable, --unattended self-declared, routing trusted from manifest, decisions unbound, hub damping hid direct callers, branch base, base text commit, plan key ignored cost, escalation only via retry-plan, verify-run grandchildren, skill drift on npm, pre-457 packages refused. All fixed in lanes S and R; AC8 updated (trigger routing reverted).
- Eval artifacts: eval/README.md + per-PR reports.
- 2026-10-16T04:51:10.086Z - task-done: T10: E2: live eval rounds on #424 #939 #940 #1005
