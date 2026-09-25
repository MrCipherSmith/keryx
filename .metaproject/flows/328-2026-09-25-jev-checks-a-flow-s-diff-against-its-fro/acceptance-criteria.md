# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx flow check-ac <id> [--diff <ref>|--pr <n>] [--json]` reads the flow's FROZEN acceptance criteria (refuses when not frozen) and the change (default: the flow worktree's diff against its base / merge-base with origin/main), and reports per criterion: `likely-met`, `not-evident`, or `not-checkable`, with the Jev probability and the evidence used; ADVISORY header; never changes flow state or confirms an AC.
- AC2: Deterministic evidence is computed first, per criterion, and placed above the diff in Jev's state: files/symbols/CLI flags/paths the criterion names (backticked tokens, file paths, command names) and whether each appears in the diff or the tree; tests changed or added that mention those tokens; a criterion whose named artefacts are all absent is flagged by the facts alone. Pure core functions, unit-tested.
- AC3: `not-checkable` is assigned without a model when a criterion is about something no diff records (live checks, CI green, health passing, docs published — explicit marker list, documented), and is always listed, never sent to Jev.
- AC4: Jev use: one `noul` per checkable criterion with the redacted relevant hunks (selected by the AC2 tokens, bounded to the 64k budget; a criterion with no matching hunk gets the file list and the fact that nothing matched); secrets redacted via `src/security/service.ts`; opt-in `review.jev.ac_check` in `.metaproject/tasks.config.json`; without Jev configured the command still prints the deterministic evidence and says Jev was not asked.
- AC5: `keryx flow complete` and `keryx flow implemented` print the check-ac summary (counts + criteria not evident) as an advisory notice when the opt-in is on and Jev is reachable; they never block or change the gates because of it; failure of the check is a one-line notice.
- AC6: Review: `keryx review ingest` for a flow with the opt-in attaches the latest check-ac result to the review package (a `ac-check.md` or a section in scope.md) so reviewers see which criteria are in doubt; verified by a test on a fixture package.
- AC7: Shell: the flow sidebar/panel in `keryx shell` (or the existing flow modal) shows per-criterion markers (met / not evident / not checkable / not run) for the active flow, with a key to run the check; `/ac` (or an entry in the existing flow modal) opens a detail view with evidence; English UI text; render tests.
- AC8: Results are cached per flow keyed by (criteria checksum, diff hash) under `.metaproject/data/` (gitignored, 0600) so the shell does not re-ask Jev for an unchanged diff.
- AC9: Live check (run with `env -u OPENROUTER_API_KEY`): check-ac against two already-merged flows of this repo (e.g. 309 against PR #712's diff, 307 against #710's), results journaled with counts, cost and an honest usefulness note (did it flag the criteria a reviewer would doubt?).
- AC10: Docs (cli-reference, flow docs, HELP_GROUPS, commands-by-task), CI green, `keryx health run` passes, hermetic macOS-safe tests, import zones respected.
