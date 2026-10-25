# Verification — flow 474 (review-engine-speedup R1 + R2)

Acceptance by the `Verification:` fields of the package, run on copies of four closed vantage-frontend review packages
(#8174, #8111, #8158, #8086) with the build from this worktree (`bun run src/cli.ts review next|status|report-parity`).
Copies were made with `cp -a` into the session scratchpad; the originals were fingerprinted (path, size, mtime of every
file) before and after: unchanged. Every file the commands changed in a copy is `tool-calls/wave-events.jsonl`, and nothing else.

## Result per package

| Package | `next` says | planAuthorized | Journal |
|---|---|---|---|
| #8174 (`…2026-10-23…vantage-frontend-`) | 8 dispatches, continuation line printed | true | `next` row + `idle` A, gap 2346 min (the clock of the copy is two days after the round) |
| #8111 | done, nothing left | true | `next` row only |
| #8158 | done, nothing left | true | `next` row only |
| #8086 | 1 dispatch, no continuation line | false | `next` row only |

`status` and `report-parity` on the #8174 copy carry "Gaps without a launch after the plan was authorized: 1, longest
2346 min (waits for operator cards are possible)"; the other three have no such line (no `idle` event).

## The #8086 stall (the number the package names)

Replies in `raw/` of #8086 come in 1–2 minute steps, except one hole: the last reply before it is
`review-frontend-w2.txt` at 07:50:00.176Z, the next one at 08:49:21.248Z, 59.35 minutes later. No other pair of replies in
the four packages is more than 6.7 minutes apart (#8174), so the thresholds (10 and 15 min) hold no false positive on
these rounds.

Replay on a copy of `raw/` cut to the replies that existed before the hole (mtimes kept), with an injected clock:

- at 07:55 (5 min after the last reply): no gap;
- at 08:00:30: gap A, 10.5 min (the threshold fires);
- at 08:48:00, the time the operator asked: gap A = 58 min, `since` 07:50:00.176Z;
- gap B with the previous `next` at 07:50:05 and the replies resuming at 08:49:21: 59.3 min.

So "about 58 minutes" is reproduced: A = 58 min at the moment of the operator's question, 59.35 min as the reply-to-reply gap.

## Cost of `packagePlanGate` inside `next`

Five calls in one process: 80 ms on #8174, 84 ms on #8086, about 16 ms a call. A whole `keryx review next` takes
0.70–0.77 s wall on these packages, almost all of it process start. The gate adds no I/O beyond one read of the manifest
and the estimate and is not measurable against a wave of reviewers that takes minutes.

## Findings that the package text did not predict

- #8086 reads `planAuthorized: false` on the current build. The confirmation on file is for `planKey d5787770ce5f4c2e`
  (88 engine dispatches, 44–110 min); the estimate the current engine computes for the same package is 92 dispatches,
  46–115 min, so the key differs and the plan is treated as grown. That is the intended rule (a changed plan needs a new
  `review_confirm_plan` card), and it means the 0.3.131 round of #8086 would not be authorized by today's engine. It is
  a property of the engine version, not a defect of this flow.
- A gap on a copy is measured against the copy's clock, so the #8174 gap A is two days. It proves the line and the
  journal, not a duration of that round; the duration is in the #8086 replay above.
- `status` and `report-parity` take the package as a positional argument (`keryx review status <path>`), not `--package`.

## Requirements that could not be checked on a copy

- E1.1–E1.7 as behaviour of Claude Code: the skill rule is prose; it was reviewed for text (judged AC12), and whether a
  host follows it is visible only in `wave-events.jsonl` of later live rounds. Outside this flow.
- E1.6 (every stop recorded with a reason in the report) and E1.5/E1.7 (one-line status, an operator's question answered
  without interrupting): need a live round.
- Gap B on a real sequence of two `next` calls: replayed with an injected `previous`; no closed package holds a journal
  from the new build.
- The thresholds in a real project's `routing.config.json`: covered by unit tests; the copies have no `reviewWaves` block.
- The TUI panel and sidebar line: covered by `review-parity-visibility.test.ts`; not opened in a live TUI.
- Concurrent writers to one journal (two sessions on one package): `O_APPEND` single write, not stress-tested.
- A shell host: `decideReviewGate` behaviour is unchanged and was not run end to end.

## Discrepancies between the documents and the code

1. `renderNext` prints "(read-only: nothing was written)" conditionally in the code, and `--json` is pretty-printed.
2. `next` lives in `src/review/review-next.ts` now; line numbers of 0.3.131 do not apply.
3. The schema allows an integer or an array for `notRun` / `blocked`; integer counts are written.
4. The round-summary line in the documents is Russian; the repository's output is English.
5. A broken `plan-confirmation.json` does not give `planAuthorized: null`: `readPlanConfirmation` swallows the parse error, so the gate gives false above the threshold and true under it; null only when the gate throws.
6. `orchestrator.jsonl` records memory calls only, so E2.6 holds trivially.
7. SKILL.md names ten cards in the document 11 count (with `review_complete`); E1.3 lists nine plus plan growth (`review_confirm_plan`).
8. `planAuthorized` is computed over the in-memory escalated manifest, so plan growth shows before `--apply`.
9. The schema's `package` is an unbounded string; the row cap is met by cutting it to its last path segment.
10. AC7's wording was corrected before the freeze (the only free-length field is `package`), although the operator approved the draft as it was.
