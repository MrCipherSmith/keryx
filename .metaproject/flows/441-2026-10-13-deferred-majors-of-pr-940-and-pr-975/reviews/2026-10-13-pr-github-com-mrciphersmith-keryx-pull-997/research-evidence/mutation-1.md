# Mutation pass

Command: `bun test src/review/ledger.test.ts src/commands/review-slice.test.ts src/commands/review.test.ts` (baseline exit 0, 468 ms). Run in a scratch copy; the worktree was not written.

Killed 11, survived 11, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-objectEnd-never-closes-returns-last-index | src/review/ledger.ts:99 | `  return undefined; }  /** The objects that stand` → `  return raw.length - 1; }  /** The objects that stand` | survived |
| M02-objectEnd-ignore-nested-open-brace | src/review/ledger.ts:96 | `else if (char === "{") depth += 1;` → `else if (char === "{") depth += 0;` | killed |
| M03-objectEnd-escape-never-set | src/review/ledger.ts:93 | `else if (char === "\\") escaped = true;` → `else if (char === "\\") escaped = false;` | survived |
| M05-objectEnd-close-at-first-brace | src/review/ledger.ts:97 | `else if (char === "}" && --depth === 0) return end;` → `else if (char === "}") return end;` | killed |
| M06-topLevel-truncated-skips-instead-of-stopping | src/review/ledger.ts:109 | `if (end === undefined) return { found, truncated: true };` → `if (end === undefined) { start += 1; continue; }` | survived |
| M07-topLevel-enter-nested-after-object | src/review/ledger.ts:111 | `    start = end + 1;   }   return { found, truncated: false };` → `    start += 1;   }   return { found, truncated: false };` | survived |
| M08-topLevel-object-start-any-brace | src/review/ledger.ts:82 | `const OBJECT_START = /\{\s*["}]/y;` → `const OBJECT_START = /\{/y;` | survived |
| M09-topLevel-unparseable-enters-inside | src/review/ledger.ts:110 | `catch { /* not JSON: skipped whole */ }` → `catch { start += 1; continue; }` | survived |
| M11-isReviewerResult-reviewer-and-findings | src/review/ledger.ts:119 | `typeof object.reviewer === "string" \|\| Array.isArray(object.findings)` → `typeof object.reviewer === "string" && Array.isArray(object.findings)` | killed |
| M12-isReviewerResult-status-not-required | src/review/ledger.ts:119 | `return typeof object.status === "string" && (typeof object.reviewer` → `return (typeof object.reviewer` | survived |
| M13-parse-marker-picks-first | src/review/ledger.ts:139 | `const marker = markers[markers.length - 1]!;` → `const marker = markers[0]!;` | survived |
| M14-parse-marker-object-unchecked | src/review/ledger.ts:145 | `return isReviewerResult(parsed) ? parsed : undefined;` → `return parsed;` | killed |
| M15-parse-truncation-ignored | src/review/ledger.ts:149 | `if (truncated) return undefined;` → `if (truncated && found.length === 0) return undefined;` | survived |
| M16-parse-fenced-preference-dropped | src/review/ledger.ts:152 | `const pool = fenced.length > 0 ? fenced : found;` → `const pool = found;` | survived |
| M17-parse-ambiguity-also-inside-fences | src/review/ledger.ts:154 | `if (fenced.length === 0 && statuses.size > 1) return undefined;` → `if (statuses.size > 1) return undefined;` | killed |
| M19-parse-last-accepted-becomes-first | src/review/ledger.ts:156 | `accepted[accepted.length - 1]` → `accepted[0]` | killed |
| M20-readResult-wholeFile-bypass-removed | src/commands/review-slice.ts:171 | `const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);` → `const parsed = parseReviewResult(raw);` | killed |
| M21-wholeFileResult-accepts-any-object | src/commands/review-slice.ts:180 | `typeof (whole as { status?: unknown }).status === "string" ? whole as ReviewerResult` → `true ? whole as ReviewerResult` | survived |
| M23-failUnreadable-exit-1 | src/commands/review-slice.ts:187 | `process.exitCode = 2;` → `process.exitCode = 1;` | killed |
| M25-readResult-no-result-returns-empty | src/commands/review-slice.ts:172 | `if (parsed === undefined) throw new UnreadableInput(`result holds no reviewer result (a JSON object with a status and a reviewer or findings): ${source}`);` → `if (parsed === undefined) return {} as ReviewerResult;` | killed |
| M26-scopeFingerprint-uses-manifest-hash-not-content | src/review/retry-plan.ts:71 | `const contentHash = read === undefined ? entry.contentHash : createHash("sha256").update(read(entry)).digest("hex");` → `const contentHash = entry.contentHash;` | killed |
| M27-readSliceText-size-only | src/commands/review-slice.ts:277 | `return readFileSync(file, "utf8");` → `return String(statSync(file).size);` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
