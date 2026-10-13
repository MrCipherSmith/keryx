# Mutation pass

Command: `bun test src/commands/review-revision-operand.test.ts src/lib/trust-routine-command.test.ts src/commands/flow-check-ac.test.ts` (baseline exit 0, 28397 ms). Run in a scratch copy; the worktree was not written.

Killed 38, survived 3, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| B2-c-flag-prefix | src/lib/trust-routine-command.ts:118 | `rest === 2 &&` → `rest >= 2 &&` | killed |
| B3-flag-prefix-match | src/lib/trust-routine-command.ts:119 | `(rest === f.length && word.startsWith(f, at))` → `word.startsWith(f, at)` | killed |
| B12-no-open-brace-char | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^` → `/[\\}$]/.test(word) && /^` | killed |
| B13-no-close-brace-char | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^` → `/[\\{$]/.test(word) && /^` | killed |
| B16-dot-all-dropped | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-./.test(w)` | killed |
| B17-short-flag-prefix | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^-[^=]+=-./s.test(w)` | killed |
| C13-sync-guard | src/sync/diff.ts:78 | `if (base.startsWith("-")) return null;` → `` | survived |
| G1-shell-spelled-off | src/lib/trust-routine-command.ts:110 | ` \|\| words.some(isShellSpelledOption)` → `` | killed |
| G2-shell-spelled-no-dollar-lead | src/lib/trust-routine-command.ts:130 | `/^[\\{$]*-/.test(word)` → `/^[\\{]*-/.test(word)` | killed |
| G3-shell-spelled-no-backslash-lead | src/lib/trust-routine-command.ts:130 | `/^[\\{$]*-/.test(word)` → `/^[{$]*-/.test(word)` | killed |
| G4-shell-spelled-any-dash-word | src/lib/trust-routine-command.ts:130 | `/[\\{}$]/.test(word) && /^` → `true && /^` | killed |
| G5-dashvalue-lone-dash-blocked | src/lib/trust-routine-command.ts:138 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-/s.test(w)` | killed |
| G6-dashvalue-off | src/lib/trust-routine-command.ts:138 | `words.some((w) => /^--[^=]+=-./s.test(w))` → `false` | killed |
| G7-dashvalue-call-dropped | src/lib/trust-routine-command.ts:318 | `args[0] === "review" && hasDashValue(args)` → `false` | killed |
| G8-eq-chain-glued-sep | src/lib/trust-routine-command.ts:119 | `word.startsWith(`${f}=`, at)` → `word.startsWith(`${f}:`, at)` | killed |
| G9-eq-chain-dash-gate-dropped | src/lib/trust-routine-command.ts:121 | `if (!word.startsWith("-", at) \|\| eq === -1) return false;` → `if (eq === -1) return false;` | killed |
| G10-eq-chain-one-level | src/lib/trust-routine-command.ts:122 | `    at = eq + 1;   } }` → `    if (at > 0) return false;     at = eq + 1;   } }` | killed |
| G11-c-flag-off | src/lib/trust-routine-command.ts:118 | `if (rest === 2 && word.startsWith("-c", at)) return true;` → `` | killed |
| R1-assert-off | src/lib/git-revision.ts:7 | `if (ref.startsWith("-")) throw` → `if (false) throw` | killed |
| R2-assert-only-double-dash | src/lib/git-revision.ts:7 | `ref.startsWith("-")) throw` → `ref.startsWith("--")) throw` | killed |
| R3-operand-no-eoo | src/lib/git-revision.ts:23 | `return ["--end-of-options", assertGitRevision(ref)];` → `return [assertGitRevision(ref)];` | killed |
| R4-no-writing-output-eq | src/lib/git-revision.ts:13 | ` \|\| a.startsWith("--output=")` → `` | killed |
| R5-no-writing-output-bare | src/lib/git-revision.ts:13 | `a === "--output" \|\| ` → `` | killed |
| R6-no-writing-ext-diff | src/lib/git-revision.ts:13 | ` \|\| a === "--ext-diff"` → `` | killed |
| S1-ctx-diff-guard-off | src/commands/ctx.ts:203 | `  assertNoWritingDiffOption(args);` → `` | killed |
| S2-flow-base-unchecked | src/commands/flow.ts:401 | `return value === undefined ? undefined : assertGitRevision(value);` → `return value;` | killed |
| S3-checkac-mergebase-bare | src/commands/flow-check-ac.ts:168 | `["git", "merge-base", "HEAD", ...revisionOperand(refName)]` → `["git", "merge-base", "HEAD", refName]` | killed |
| S4-checkac-diff-bare | src/commands/flow-check-ac.ts:171 | `"-U20", ...revisionOperand(ref)]` → `"-U20", ref]` | killed |
| S5-ingest-mergebase-unchecked | src/commands/flow-check-ac.ts:192 | `"--end-of-options", assertGitRevision(head), assertGitRevision(refName)]` → `"--end-of-options", head, refName]` | killed |
| S6-ingest-diff-no-eoo | src/commands/flow-check-ac.ts:195 | `"-U20", "--end-of-options", ref, head]` → `"-U20", ref, head]` | killed |
| S7-health-bare | src/health/run.ts:622 | `["git", "diff", "--name-only", ...revisionOperand(ref)]` → `["git", "diff", "--name-only", ref]` | killed |
| S8-testing-bare | src/testing/service.ts:760 | `["git", "diff", "--name-only", ...revisionOperand(since)]` → `["git", "diff", "--name-only", since]` | killed |
| S9-wiki-freshness-assert-off | src/wiki/freshness/run.ts:117 | `"--end-of-options", assertGitRevision(fromRev), "HEAD"]` → `fromRev, "HEAD"]` | survived |
| S10-wiki-freshness-guard-off | src/wiki/freshness/run.ts:116 | `if (fromRev.startsWith("-")) return [];` → `` | killed |
| S11-wiki-service-eoo-off | src/wiki/service.ts:1623 | `"--name-only", "--end-of-options", base]` → `"--name-only", base]` | killed |
| S12-wiki-service-guard-off | src/wiki/service.ts:1621 | `if (base.startsWith("-")) return Promise.resolve(null);` → `` | survived |
| S13-sync-diff-eoo-off | src/sync/diff.ts:79 | `"--name-status", "--end-of-options", base]` → `"--name-status", base]` | killed |
| S14-review-changedfiles-bare | src/commands/review.ts:3545 | `"--diff-filter=d", ...(ref === undefined ? [] : revisionOperand(ref))]` → `"--diff-filter=d", ...(ref === undefined ? [] : [ref])]` | killed |
| S15-review-gitdiff-bare | src/commands/review.ts:3598 | ``-U${contextLines}`, ...(ref === undefined ? [] : revisionOperand(ref))]` → ``-U${contextLines}`, ...(ref === undefined ? [] : [ref])]` | killed |
| S16-review-mergebase-bare | src/commands/review.ts:3674 | `["merge-base", "HEAD", ...revisionOperand(ref)]` → `["merge-base", "HEAD", ref]` | killed |
| S17-jev-select-bare | src/commands/review-jev-select.ts:121 | ``-U${contextLines}`, ...(ref === undefined ? [] : revisionOperand(ref))]` → ``-U${contextLines}`, ...(ref === undefined ? [] : [ref])]` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
