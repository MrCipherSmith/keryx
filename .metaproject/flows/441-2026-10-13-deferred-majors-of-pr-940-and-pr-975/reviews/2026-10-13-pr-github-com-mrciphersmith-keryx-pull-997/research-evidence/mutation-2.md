# Mutation pass

Command: `bun test src/review/ledger.test.ts src/commands/review-slice.test.ts src/commands/review.test.ts` (baseline exit 0, 878 ms). Run in a scratch copy; the worktree was not written.

Killed 20, survived 4, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-objectEnd-never-closes-returns-last-index | src/review/ledger.ts:100 | `  return undefined; }  /** The objects that stand` → `  return raw.length - 1; }  /** The objects that stand` | survived |
| M02-objectEnd-ignore-nested-open-brace | src/review/ledger.ts:97 | `else if (char === "{") depth += 1;` → `else if (char === "{") depth += 0;` | killed |
| M03-objectEnd-escape-never-set | src/review/ledger.ts:94 | `else if (char === "\\") escaped = true;` → `else if (char === "\\") escaped = false;` | survived |
| M05-objectEnd-close-at-first-brace | src/review/ledger.ts:98 | `else if (char === "}" && --depth === 0) return end;` → `else if (char === "}") return end;` | killed |
| M06-topLevel-truncated-skips-instead-of-stopping | src/review/ledger.ts:110 | `if (end === undefined) return { found, truncated: true };` → `if (end === undefined) { start += 1; continue; }` | killed |
| M07-topLevel-enter-nested-after-object | src/review/ledger.ts:112 | `    start = end + 1;   }   return { found, truncated: false };` → `    start += 1;   }   return { found, truncated: false };` | killed |
| M08-topLevel-object-start-any-brace | src/review/ledger.ts:83 | `const OBJECT_START = /\{\s*["}]/y;` → `const OBJECT_START = /\{/y;` | killed |
| M09-topLevel-unparseable-enters-inside | src/review/ledger.ts:111 | `catch { /* not JSON: skipped whole */ }` → `catch { start += 1; continue; }` | killed |
| M11-isReviewerResult-reviewer-and-findings | src/review/ledger.ts:140 | `typeof object.reviewer === "string" \|\| Array.isArray(object.findings)` → `typeof object.reviewer === "string" && Array.isArray(object.findings)` | killed |
| M12-isReviewerResult-status-not-required | src/review/ledger.ts:138 | `if (!hasStatus(value)) return false;` → `if (value === null \|\| typeof value !== "object") return false;` | killed |
| M13-marker-picks-first | src/review/ledger.ts:159 | `const marker = markers[markers.length - 1]!;` → `const marker = markers[0]!;` | killed |
| M14-marker-object-unchecked | src/review/ledger.ts:165 | `return { result: isReviewerResult(parsed) ? parsed : undefined };` → `return { result: parsed };` | killed |
| M15-scan-truncation-ignored | src/review/ledger.ts:172 | `if (truncated) return undefined;` → `if (truncated && found.length === 0) return undefined;` | survived |
| M16-scan-fenced-preference-dropped | src/review/ledger.ts:183 | `if (fencedResults.length > 0) return fencedResults[fencedResults.length - 1];` → `if (false as boolean) return undefined;` | killed |
| M17-scan-ambiguity-also-counts-fenced | src/review/ledger.ts:184 | `new Set(bare.filter(hasStatus)` → `new Set([...fenced, ...bare].filter(hasStatus)` | killed |
| M19-scan-last-accepted-becomes-first | src/review/ledger.ts:186 | `return accepted[accepted.length - 1];` → `return accepted[0];` | killed |
| M30-fence-pointer-ignores-range-start | src/review/ledger.ts:177 | `return next < ranges.length && start >= ranges[next]![0];` → `return next < ranges.length;` | survived |
| M31-labelled-fence-status-not-required | src/review/ledger.ts:151 | `return { result: hasStatus(parsed) ? parsed : undefined };` → `return { result: parsed };` | killed |
| M20-readResult-wholeFile-bypass-removed | src/commands/review-slice.ts:171 | `const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);` → `const parsed = parseReviewResult(raw);` | killed |
| M21-wholeFileResult-accepts-any-object | src/commands/review-slice.ts:180 | `return hasStatus(whole) ? whole as ReviewerResult : undefined;` → `return whole as ReviewerResult;` | killed |
| M23-failUnreadable-exit-1 | src/commands/review-slice.ts:187 | `process.exitCode = 2;` → `process.exitCode = 1;` | killed |
| M25-readResult-no-result-returns-empty | src/commands/review-slice.ts:172 | `if (parsed === undefined) throw new UnreadableInput(`result holds no usable reviewer result` → `if (parsed === undefined) return {} as ReviewerResult; if (false as boolean) throw new UnreadableInput(`result holds no usable reviewer result` | killed |
| M26-scopeFingerprint-uses-manifest-hash-not-content | src/review/retry-plan.ts:71 | `const contentHash = read === undefined ? entry.contentHash : createHash("sha256").update(read(entry)).digest("hex");` → `const contentHash = entry.contentHash;` | killed |
| M27-readSliceText-size-only | src/commands/review-slice.ts:277 | `return readFileSync(file, "utf8");` → `return String(statSync(file).size);` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
