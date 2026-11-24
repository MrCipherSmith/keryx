# Mutation pass

Command: `bun test src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` (baseline exit 0, 35225 ms). Run in a scratch copy; the worktree was not written.

Bail: applied (mutants ran with --bail; baseline in full).

Cost: provenance 486 ms, copy 22944 ms, mutants 660836 ms, load 7.7/12.0/12.3.

started 2026-11-24T11:03:45.196Z, head 5957d12494d3, treeHash ae460bbd3b6d.

Killed 9, survived 10, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| TP3-M1 | src/review/publish.ts:229 | `[...new Set([receiptDir, packageDir])]` → `[receiptDir]` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M2 | src/review/publish.ts:247 | `(after === null \|\| !sameCommit(before, after))` → `(after !== null && !sameCommit(before, after))` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M3 | src/review/publish.ts:244 | `      refuseClosed(now, ref); ` → `` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M4 | src/review/publish.ts:199 | `if (moved !== undefined && event !== "COMMENT")` → `if (false)` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |
| TP3-M5 | src/review/publish.ts:251 | `reviewedHead !== null && FULL_SHA.test(reviewedHead) ? reviewedHead : undefined` → `reviewedHead ?? undefined` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M6 | src/review/publish.ts:255 | `if (result.uncertain === true)` → `if (false)` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |
| TP3-M7 | src/review/publication-guard.ts:38 | `return undefined;     return {};` → `return undefined;     return undefined;` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M8 | src/review/publication-guard.ts:55 | `(receipt.url !== undefined \|\| receipt.posted === true)` → `(receipt.url !== undefined)` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M9 | src/review/session-attempt.ts:84 | `own === storeRoot \|\| own.startsWith('${storeRoot}${path.sep}')` → `false` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |
| TP3-M10 | src/review/session-attempt.ts:99 | `state: complete ? "completed" : "partial",` → `state: "completed",` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M11 | src/review/session-attempt.ts:159 | `  record ??= await readSessionAttempt(packageDir); ` → `` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |
| TP3-M12 | src/review/session-attempt.ts:67 | `if (!FULL_SHA.test(baseSha) \|\| !FULL_SHA.test(headSha)) return` → `if (false) return` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M13 | src/review/review-advance.ts:39 | `if (prState !== "OPEN")` → `if (false)` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |
| TP3-M14 | src/review/review-advance.ts:17 | `run.decision?.action === "delete" \|\| ` → `` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |
| TP3-M15 | src/review/review-advance.ts:30 | `(b.round ?? 0) - (a.round ?? 0) \|\| ` → `` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |
| TP3-M16 | src/review/review-advance.ts:43 | `reviewed.baseSha === current.baseSha && reviewed.headSha === current.headSha` → `reviewed.headSha === current.headSha` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M17 | src/review/review-advance.ts:71 | `args.viewer.toLowerCase() !== key.viewer.toLowerCase()` → `args.viewer !== key.viewer` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |
| TP3-M18 | src/review/session-publish-github.ts:52 | ` && posted.html_url.startsWith("https://github.com/")` → `` | survived | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 0 |
| TP3-M19 | src/review/session-publish-github.ts:74 | `author.toLowerCase() === login` → `true` | killed | `bun test --bail src/review/publish.test.ts src/review/desk-publication.test.ts src/review/review-advance.test.ts src/review/session-publish-github.test.ts` | 1 |

A survivor means no assertion pins that behaviour: the severity audit raises a finding to major only when no mutant in the same file was killed.
