# Mutation pass

Command: `bun test src/commands/review-revision-operand.test.ts src/lib/trust-routine-command.test.ts src/commands/flow-check-ac.test.ts` (baseline exit 0, 12393 ms). Run in a scratch copy; the worktree was not written.

Killed 33, survived 7, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| A1-no-dash-check | src/lib/git-revision.ts:7 | `if (ref.startsWith("-")) throw` → `if (false) throw` | killed |
| A2-double-dash-only | src/lib/git-revision.ts:7 | `ref.startsWith("-")` → `ref.startsWith("--")` | killed |
| A3-output-bare-dropped | src/lib/git-revision.ts:13 | `a === "--output" \|\| ` → `` | killed |
| A4-output-eq-dropped | src/lib/git-revision.ts:13 | `a.startsWith("--output=") \|\| ` → `` | killed |
| A5-ext-diff-dropped | src/lib/git-revision.ts:13 | ` \|\| a === "--ext-diff"` → `` | killed |
| A6-no-end-of-options | src/lib/git-revision.ts:23 | `["--end-of-options", assertGitRevision(ref)]` → `[assertGitRevision(ref)]` | killed |
| A7-order-swapped | src/lib/git-revision.ts:23 | `["--end-of-options", assertGitRevision(ref)]` → `[assertGitRevision(ref), "--end-of-options"]` | killed |
| A8-no-assert | src/lib/git-revision.ts:23 | `["--end-of-options", assertGitRevision(ref)]` → `["--end-of-options", ref]` | killed |
| B1-c-flag-dropped | src/lib/trust-routine-command.ts:118 | `if (rest === 2 && word.startsWith("-c", at)) return true;` → `if (false) return true;` | killed |
| B2-c-flag-prefix | src/lib/trust-routine-command.ts:118 | `rest === 2 &&` → `rest >= 2 &&` | survived |
| B3-flag-prefix-match | src/lib/trust-routine-command.ts:119 | `(rest === f.length && word.startsWith(f, at))` → `word.startsWith(f, at)` | survived |
| B4-flag-eq-dropped | src/lib/trust-routine-command.ts:119 | ` \|\| word.startsWith(`${f}=`, at)` → `` | killed |
| B5-nondash-walks | src/lib/trust-routine-command.ts:121 | `if (!word.startsWith("-", at) \|\| eq === -1) return false;` → `if (eq === -1) return false;` | killed |
| B6-shell-spelled-dropped | src/lib/trust-routine-command.ts:110 | `words.some(isExecWord) \|\| words.some(isShellSpelledOption)` → `words.some(isExecWord)` | killed |
| B7-shell-spelled-too-broad | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^[\\{$]*-/.test(word)` → `/[\\{}$]/.test(word)` | killed |
| B8-shell-spelled-any-dash | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^[\\{$]*-/.test(word)` → `/^[\\{$]*-/.test(word)` | killed |
| B9-no-dollar | src/lib/trust-routine-command.ts:130 | `/^[\\{$]*-/.test(word)` → `/^[\\{]*-/.test(word)` | killed |
| B10-no-brace | src/lib/trust-routine-command.ts:130 | `/^[\\{$]*-/.test(word)` → `/^[\\$]*-/.test(word)` | killed |
| B11-no-backslash | src/lib/trust-routine-command.ts:130 | `/^[\\{$]*-/.test(word)` → `/^[{$]*-/.test(word)` | killed |
| B12-no-brace-char | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^` → `/[\\}$]/.test(word) && /^` | survived |
| B13-no-close-brace-char | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^` → `/[\\{$]/.test(word) && /^` | survived |
| B14-lone-dash-refused | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-/.test(w)` | killed |
| B15-single-dash-value-routine | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=--/s.test(w)` | killed |
| B16-dot-all-dropped | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-./.test(w)` | survived |
| B17-short-flag-prefix | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^-[^=]+=-./s.test(w)` | survived |
| B18-dash-value-dropped | src/lib/trust-routine-command.ts:138 | `words.some((w) => /^--[^=]+=-./s.test(w))` → `false` | killed |
| C1-ctx-guard-dropped | src/commands/ctx.ts:203 | `  assertNoWritingDiffOption(args); ` → `` | killed |
| C2-check-ac-merge-base | src/commands/flow-check-ac.ts:168 | `"merge-base", "HEAD", ...revisionOperand(refName)]` → `"merge-base", "HEAD", refName]` | killed |
| C3-check-ac-diff | src/commands/flow-check-ac.ts:171 | `"-U20", ...revisionOperand(ref)]` → `"-U20", ref]` | killed |
| C4-ingest-merge-base | src/commands/flow-check-ac.ts:192 | `assertGitRevision(head), assertGitRevision(refName)]` → `head, refName]` | killed |
| C5-ingest-diff | src/commands/flow-check-ac.ts:195 | `"-U20", "--end-of-options", ref, head]` → `"-U20", ref, head]` | killed |
| C6-review-names | src/commands/review.ts:3545 | `"--diff-filter=d", ...(ref === undefined ? [] : revisionOperand(ref))]` → `"--diff-filter=d", ...(ref === undefined ? [] : [ref])]` | killed |
| C7-review-diff | src/commands/review.ts:3598 | ``-U${contextLines}`, ...(ref === undefined ? [] : revisionOperand(ref))]` → ``-U${contextLines}`, ...(ref === undefined ? [] : [ref])]` | killed |
| C8-review-merge-base | src/commands/review.ts:3674 | `["merge-base", "HEAD", ...revisionOperand(ref)]` → `["merge-base", "HEAD", ref]` | killed |
| C9-health | src/health/run.ts:622 | `"--name-only", ...revisionOperand(ref)]` → `"--name-only", ref]` | killed |
| C10-testing | src/testing/service.ts:760 | `"--name-only", ...revisionOperand(since)]` → `"--name-only", since]` | killed |
| C11-flow-base | src/commands/flow.ts:401 | `value === undefined ? undefined : assertGitRevision(value)` → `value` | killed |
| C12-wiki-freshness-guard | src/wiki/freshness/run.ts:116 | `if (fromRev.startsWith("-")) return [];` → `` | killed |
| C13-sync-guard | src/sync/diff.ts:78 | `if (base.startsWith("-")) return null;` → `` | survived |
| C14-sync-eoo | src/sync/diff.ts:79 | `"--name-status", "--end-of-options", base]` → `"--name-status", base]` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
