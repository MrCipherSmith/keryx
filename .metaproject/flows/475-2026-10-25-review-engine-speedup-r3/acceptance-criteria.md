# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: requirements package `review-engine-speedup`, step 2 (R3 = E4.1–E4.4; specification C1–C5). Not in this flow: R4–R6, E3.x, E4.5–E4.7, E5–E7.

## Criteria

- AC1: `reviewNext` evaluates every valid, not-yet-counted reply of a reviewer in wave order, not only the newest one. The wave is the number in `-w<n>` (or the driver's `wave`); mtime orders only replies with no number. Coverage of each reply counts: a reviewer whose `w1` covered slices A and `w2` covered slices B has A and B covered even when `w1` has the newer mtime. [verify: exec `bun test src/review/review-next.test.ts -t "wave order"`]
- AC2: A repeated `next` call gives the same result: the second run (read-only, and after `--apply`) prints the same text and `--json` as the first, and adds no dispatch, because a reply whose hash is in `processed` is not counted twice. [verify: exec `bun test src/review/review-next.test.ts -t "idempotent"`]
- AC3: Files matching `*.prev*.txt` do not take part in the choice of results: an `X.prev.txt` newer than `X.txt` is not chosen, and `X.txt` is the reply that is evaluated. [verify: exec `bun test src/review/review-next.test.ts -t "prev files"`]
- AC4: `needs_context` entries that are objects are read as questions by one exported helper `needsContextQuestions`, used by the retry plan, the late-result collector and the ledger: a `security-code` style reply with object questions gives decision `context` (not `accepted`), and the ledger and the collector agree on which entries are open. [verify: exec `bun test src/review/retry-plan.test.ts src/review/retry-eval.test.ts src/review/ledger.test.ts -t "needs_context"`]
- AC5: A finished reply (`DONE`, `DONE_WITH_CONCERNS`) with no `slices` array is not accepted silently: `next` lists it as `rejected` with a reason in the text and in `--json`, its reviewer's slices stay open and the reviewer is dispatched again; a reply with a `slices` array (even empty) is unchanged. [verify: exec `bun test src/review/review-next.test.ts -t "without slices"`]
- AC6: Escalations (a major or worse on a light slice) are taken from every counted reply, not only the newest one. [verify: exec `bun test src/review/review-next.test.ts -t "escalations from every reply"`]
- AC7: A `retry-state.json` written by an older build (missing `processed`, `covered`, `stalls` or `questions`, or an entry of another shape) is read without throwing, and no reviewer whose slices are covered becomes `notRun`. [verify: exec `bun test src/review/review-next.test.ts -t "old-format state"`]
- AC8: Acceptance by `Verification:` on a copy of vantage-frontend #8174 (original untouched): the six spurious `[missing]` of the baseline are gone, the one reviewer that is truly missing remains, no reviewer is `notRun` where its slices are covered, and `next` run twice (and `--apply` followed by `next` twice) gives identical output. [verify: judged]
- AC9: Regression on copies of #8111, #8158 and #8086 against the baselines taken on main: any difference in dispatches is listed in `verification.md` with its cause; the originals of all four packages are byte-identical before and after (path, size, mtime fingerprint); every doc-versus-code discrepancy and every requirement that could not be checked on a copy is recorded there. [verify: judged]
- AC10: The four copies of the `review-orchestrator` skill (installed and bundled, `SKILL.md` and `SKILL.detail.md`) are byte-identical pairwise and describe wave-ordered counting, the `.prev` exclusion and `rejected`; `docs/docs/cli-reference.md`, `docs/docs/guides/review-with-a-record.md`, `README.md` where it describes `next`, and `CHANGELOG.md` `[Unreleased]` describe them too. [verify: exec `sh -c 'cmp src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md && cmp src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md .metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md && grep -q rejected docs/docs/cli-reference.md && grep -q "prev" CHANGELOG.md'`]
- AC11: Representation in the TUI: no new surface is needed, because `next` is a command output with no panel of its own; the review panel and the reviews inspector read the ledger and the parity view, which this flow does not change, and their existing tests pass. [verify: exec `bun test src/review/parity.test.ts src/tui/review-panel.test.ts`]
- AC12: The type check passes and the related test files pass. [verify: exec `sh -c 'bun run typecheck && bun test src/review/review-next.test.ts src/review/retry-plan.test.ts src/review/retry-eval.test.ts src/review/ledger.test.ts src/commands/review-next.test.ts'`]
- AC13: The work stays local: no commit or push without the operator's word, and nothing in the files, branch or flow text carries an AI authorship line. [verify: judged]
