# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/commands/review-revision-operand.test.ts` (baseline exit 0, 17309 ms). Run in a scratch copy; the worktree was not written.

Killed 5, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| B2-c-flag-prefix | src/lib/trust-routine-command.ts:118 | `rest === 2 &&` → `rest >= 2 &&` | killed |
| B3-flag-prefix-match | src/lib/trust-routine-command.ts:119 | `(rest === f.length && word.startsWith(f, at))` → `word.startsWith(f, at)` | killed |
| B12-no-brace-char | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^` → `/[\\}$]/.test(word) && /^` | killed |
| B13-no-close-brace-char | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^` → `/[\\{$]/.test(word) && /^` | killed |
| B16-dot-all-dropped | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-./.test(w)` | killed |
| B17-short-flag-prefix | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^-[^=]+=-./s.test(w)` | survived |
| C13-sync-guard | src/sync/diff.ts:78 | `if (base.startsWith("-")) return null;` → `` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
