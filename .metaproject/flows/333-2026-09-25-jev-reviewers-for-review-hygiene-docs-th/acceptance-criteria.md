# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review jev-docs (--diff <ref>|--pr <n>) [--json]` finds docs that went STALE: doc sections (docs/**, README, wiki pages, skill/rule docs) are linked to code deterministically (explicit paths/symbols/CLI verbs/flags they mention, gdwiki/gdgraph links); for every section linked to code the diff changes but that the diff does NOT itself edit, one Jev `noul` "given this code change, is this section now inaccurate?" with the section text and the relevant hunks, bounded by `--max-calls` with truncation reported.
- AC2: The docs reviewer emits findings (reviewer `review-jev-docs`, severity `minor`) naming the section (file + heading + line), the code change that likely outdated it, and a suggested update target; a CLI flag renamed/removed in the diff but still mentioned in docs is flagged deterministically without Jev.
- AC3: `keryx review jev-comments --pr <n> [--json]` checks whether PR review comments were ADDRESSED: comments come from the existing ledger (`keryx review comments collect`, `.metaproject/reviews/pr-comments/*.json`); facts per comment: commits after the comment timestamp touching the commented file/lines, the thread's resolved flag, replies; then one Jev `choice` per open comment among `resolved-by-fix | still-open | not-actionable | needs-escalation` with the comment text, the later hunks at that location and the replies.
- AC4: The comments reviewer emits findings (reviewer `review-jev-comments`) for `still-open`/`needs-escalation` comments (severity `minor`/`major` for escalation), and its per-comment choice is surfaced to the existing Step 14 reply flow (`keryx review comments reply`) as an advisory label, never auto-replying or auto-resolving.
- AC5: Both commands are opt-in (`review.jev.docs`, `review.jev.comments`); without the opt-in they print deterministic facts only; redaction via `src/security/service.ts`; no GitHub write anywhere in this flow.
- AC6: Shell: `/staledocs` and `/opencomments` (or tabs in an existing review modal) list stale-doc candidates and open comments with their Jev label for the current branch/PR; English UI; render tests.
- AC7: The reviewer is registered in the review orchestrator as an ADDITIONAL reviewer (never replacing any): `review-orchestrator/SKILL.md` (bundled + installed copy) dispatches it via the CLI when its opt-in key is set and Jev is reachable; `keryx review reviewers --json` lists it with `engine: jev`; its findings pass the same quality gate, dedup and Wave C verification. If flow 330 (review-jev-rules) has already landed on main when this is implemented, follow its registration pattern exactly.
- AC8: Tests: pure functions for fact gathering and finding synthesis, CLI tests with fixture diffs/docs/comments and recorded Jev answers, emitted findings validated against `reviewer-finding.schema.json`; hermetic, macOS-safe, revert-checked.
- AC9: Live check (run with `env -u OPENROUTER_API_KEY`) on 2 merged PRs of this repo: findings, Jev calls, cost, time, and 10 findings hand-labelled true/false positive, journaled honestly and added to `~/notes/jev-in-keryx.md` is NOT done by the agent (operator notes are written by the lead).
- AC10: Docs (cli-reference, orchestrator docs, HELP_GROUPS, commands-by-task), CI green, `keryx health run` passes, import zones respected (redaction only via `src/security/service.ts`).
