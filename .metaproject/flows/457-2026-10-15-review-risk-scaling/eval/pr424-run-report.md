# PR #424 round 1: new-plan live eval (Opus rerun)

Diff: `input.round1-be825deab.diff`. Reviewed head: be825deab. Only the R1-* truth findings are scored. **All reviewers and the verifier ran on Opus.** Results are in `run/raw-opus/`; `run/raw/` was ignored.

## Plan
- The existing manifest (`run/slices/manifest.json`, host claude-code, maxBytes 18000, waveBytes 54000) and `run/plan-eval.json` were reused. The worktree `run/tree` was confirmed to be at be825deab.
- There are 6 slices: 2 deep (slice-05, risk 0.9 from the schema files; slice-03 as the audit sample) and 4 light.
- Dispatches: 10 actual against 9 in plan-eval. The manifest also routes `review-regression` onto the deep slices, which plan-eval's perRole table does not list. The old plan used 15. Actual reduction is 33% (plan-eval says 40%).
  - architecture x2 (01-04, 05)
  - logic x2 (01-04, 05-06)
  - style x2 (01-04, 05)
  - security-code, highload and regression x1 each (03+05)
  - testing-practices x1 (06)
- Verifiers: 1 dispatch, covering 4 extras.
- Wall time was about 5.2 min for the reviewers, inflated by a shared 20-subagent cap, plus 0.8 min of verification. Total tokens were roughly 0.98M.

## Recall (R1 truth, 8 present)
| Truth | Result | Matched by |
|---|---|---|
| R1-SEC-001 batched screen over `<collected-bodies>` | found (minor) | security SEC-2 |
| R1-SEC-002 fix:true with no confirmation field | **missed (routing)** | The text is in light slice-04/02, and security only read deep 03/05 |
| R1-SEC-003 check-input pass/warn/exit 0; Step 3 vs 9 | **missed (reviewer)** | In slice-03, which security read; it flagged only the `--source external` flag |
| R1-ARCH-001 max_fix_rounds never transmitted | found (minor) | logic LOGIC-4 |
| R1-ARCH-002 untyped constraints carrier / base_branch / registry | partial (minor) | arch ARCH-2, logic LOGIC-7, style STYLE-2 (only the constraints part) |
| R1-LOGIC-001 test guards match Red Flags rows | **missed (reviewer)** | testing TEST-1 is adjacent (presence-only guards) but is a different mechanism |
| R1-LOGIC-002 output block vs schema (STATUS, summary) | found (minor) | 4 reviewers, all minor |
| R1-LOGIC-003 needs-clarification has no Step 10 row | **missed (reviewer)** | logic read every slice that contains it |

Recall at any severity is 4/8 (3 full and 1 partial). Recall at major or above is **0/8**: every match was rated minor, while the historical round rated all 8 major.

## Extras (major, not in truth)
| Id | Finding | Verdict |
|---|---|---|
| E1 | fix.flow_status enum != FlowStatus; the skill's own `in-progress` stop fails the schema (3 reviewers) | confirmed |
| E2 | comment_ids leaves excluded comments without a disposition, and `comments reply` throws at Step 10 | confirmed |
| E3 | Step 2 BLOCKS closed/merged PRs even in analyze mode | confirmed |
| E4 | collector severity holds the fix loop | refuted (the loop exit reads fix-PR findings, not comment severity) |

Precision: 3/4 = 0.75.

## Verdict
- **Known defects: worse.** Half the truth was surfaced, and none of it at major.
  - One miss came from routing: the security role does not run on light slices of a security-sensitive skill file.
  - Three misses were reviewer misses on slices that were in scope.
- **Confirmed extras: better.** Three real major defects were found that are not in truth.
- **Cost:** 10 dispatches against 15.
