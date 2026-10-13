# Mutation pass

Command: `bun test src/review/ledger.test.ts src/commands/review-slice.test.ts` (baseline exit 0, 623 ms). Run in a scratch copy; the worktree was not written.

Killed 7, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| N01-claimsResult-never | src/review/ledger.ts:107 | `claimsResult = KEY_COLON.test(raw);` → `claimsResult = false;` | killed |
| N02-key-at-any-depth | src/review/ledger.ts:105 | `if (depth === 1 && !claimsResult` → `if (depth >= 1 && !claimsResult` | killed |
| N03-unclosed-cap-removed | src/review/ledger.ts:133 | `(unclosed += 1) > MAX_UNCLOSED` → `false` | killed |
| N04-claims-ignored-in-scan | src/review/ledger.ts:133 | `if (claimsResult \|\| (unclosed` → `if ((unclosed` | killed |
| N05-marker-falls-no-further | src/review/ledger.ts:194 | `    if (end === undefined) continue;     try {` → `    if (end === undefined) return undefined;     try {` | survived |
| N06-marker-first-not-last | src/review/ledger.ts:190 | `for (let at = markers.length - 1; at >= 0; at -= 1) {` → `for (let at = 0; at < markers.length; at += 1) {` | killed |
| N07-marker-unchecked-shape | src/review/ledger.ts:197 | `if (isReviewerResult(parsed)) return parsed;` → `return parsed as ParsedResult;` | killed |
| N08-label-regex-quadratic | src/review/ledger.ts:173 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT\s*\n([\s\S]*?)```/gi` | killed |
| N09-key-colon-not-required | src/review/ledger.ts:107 | `claimsResult = KEY_COLON.test(raw);` → `claimsResult = true;` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
