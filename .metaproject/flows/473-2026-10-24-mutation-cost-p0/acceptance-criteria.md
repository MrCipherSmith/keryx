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

## Criteria

- AC1: `withBail(command)` inserts `--bail` right after `bun test` for `bun test <plain tokens>` and for the same command behind `env` or `NAME=value` prefixes; it returns `undefined` for any other command (`sh script`, `bunx`, `npm test`), for a command with shell metacharacters (quotes, `$`, backtick, `;`, `&`, `|`, redirect, glob, backslash, newline) and for a command that already has `--bail`. [verify: exec `bun test src/review/mutate.test.ts -t "withBail"`]
- AC2: By default `runMutation` judges each mutant with the bail command when `withBail` accepts the command, runs the baseline with the original command unchanged, writes the command actually run into each mutant row, and sets `bail: true` on the record; for a command `withBail` rejects it sets no `bail` and changes nothing. [verify: exec `bun test src/review/mutate.test.ts -t "bail applied"`]
- AC3: Status parity under bail on a real `bun test` fixture: a mutant that turns a test red stays `killed`, a mutant no test notices stays `survived`, a hanging mutant stays `timeout`, and an unparsable mutant stays `invalid`. [verify: exec `bun test src/review/mutate.test.ts -t "bail status parity"`]
- AC4: `runMutation({ bail: false })` and `keryx review mutate --no-bail` run mutants with the original command, and the record has no `bail` field; `--no-bail` is accepted by the flag allowlist and an unknown flag is still refused. [verify: exec `bun test src/review/mutate.test.ts -t "no-bail"`]
- AC5: A new record carries `startedAt` (ISO time), `loadavg` (three numbers), `copyMs` and `mutantsMs` (`mutantsMs` equals the sum of the mutant `ms`), and, inside a git checkout, `head` (commit) and `treeHash`; outside git, `head` and `treeHash` are absent and the pass still succeeds. [verify: exec `bun test src/review/mutate.test.ts -t "provenance"`]
- AC6: `treeHash` is identical for two passes over an unchanged worktree, differs after a tracked file changes, differs after an untracked non-ignored file appears, and ignores gitignored files. [verify: exec `bun test src/review/mutate.test.ts -t "treeHash"`]
- AC7: A record written before this change (no new fields) is still read by `doneMutantIds`, `unjudgedMutants`, `pendingMutants` and rendered by `renderMutationTable` without error, and the table shows no empty provenance or bail line for it. [verify: exec `bun test src/review/mutate.test.ts -t "legacy record"`]
- AC8: The markdown table header of a new record states whether `--bail` was applied, the copy time, the total mutant time and the load average. [verify: exec `bun test src/review/mutate.test.ts -t "renderMutationTable"`]
- AC9: Replay on this tree of at least 30 mutants taken from recorded passes, including at least 3 that survived in the recording and are still survivors on this tree, run by the real command with and without `--bail`: the status of every mutant is the same in both runs, and the summed time of the killed mutants with `--bail` is at most half the time without it. The result, the mutant list, the command, the load average and the date are written to `replay-bail.md` in the flow folder; if the 3 survivors are not found, the file says so and the criterion is not confirmed on a substitute. [verify: judged]
- AC10: The mutation-pass section of both copies of `review-orchestrator/SKILL.detail.md` (bundled and installed) is byte-identical and names `--bail`, `--no-bail` and the new record fields; `docs/docs/cli-reference.md` and `CHANGELOG.md` mention `--no-bail`. [verify: exec `sh -c 'cmp src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md .metaproject/skills/gdskills/review/review-orchestrator/SKILL.detail.md && grep -q -e "--no-bail" src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md && grep -q -e "--no-bail" docs/docs/cli-reference.md && grep -q -e "--no-bail" CHANGELOG.md'`]
- AC11: The type check passes and the six test files that touch `mutate.ts` pass. [verify: exec `sh -c 'bun run typecheck && bun test src/review/mutate.test.ts src/review/mutate-not-reached.test.ts src/review/severity-audit.test.ts src/review/ledger.test.ts src/review/pr-replay.test.ts src/commands/review-ledger.test.ts'`]
- AC12: The change is a draft pull request on MrCipherSmith/keryx that states which checks and which review round were and were not run, with no AI authorship line in the commits or the PR body. [verify: judged]
