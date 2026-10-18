# PR #939 live eval: new review plan (Opus rerun)

Reviewed head: `ede409d5a9d9a5403f51b3f12edc6ac4704d805c`. Ground truth: the six defects later fixed in PR #988, all treated as major. They appear as eight truth entries, because D1 and D2 each have two sites.

**Reviewers and the verifier ran on Opus.** Raw results are in `run/raw-opus/` (20 files). The older Sonnet results in `run/raw/` were ignored.

## Plan
- The worktree, slices and manifest (`run/slices/manifest.json`, host claude-code, maxBytes 18000, waveBytes 54000), `plan-eval.json` and `dispatches.json` were all reused from the earlier attempt.
- 14 slices: 2 deep, 12 light. The 2 audit slices (slice-01 and slice-05) are both deep.
- Dispatches: 20 actual. plan-eval counts 19 because its role list does not include review-regression, which the manifest routes to the two deep slices. The old plan from plan-eval used 36, so this is 44% fewer. One verifier dispatch was added on top.
- Wall time was about 5 minutes for the reviewer waves plus the verifier. Subagent tokens were about 1.95M (20 reviewers at roughly 90-108k each, plus a 74k verifier).

## Recall on known defects
| Truth | Found? | Severity | By |
|---|---|---|---|
| D1-a round-need.ts treats lockfiles, dist/ and steering md as prose | yes | minor | logic-5 F-001 (+F-004 info), clean-code CC-2 |
| D1-b Preflight 2 prose for "round not needed" | yes | minor | logic-2 F-001 |
| D2-a orchestratorToolProblems cannot be satisfied on any host | yes | minor | logic-3 F-002 |
| D2-b preflights name different spawn tools | no (partial) | - | style found the preflight copies drifted (format, depth clause), but not the tool names |
| D3 RATE_LIMITED described inconsistently | yes | minor | logic-2 F-002, style-2 F-002, style-4 F-003 |
| D4 retry-after unbounded | no | - | highload-2 HL-2 read the same function but flagged the missing default backoff instead |
| D5 Path Mode `ctx rg --files` gives an incomplete list | yes | **major** | regression-1 RR1-001 |
| D6 "Done when" requires ingest/complete for every round | no | - | - |

- At major severity: 1/6 defects (D5).
- At any severity: 4/6 defects (D1, D2, D3, D5), which is 5/8 entries.
- Why defects were missed: routing missed nothing, since every truth slice reached a role that had caught that defect historically. The misses come from the reviewers:
  - D4 and D6 were not seen at all.
  - D2-b was seen only partly.
  - D1, D2-a and D3 were found but rated minor, so they would not gate the round.
- Depth: every truth slice was light. The deep reads went only to the two audit slices, which held no truth defects. Deep reading was never tried where the defects were.

## Extra findings
- 69 findings in total, of which 2 are major and 0 are blocker.
- RR1-001 is counted as D5. The verifier confirmed it and found more than the reviewer said:
  - The module-name form `keryx ctx rg --files -g ...` cannot run at all (`buildRgCommand` rejects it with "no pattern given", ctx.ts:1116).
  - The directory form prints summary headers and stops at 120 entries (ctx.ts:1160-1186, ctx.ts:91).
- review-architecture-1 ARCH-1 (flow-orchestrator:24, the review-pr-feedback --fix caller ends in BLOCKED) was **refuted**. The preflight blocks only when the Agent tool is missing or the depth budget is spent, and Claude Code nests 3 deep, so that call chain still fits. What is left is one stale sentence at review-orchestrator SKILL.md:392.
- Precision on extras: 0 confirmed / (0 + 1) = 0.

Several minor findings look real and are not in truth. They were not verified, because the brief verifies only blocker and major findings:
- The `--full` flag in the budget template is unconditional while the prose around it says it is conditional.
- "Step 1a" is an orphan step id.
- Wave grouping in Control contradicts Wave A/B.
- Wave C is still described as unconditional in job-orchestrator.
- The rounds cap is 3 in one orchestrator and 5 in the other.
- The new helpers have no production caller.

## Verdict
- **Known defects: worse.** The old round (36 dispatches, stronger model) found all 6 defects at major. This round found 1/6 at major and 4/6 at any severity.
- **Confirmed extras: equal.** There were none; the one extra major was refuted.
- **Overall: worse, at 44% fewer dispatches.** Routing put each defect in front of a fitting role, so the cut in dispatches did not cause the misses. The losses are severity calibration (three real defects were rated minor) and depth (every truth slice was light). Two defects (D4 and D6) were missed outright.
