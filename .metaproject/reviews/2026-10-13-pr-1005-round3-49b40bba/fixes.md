# PR 1005 — round 3 fixes

Round 3 is final: the fixes are verified by mutation, not re-reviewed.

| Finding | Severity (ledger) | Status | What changed |
|---|---|---|---|
| R3-01 | major | fixed | `hasUnquotedExpansion` (`src/lib/shell-syntax.ts`) also refuses an unquoted `*`, `?`, `[` and a word-initial `~`; quoted spellings and a mid-word `~` (`HEAD~1`) stay routine. Tests: git read row and keryx `ctx diff` / `review slice` rows, unquoted refused and quoted routine; a planted `--output=injected` file is not written for `git log --o*`. One existing row (`--pre-glob *.gz`) now quotes its glob. |
| R3-02 | minor (audit) | fixed | `readProvenance` tests for a leading dash, a leading option, a trailing non-hex character, a trailing newline, an embedded space and a too-short value (all read as absent). |
| R3-03 | minor | accepted | No code change. The fail-closed gate asks for approval for unquoted braces, backslashes and globs; quote such arguments to stay auto-approved. Noted in the PR body. |
| R3-04 | info | fixed | The `revisionOperand` comment now names the call sites. `commitsAheadOfMain` routes its range through `revisionOperand`; a main branch spelled `--branches=x` (a valid rev-list option that prints 0) now gives `undefined`. The per-call-site scan lowers `lib/git-worktrees.ts` from 2 sites to 1. |

## Mutation (verified by running the focused tests against each mutant)

| Mutant | Result |
|---|---|
| M1 `*` dropped from the refused set | killed |
| M2 `?` dropped | killed |
| M3 `[` dropped | killed |
| M4 word-initial `~` check removed | killed |
| M5 `~` refused anywhere in a word | killed |
| M6 `~` refused only at the start of the command | killed |
| N22 commit regex end anchor dropped | killed |
| N23 commit regex start anchor dropped | killed |
| N24 commit regex minimum length 4 lowered to 1 | killed |
| W1 `revisionOperand` removed from `commitsAheadOfMain` | survived the first test set (git rejects `-n1..HEAD` and `--output=x..HEAD` anyway); killed after adding the `--branches=x` case |

No surviving non-equivalent mutant.
