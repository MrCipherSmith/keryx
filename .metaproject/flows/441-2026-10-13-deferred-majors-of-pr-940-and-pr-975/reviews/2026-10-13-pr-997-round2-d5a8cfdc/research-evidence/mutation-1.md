# Mutation pass

Command: `bun test src/review/ledger.test.ts src/commands/review-slice.test.ts src/commands/review-ledger.test.ts src/flow/verify-exec-files.test.ts` (baseline exit 0, 740 ms). Run in a scratch copy; the worktree was not written.

Killed 24, survived 33, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| P01 | src/review/ledger.ts:236 | `if (labelled !== undefined) return labelled.result;` → `if (labelled !== undefined && labelled.result !== undefined) return labelled.result;` | survived |
| P02 | src/review/ledger.ts:237 | `return afterMarker(raw) ?? scannedResult(raw);` → `return scannedResult(raw) ?? afterMarker(raw);` | survived |
| P04 | src/review/ledger.ts:237 | `return afterMarker(raw) ?? scannedResult(raw);` → `return scannedResult(raw);` | killed |
| O01 | src/review/ledger.ts:105 | `depth === 1 && !claimsResult` → `depth >= 1 && !claimsResult` | killed |
| O04 | src/review/ledger.ts:107 | `claimsResult = KEY_COLON.test(raw);` → `claimsResult = true;` | killed |
| O05 | src/review/ledger.ts:102 | `else if (char === "\\") escaped = true;` → `else if (char === "\\") escaped = false;` | killed |
| O06 | src/review/ledger.ts:110 | `{ quoted = true; keyFrom = end + 1; }` → `{ quoted = true; keyFrom = end; }` | killed |
| O08 | src/review/ledger.ts:86 | `const KEY_COLON = /\s*:/y;` → `const KEY_COLON = /:/y;` | survived |
| O09 | src/review/ledger.ts:85 | `const RESULT_KEYS = new Set(["status", "reviewer", "findings"]);` → `const RESULT_KEYS = new Set(["status"]);` | survived |
| O11 | src/review/ledger.ts:85 | `const RESULT_KEYS = new Set(["status", "reviewer", "findings"]);` → `const RESULT_KEYS = new Set(["reviewer", "findings"]);` | survived |
| T01 | src/review/ledger.ts:83 | `const OBJECT_START = /\{\s*["}]/y;` → `const OBJECT_START = /\{/y;` | survived |
| T02 | src/review/ledger.ts:83 | `const OBJECT_START = /\{\s*["}]/y;` → `const OBJECT_START = /\{"/y;` | survived |
| T03 | src/review/ledger.ts:118 | `const MAX_UNCLOSED = 8;` → `const MAX_UNCLOSED = 7;` | survived |
| T04 | src/review/ledger.ts:118 | `const MAX_UNCLOSED = 8;` → `const MAX_UNCLOSED = 9;` | survived |
| T05 | src/review/ledger.ts:118 | `const MAX_UNCLOSED = 8;` → `const MAX_UNCLOSED = 1;` | survived |
| T06 | src/review/ledger.ts:133 | `claimsResult \|\| (unclosed += 1) > MAX_UNCLOSED` → `(unclosed += 1) > MAX_UNCLOSED` | killed |
| T09 | src/review/ledger.ts:133 | `return { found, truncated: true };` → `return { found, truncated: false };` | killed |
| T10 | src/review/ledger.ts:134 | `      start += 1;       continue;     }     try {` → `      start = raw.length;       continue;     }     try {` | killed |
| T11 | src/review/ledger.ts:138 | `start = end + 1;` → `start += 1;` | killed |
| T12 | src/review/ledger.ts:137 | `catch { /* not JSON: skipped whole */ }` → `catch { start += 1; continue; }` | killed |
| F02 | src/review/ledger.ts:150 | `if (close === -1) break;` → `if (close === -1) { ranges.push([open, raw.length] as const); break; }` | survived |
| F03 | src/review/ledger.ts:152 | `open = raw.indexOf("```", close + 3);` → `open = raw.indexOf("```", close);` | survived |
| F04 | src/review/ledger.ts:210 | `ranges[next]![1] <= start` → `ranges[next]![1] < start` | survived |
| S01 | src/review/ledger.ts:215 | `(inFence(start) ? fenced : bare)` → `(inFence(start) ? bare : fenced)` | killed |
| S02 | src/review/ledger.ts:217 | `return fencedResults[fencedResults.length - 1];` → `return fencedResults[0];` | killed |
| S03 | src/review/ledger.ts:216 | `const fencedResults = fenced.filter(isReviewerResult);` → `const fencedResults = fenced.filter(hasStatus);` | killed |
| S04 | src/review/ledger.ts:218 | `new Set(bare.filter(hasStatus).map((value) => value.status)).size > 1` → `new Set(bare.filter(hasStatus).map((value) => value.status)).size > 2` | killed |
| S07 | src/review/ledger.ts:220 | `return accepted[accepted.length - 1];` → `return accepted[0];` | killed |
| S08 | src/review/ledger.ts:206 | `if (truncated) return undefined;` → `/* mutated: truncation ignored */` | killed |
| R01 | src/review/ledger.ts:166 | `typeof object.reviewer === "string" \|\| Array.isArray(object.findings)` → `typeof object.reviewer === "string" && Array.isArray(object.findings)` | killed |
| R02 | src/review/ledger.ts:166 | `Array.isArray(object.findings)` → `object.findings !== undefined` | killed |
| R03 | src/review/ledger.ts:166 | `typeof object.reviewer === "string"` → `object.reviewer !== undefined` | survived |
| H01 | src/review/ledger.ts:159 | `typeof (value as { status?: unknown }).status === "string"` → `(value as { status?: unknown }).status !== undefined` | survived |
| L01 | src/review/ledger.ts:173 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/g` | survived |
| L02 | src/review/ledger.ts:173 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT[ \t]*\n([\s\S]*?)```/gi` | survived |
| L03 | src/review/ledger.ts:173 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT\r?\n([\s\S]*?)```/gi` | survived |
| L04 | src/review/ledger.ts:173 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*)```/gi` | survived |
| L05 | src/review/ledger.ts:176 | `labelled[labelled.length - 1]![1]!` → `labelled[0]![1]!` | survived |
| L06 | src/review/ledger.ts:177 | `hasStatus(parsed) ? parsed : undefined` → `parsed` | killed |
| L08 | src/review/ledger.ts:178 | `catch { return { result: undefined }; }` → `catch { return undefined; }` | survived |
| A01 | src/review/ledger.ts:189 | `/REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` → `/REVIEW_RESULT(?:[ \t]*[:])?\s*(?=\{)/g` | survived |
| A02 | src/review/ledger.ts:189 | `/REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` → `/REVIEW_RESULT(?:[ \t]*[:=])?[ \t]*(?=\{)/g` | survived |
| A03 | src/review/ledger.ts:189 | `/REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` → `/REVIEW_RESULT(?:[ \t]*[:=])\s*(?=\{)/g` | survived |
| A04 | src/review/ledger.ts:189 | `.slice(-MAX_MARKERS)` → `.slice(0, MAX_MARKERS)` | survived |
| A05 | src/review/ledger.ts:182 | `const MAX_MARKERS = 8;` → `const MAX_MARKERS = 7;` | survived |
| A06 | src/review/ledger.ts:182 | `const MAX_MARKERS = 8;` → `const MAX_MARKERS = 9;` | survived |
| A07 | src/review/ledger.ts:182 | `const MAX_MARKERS = 8;` → `const MAX_MARKERS = 1;` | killed |
| A10 | src/review/ledger.ts:194 | `if (end === undefined) continue;` → `if (end === undefined) return undefined;` | survived |
| A11 | src/review/ledger.ts:197 | `if (isReviewerResult(parsed)) return parsed;` → `if (hasStatus(parsed)) return parsed;` | killed |
| A13 | src/review/ledger.ts:198 | `catch { /* prose after the word: try the marker before */ }` → `catch { return undefined; }` | survived |
| W01 | src/commands/review-slice.ts:171 | `const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);` → `const parsed = parseReviewResult(raw) ?? wholeFileResult(raw);` | survived |
| W02 | src/commands/review-slice.ts:171 | `const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);` → `const parsed = parseReviewResult(raw);` | killed |
| W06 | src/commands/review-slice.ts:164 | `async function readResult(source: string): Promise<ReviewerResult> {   let raw: string;   try {     raw = source === "-" ?` → `async function readResult(source: string): Promise<ReviewerResult> {   let raw: string;   try {     raw = source === "--" ?` | survived |
| D01 | src/commands/review-ledger.ts:99 | `result.reviewer === undefined && !Array.isArray(result.findings)` → `false` | survived |
| D02 | src/commands/review-ledger.ts:99 | `result.reviewer === undefined && !Array.isArray(result.findings)` → `result.reviewer === undefined \|\| !Array.isArray(result.findings)` | killed |
| D03 | src/commands/review-ledger.ts:100 | `ignored.push(`raw/${name}`);       continue;` → `ignored.push(`raw/${name}`);` | survived |
| X02 | src/review/retry-plan.ts:71 | `read === undefined ? entry.contentHash : createHash("sha256").update(read(entry)).digest("hex")` → `entry.contentHash` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
