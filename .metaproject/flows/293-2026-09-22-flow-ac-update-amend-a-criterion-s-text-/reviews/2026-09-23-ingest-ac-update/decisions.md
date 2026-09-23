# Decisions

- F-001: acted-on — fixed by the CRLF-aware split/join in commit 3cca5176 (T9: 'amend criteria correctly in CRLF and multi-line files, and read flag values as given'); merged to main in 1b38143a via PR #653. (valid_followup, post_flow_feedback).
- F-002: acted-on — fixed by acBlockEnd-based block removal on replace, added in commit 3cca5176 (T9); this block-deletion behaviour was itself superseded two days later by commit 9ebbb1b0 (T10) after review pass 2 found it deleted content that was not part of the criterion (see F-006) — merged to main in 1b38143a via PR #653. (valid_followup, post_flow_feedback).
- F-003: acted-on — fixed by validateSingleLineReason in commit 3cca5176 (T9), with a byte-unchanged-journal regression test in service.test.ts; merged to main in 1b38143a via PR #653. (valid_followup, post_flow_feedback).
- F-004: acted-on — fixed by the single-pass parseAcArgs in commit 3cca5176 (T9); merged to main in 1b38143a via PR #653. (valid_followup, post_flow_feedback).
- F-005: acted-on — fixed by the gap-naming branch in commit 3cca5176 (T9), with a gap-vs-out-of-range distinction test in service.test.ts; merged to main in 1b38143a via PR #653. (valid_followup, post_flow_feedback).
- F-006: acted-on — fixed by removing block-deletion and refusing a multi-line replace outright, in commit 9ebbb1b0 (T10: 'refuse to replace a multi-line criterion instead of guessing where it ends'); merged to main in 1b38143a via PR #653. (valid_followup, post_flow_feedback).
- F-007: acted-on — fixed by per-line-ending tracking (splitAcLines/renderAcLines) in commit 9ebbb1b0 (T10); merged to main in 1b38143a via PR #653. (valid_followup, post_flow_feedback).
