# Mutation pass

Command: `bun test src/lib/trust-routine-command.test.ts src/lib/shell-syntax.test.ts src/commands/review-revision-operand.test.ts src/gdgraph/staleness.test.ts src/sync` (baseline exit 0, 11107 ms). Run in a scratch copy; the worktree was not written.

Killed 47, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| B2-c-flag-prefix | src/lib/trust-routine-command.ts:120 | `rest === 2 &&` → `rest >= 2 &&` | killed |
| B3-flag-prefix-match | src/lib/trust-routine-command.ts:121 | `rest === f.length && word.startsWith(f, at)` → `word.startsWith(f, at)` | killed |
| B16-dot-all-dropped | src/lib/trust-routine-command.ts:134 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-./.test(w)` | killed |
| B17-short-flag-prefix | src/lib/trust-routine-command.ts:134 | `/^--[^=]+=-./s.test(w)` → `/^-[^=]+=-./s.test(w)` | killed |
| G5-dashvalue-lone-dash-blocked | src/lib/trust-routine-command.ts:134 | `/^--[^=]+=-./s.test(w)` → `/^--[^=]+=-/s.test(w)` | killed |
| G6-dashvalue-off | src/lib/trust-routine-command.ts:134 | `words.some((w) => /^--[^=]+=-./s.test(w))` → `false` | killed |
| G7-dashvalue-call-dropped | src/lib/trust-routine-command.ts:314 | `args[0] === "review" && hasDashValue(args)` → `false` | killed |
| G8-prefix-glued-sep | src/lib/trust-routine-command.ts:107 | `EXEC_FLAGS.map((f) => `${f}=`)` → `EXEC_FLAGS.map((f) => `${f}:`)` | killed |
| G8b-prefix-check-dropped | src/lib/trust-routine-command.ts:122 | `    if (EXEC_FLAG_PREFIXES.some((prefix) => word.startsWith(prefix, at))) return true; ` → `` | killed |
| G9-eq-chain-dash-gate-dropped | src/lib/trust-routine-command.ts:124 | `if (!word.startsWith("-", at) \|\| eq === -1) return false;` → `if (eq === -1) return false;` | killed |
| G10-eq-chain-one-level | src/lib/trust-routine-command.ts:125 | `    at = eq + 1;   } }` → `    if (at > 0) return false;     at = eq + 1;   } }` | killed |
| G11-c-flag-off | src/lib/trust-routine-command.ts:120 | `if (rest === 2 && word.startsWith("-c", at)) return true;` → `` | killed |
| N1-expansion-gate-dropped | src/lib/trust-routine-command.ts:354 | `      !(isJudgedByWords(seg.words) && hasUnquotedExpansion(seg.raw)) && ` → `` | killed |
| N2-gate-git-only | src/lib/trust-routine-command.ts:362 | ` \|\| words[0] === "keryx"` → `` | killed |
| N3-gate-keryx-only | src/lib/trust-routine-command.ts:362 | `words[0] === "git" \|\| ` → `` | killed |
| N4-no-dollar | src/lib/shell-syntax.ts:125 | ` \|\| ch === "$" \|\| ch === "{"` → ` \|\| ch === "{"` | killed |
| N5-no-open-brace | src/lib/shell-syntax.ts:125 | ` \|\| ch === "{" \|\| ch === "}") return true` → ` \|\| ch === "}") return true` | killed |
| N6-no-close-brace | src/lib/shell-syntax.ts:125 | ` \|\| ch === "}") return true;` → `) return true;` | killed |
| N7-no-backslash | src/lib/shell-syntax.ts:125 | `else if (ch === "\\" \|\| ch === "$"` → `else if (ch === "$"` | killed |
| N8-unbalanced-open | src/lib/shell-syntax.ts:127 | `  return quote !== undefined; }  /**  * Split` → `  return false; }  /**  * Split` | survived |
| N9-splitwords-dq-backslash | src/lib/shell-syntax.ts:219 | `if (quote === '"' && ch === "\\" && next !== undefined) {         buf += ch + next;` → `if (false) {         buf += ch + next;` | killed |
| P1-provenance-hex-off | src/sync/provenance.ts:243 | ` && /^[0-9a-f]{4,64}$/i.test(commit)` → `` | killed |
| P2-staleness-bare | src/gdgraph/staleness.ts:243 | `...revisionOperand(fromCommit), toCommit` → `fromCommit, toCommit` | killed |
| P3-staleness-catch-rethrows | src/gdgraph/staleness.ts:245 | `    // A provenance commit that reads as an option is refused by revisionOperand; this check never throws.     return [];` → `    throw new Error('x');` | survived |
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
| S5-ingest-mergebase-head-bare | src/commands/flow-check-ac.ts:192 | `...revisionOperand(head), assertGitRevision(refName)]` → `head, assertGitRevision(refName)]` | killed |
| S5b-ingest-mergebase-ref-unchecked | src/commands/flow-check-ac.ts:192 | `...revisionOperand(head), assertGitRevision(refName)]` → `...revisionOperand(head), refName]` | killed |
| S6-ingest-diff-bare | src/commands/flow-check-ac.ts:195 | `...revisionOperand(ref), assertGitRevision(head)]` → `ref, head]` | killed |
| S7-health-bare | src/health/run.ts:622 | `["git", "diff", "--name-only", ...revisionOperand(ref)]` → `["git", "diff", "--name-only", ref]` | killed |
| S8-testing-bare | src/testing/service.ts:760 | `["git", "diff", "--name-only", ...revisionOperand(since)]` → `["git", "diff", "--name-only", since]` | killed |
| S9-wiki-freshness-bare | src/wiki/freshness/run.ts:116 | `...revisionOperand(fromRev), "HEAD"]` → `fromRev, "HEAD"]` | killed |
| S10-wiki-freshness-early-return-back | src/wiki/freshness/run.ts:116 | `  const status = await git(cwd, ["diff", "--name-status", "-M"` → `  if (fromRev.startsWith("-")) return [];   const status = await git(cwd, ["diff", "--name-status", "-M"` | killed |
| S11-wiki-service-bare | src/wiki/service.ts:1624 | `"--name-only", ...revisionOperand(base)]` → `"--name-only", base]` | killed |
| S12-wiki-service-guard-off | src/wiki/service.ts:1622 | `if (base.startsWith("-")) return Promise.resolve(null);` → `` | killed |
| S13-sync-diff-bare | src/sync/diff.ts:80 | `"--name-status", ...revisionOperand(base)]` → `"--name-status", base]` | killed |
| S14-review-changedfiles-bare | src/commands/review.ts:3545 | `"--diff-filter=d", ...(ref === undefined ? [] : revisionOperand(ref))]` → `"--diff-filter=d", ...(ref === undefined ? [] : [ref])]` | killed |
| S15-review-gitdiff-bare | src/commands/review.ts:3598 | ``-U${contextLines}`, ...(ref === undefined ? [] : revisionOperand(ref))]` → ``-U${contextLines}`, ...(ref === undefined ? [] : [ref])]` | killed |
| S16-review-mergebase-bare | src/commands/review.ts:3674 | `["merge-base", "HEAD", ...revisionOperand(ref)]` → `["merge-base", "HEAD", ref]` | killed |
| S17-jev-select-bare | src/commands/review-jev-select.ts:121 | ``-U${contextLines}`, ...(ref === undefined ? [] : revisionOperand(ref))]` → ``-U${contextLines}`, ...(ref === undefined ? [] : [ref])]` | killed |
| V1-scan-verb-worktree-dropped | src/commands/review-revision-operand.test.ts:187 | `  "worktree", "checkout",` → `  "checkout",` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
