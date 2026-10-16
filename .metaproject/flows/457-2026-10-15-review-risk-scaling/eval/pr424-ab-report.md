# PR #424 round 1 — A/B: OLD plan vs NEW plan (Opus, identical prompts)

Diff `input.round1-be825deab.diff`, head `be825deab`. Truth: 8 R1 findings (all major). 6 slices; waves w1 = slice-01..04, w2 = slice-05..06.
NEW roster from manifest: architecture, highload, logic, regression, security-code, style on slices 01-05 (deep); logic + testing-practices on slice-06 (light); clean-code and performance not routed.

| | OLD | NEW |
|---|---|---|
| Dispatches | 18 | 13 |
| Wall (to last output) | ~408 s | ~379 s |
| Agent time (sum) | 1172 s | 778 s |
| Approx tokens | 1,648,174 | 1,138,086 |
| Truth found (any) | 4/8 | 6/8 |
| Truth found (major) | 1/8 | 1/8 |
| Missed | R1-SEC-002, R1-SEC-003, R1-LOGIC-001, R1-LOGIC-003 | R1-SEC-003, R1-LOGIC-001 |
| Confirmed extras | X1, X2 | X1, X2 |

Wall times overlap: both arms ran interleaved under a shared 20-subagent cap that other sessions were also using.

## OLD matches
| Truth | Best severity | Raw findings |
|---|---|---|
| R1-ARCH-001 | major | logic-w1#1; regression-w1#0 |
| R1-ARCH-002 | minor | architecture-w1#0 (inter-skill contract is free-text constraint strings); regression-w1#4 |
| R1-LOGIC-002 | minor | logic-w1#3; regression-w1#2; regression-w2#1; testing-practices-w1#4 |
| R1-SEC-001 | minor | logic-w1#5 (concatenated screen unmappable to comment id); security-code-w1#1 (info) |

## NEW matches
| Truth | Best severity | Raw findings |
|---|---|---|
| R1-ARCH-001 | minor | architecture-w1#2; logic-w1#3 |
| R1-ARCH-002 | minor | architecture-w1#3 (partial: constraint keyed on free text, producer wording differs); architecture-w1#4 |
| R1-LOGIC-002 | minor | architecture-w1#1; logic-w2#0 |
| R1-LOGIC-003 | major | logic-w1#1 (new needs-clarification verdict after re-collection has no disposition row) |
| R1-SEC-001 | info | security-code-w1#3 (<collected-bodies> finding cannot map to a comment id) |
| R1-SEC-002 | minor | security-code-w1#0 (completion: outcome A skips human consent, no confirmation evidence required) |

## Confirmed extras (major, not in truth; one Opus verifier, both confirmed)
- X1: comment_ids subset + --fix: Step 10 reply pass re-collects all unhandled comments and buildReplyPass refuses the pass, so excluded comments abort it after the merge. Found by both arms.
- X2: output contract fix.flow_status enum (initialized/in_progress/failed) does not match FLOW_STATUSES; the skill's own in-progress stop state fails its schema. Found by both arms.

## Verdict
- Recall-any: NEW 6/8 vs OLD 4/8. NEW also found R1-SEC-002 (minor) and R1-LOGIC-003 (major); OLD found neither.
- Recall-major: tied at 1/8. NEW rated R1-LOGIC-003 major; OLD rated R1-ARCH-001 major, which NEW found only at minor.
- Neither arm found R1-SEC-003 or R1-LOGIC-001.
- Confirmed extras: tied (the same two).
- Cost: NEW uses 13 dispatches vs 18, and about 31% fewer tokens and 34% less agent time.
- The two roles NEW dropped (clean-code, performance) found nothing in truth and no major findings.
- NEW is no worse on quality and is cheaper. One PR is a small sample.
