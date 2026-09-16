# Decisions

- F-001: acted-on — Commit 'test(shell): harden the flow-263 tests against the review findings' adds the behaviour-level wiring test. (valid_followup, post_flow_feedback).
- F-002: acted-on — Same commit: idle windows widened to 2 s, the start-buffer test now asserts fgElapsed < bgElapsed / 2. (valid_followup, post_flow_feedback).
- F-003: acted-on — Same commit: the probe now polls to a 10 s deadline. (valid_followup, post_flow_feedback).
- F-004: acted-on — Same commit: try/finally added with a cleanup kill and sweepAll. (valid_followup, post_flow_feedback).
- F-005: acted-on — Same commit: AC4/AC8 killReason test added to background-job-session.test.ts. (valid_followup, post_flow_feedback).
- F-006: acted-on — Same commit: replaced by expect(elapsed).toBeGreaterThanOrEqual(idleMs). (valid_followup, post_flow_feedback).
- F-007: acted-on — Same commit: 'idle kill and lost-task results (fakes, every platform)' block added to shell-exec-background.test.ts. (valid_followup, post_flow_feedback).
- L-001: dismissed-wont-fix — Recorded as an accepted minor in .metaproject/flows/263-2026-09-15-background-task-execution-p0-every-shell/journal.md under the orchestrator logic review. (valid_followup, post_flow_feedback).
- L-002: dismissed-wont-fix — Documented in the constant's doc comment and in the flow journal as an accepted trade-off. (valid_followup, post_flow_feedback).
- B-001: acted-on — Commit 'chore(wiki): regenerate the index after marking background-jobs superseded in part' adds the banner; the full rewrite and the test-catalog rows are scheduled for phase P3 in docs/requirements/keryx-background-task-execution/. (valid_followup, post_flow_feedback).
