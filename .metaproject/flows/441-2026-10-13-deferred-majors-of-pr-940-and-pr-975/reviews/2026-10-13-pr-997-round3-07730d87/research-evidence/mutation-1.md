# Mutation pass

Command: `bun test src/review/ledger.test.ts src/commands/review-slice.test.ts src/commands/review-ledger.test.ts src/flow/verify-exec-files.test.ts` (baseline exit 0, 1708 ms). Run in a scratch copy; the worktree was not written.

Killed 79, survived 12, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| P01 | src/review/ledger.ts:253 | `if (labelled !== undefined) return labelled.result;` → `if (labelled !== undefined && labelled.result !== undefined) return labelled.result;` | killed |
| P02 | src/review/ledger.ts:254 | `return afterMarker(raw) ?? scannedResult(raw);` → `return scannedResult(raw) ?? afterMarker(raw);` | killed |
| P04 | src/review/ledger.ts:254 | `return afterMarker(raw) ?? scannedResult(raw);` → `return scannedResult(raw);` | killed |
| P05 | src/review/ledger.ts:254 | `return afterMarker(raw) ?? scannedResult(raw);` → `return afterMarker(raw);` | killed |
| O01 | src/review/ledger.ts:105 | `depth === 1 && !claimsResult` → `depth >= 1 && !claimsResult` | killed |
| O04 | src/review/ledger.ts:107 | `claimsResult = KEY_COLON.test(raw);` → `claimsResult = true;` | killed |
| O05 | src/review/ledger.ts:102 | `else if (char === "\\") escaped = true;` → `else if (char === "\\") escaped = false;` | killed |
| O06 | src/review/ledger.ts:110 | `{ quoted = true; keyFrom = end + 1; }` → `{ quoted = true; keyFrom = end; }` | killed |
| O08 | src/review/ledger.ts:86 | `const KEY_COLON = /\s*:/y;` → `const KEY_COLON = /:/y;` | survived |
| O09 | src/review/ledger.ts:85 | `const RESULT_KEYS = new Set(["status", "reviewer", "findings"]);` → `const RESULT_KEYS = new Set(["status"]);` | survived |
| O11 | src/review/ledger.ts:85 | `const RESULT_KEYS = new Set(["status", "reviewer", "findings"]);` → `const RESULT_KEYS = new Set(["reviewer", "findings"]);` | survived |
| T01 | src/review/ledger.ts:83 | `const OBJECT_START = /\{\s*["}]/y;` → `const OBJECT_START = /\{/y;` | killed |
| T02 | src/review/ledger.ts:83 | `const OBJECT_START = /\{\s*["}]/y;` → `const OBJECT_START = /\{"/y;` | killed |
| T03 | src/review/ledger.ts:118 | `const MAX_UNCLOSED = 64;` → `const MAX_UNCLOSED = 63;` | killed |
| T04 | src/review/ledger.ts:118 | `const MAX_UNCLOSED = 64;` → `const MAX_UNCLOSED = 65;` | killed |
| T05 | src/review/ledger.ts:118 | `const MAX_UNCLOSED = 64;` → `const MAX_UNCLOSED = 1;` | killed |
| T06 | src/review/ledger.ts:133 | `claimsResult \|\| (unclosed += 1) > MAX_UNCLOSED` → `(unclosed += 1) > MAX_UNCLOSED` | killed |
| T07 | src/review/ledger.ts:133 | `(unclosed += 1) > MAX_UNCLOSED` → `(unclosed += 1) >= MAX_UNCLOSED` | killed |
| T08 | src/review/ledger.ts:133 | `claimsResult \|\| (unclosed += 1) > MAX_UNCLOSED` → `claimsResult` | killed |
| T09 | src/review/ledger.ts:133 | `return { found, truncated: true };` → `return { found, truncated: false };` | killed |
| T10 | src/review/ledger.ts:134 | `      start += 1;       continue;     }     try {` → `      start = raw.length;       continue;     }     try {` | killed |
| T11 | src/review/ledger.ts:138 | `start = end + 1;` → `start += 1;` | killed |
| T12 | src/review/ledger.ts:137 | `catch { /* not JSON: skipped whole */ }` → `catch { start += 1; continue; }` | killed |
| F02 | src/review/ledger.ts:150 | `if (close === -1) break;` → `if (close === -1) { ranges.push([open, raw.length] as const); break; }` | killed |
| F03 | src/review/ledger.ts:152 | `open = raw.indexOf("```", close + 3);` → `open = raw.indexOf("```", close);` | killed |
| F04 | src/review/ledger.ts:162 | `ranges[next]![1] <= position` → `ranges[next]![1] < position` | killed |
| F05 | src/review/ledger.ts:149 | `const close = raw.indexOf("```", lineEnd + 1);` → `const close = raw.indexOf("```", open + 3);` | survived |
| F06 | src/review/ledger.ts:151 | `ranges.push([open, close + 3] as const);` → `ranges.push([open, close] as const);` | survived |
| F07 | src/review/ledger.ts:163 | `position >= ranges[next]![0]` → `position > ranges[next]![0]` | survived |
| S01 | src/review/ledger.ts:225 | `(inFence(start) ? fenced : bare)` → `(inFence(start) ? bare : fenced)` | killed |
| S02 | src/review/ledger.ts:228 | `fencedResults[fencedResults.length - 1]!` → `fencedResults[0]!` | killed |
| S03 | src/review/ledger.ts:226 | `const fencedResults = fenced.filter(isReviewerResult);` → `const fencedResults = fenced.filter(hasStatus);` | killed |
| S04 | src/review/ledger.ts:231 | `new Set(bare.filter(hasStatus).map((value) => value.status)).size > 1` → `new Set(bare.filter(hasStatus).map((value) => value.status)).size > 2` | killed |
| S05 | src/review/ledger.ts:231 | `new Set(bare.filter(hasStatus).map((value) => value.status)).size > 1` → `new Set(bare.filter(isReviewerResult).map((value) => value.status)).size > 1` | killed |
| S07 | src/review/ledger.ts:233 | `return accepted[accepted.length - 1];` → `return accepted[0];` | killed |
| S08 | src/review/ledger.ts:221 | `if (truncated) return undefined;` → `/* mutated: truncation ignored */` | killed |
| B01 | src/review/ledger.ts:229 | `? undefined : last;` → `? last : last;` | killed |
| B02 | src/review/ledger.ts:229 | `value.status !== last.status) ? undefined : last` → `value.status === last.status) ? undefined : last` | killed |
| B03 | src/review/ledger.ts:229 | `bare.filter(isReviewerResult).some(` → `bare.filter(isReviewerResult).every(` | killed |
| B04 | src/review/ledger.ts:229 | `bare.filter(isReviewerResult).some(` → `bare.filter(hasStatus).some(` | killed |
| B05 | src/review/ledger.ts:227 | `if (fencedResults.length > 0) {` → `if (fencedResults.length > 1) {` | killed |
| B06 | src/review/ledger.ts:229 | `value.status !== last.status` → `value.status !== fencedResults[0]!.status` | survived |
| B07 | src/review/ledger.ts:229 | `value.status !== last.status` → `value.reviewer !== last.reviewer` | killed |
| R01 | src/review/ledger.ts:176 | `typeof object.reviewer === "string" \|\| Array.isArray(object.findings)` → `typeof object.reviewer === "string" && Array.isArray(object.findings)` | killed |
| R02 | src/review/ledger.ts:176 | `Array.isArray(object.findings)` → `object.findings !== undefined` | killed |
| R03 | src/review/ledger.ts:176 | `typeof object.reviewer === "string"` → `object.reviewer !== undefined` | killed |
| H01 | src/review/ledger.ts:169 | `typeof (value as { status?: unknown }).status === "string"` → `(value as { status?: unknown }).status !== undefined` | survived |
| L01 | src/review/ledger.ts:183 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/g` | killed |
| L02 | src/review/ledger.ts:183 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT[ \t]*\n([\s\S]*?)```/gi` | killed |
| L03 | src/review/ledger.ts:183 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT\r?\n([\s\S]*?)```/gi` | killed |
| L04 | src/review/ledger.ts:183 | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` → `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*)```/gi` | killed |
| L05 | src/review/ledger.ts:186 | `labelled[labelled.length - 1]![1]!` → `labelled[0]![1]!` | killed |
| L06 | src/review/ledger.ts:187 | `hasStatus(parsed) ? parsed : undefined` → `parsed` | killed |
| L08 | src/review/ledger.ts:188 | `catch { return { result: undefined }; }` → `catch { return undefined; }` | killed |
| A01 | src/review/ledger.ts:195 | `REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` → `REVIEW_RESULT(?:[ \t]*[:])?\s*(?=\{)/g` | killed |
| A02 | src/review/ledger.ts:195 | `REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` → `REVIEW_RESULT(?:[ \t]*[:=])?[ \t]*(?=\{)/g` | killed |
| A03 | src/review/ledger.ts:195 | `REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` → `REVIEW_RESULT(?:[ \t]*[:=])\s*(?=\{)/g` | killed |
| A04 | src/review/ledger.ts:204 | `.slice(-MAX_MARKERS)` → `.slice(0, MAX_MARKERS)` | killed |
| A05 | src/review/ledger.ts:192 | `const MAX_MARKERS = 64;` → `const MAX_MARKERS = 63;` | killed |
| A06 | src/review/ledger.ts:192 | `const MAX_MARKERS = 64;` → `const MAX_MARKERS = 65;` | killed |
| A07 | src/review/ledger.ts:192 | `const MAX_MARKERS = 64;` → `const MAX_MARKERS = 1;` | killed |
| A10 | src/review/ledger.ts:209 | `if (end === undefined) continue;` → `if (end === undefined) return undefined;` | killed |
| A11 | src/review/ledger.ts:212 | `if (isReviewerResult(parsed)) return parsed;` → `if (hasStatus(parsed)) return parsed;` | killed |
| A13 | src/review/ledger.ts:213 | `catch { /* prose after the word: try the marker before */ }` → `catch { return undefined; }` | killed |
| M01 | src/review/ledger.ts:195 | `/(?<![^\n])[ \t>*#-]*REVIEW_RESULT` → `/[ \t>*#-]*REVIEW_RESULT` | killed |
| M02 | src/review/ledger.ts:195 | `/(?<![^\n])[ \t>*#-]*REVIEW_RESULT` → `/(?<!\S)[ \t>*#-]*REVIEW_RESULT` | killed |
| M03 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[ \t*#-]*REVIEW_RESULT` | killed |
| M04 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[ \t>#-]*REVIEW_RESULT` | killed |
| M05 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[ \t>*-]*REVIEW_RESULT` | killed |
| M06 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[ \t>*#]*REVIEW_RESULT` | killed |
| M07 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[\t>*#-]*REVIEW_RESULT` | killed |
| M08 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[ >*#-]*REVIEW_RESULT` | killed |
| M09 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[>*#-]*REVIEW_RESULT` | killed |
| M10 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[ \t>*#-]+REVIEW_RESULT` | killed |
| M11 | src/review/ledger.ts:195 | `[ \t>*#-]*REVIEW_RESULT` → `[^\n]*REVIEW_RESULT` | killed |
| M12 | src/review/ledger.ts:195 | `(?<![^\n])` → `(?<![^\n\r])` | survived |
| N01 | src/review/ledger.ts:204 | `.filter((marker) => !inFence(marker.index!))` → `.filter(() => true)` | killed |
| N02 | src/review/ledger.ts:204 | `.filter((marker) => !inFence(marker.index!))` → `.filter((marker) => inFence(marker.index!))` | killed |
| N03 | src/review/ledger.ts:204 | `.filter((marker) => !inFence(marker.index!)).slice(-MAX_MARKERS)` → `.slice(-MAX_MARKERS).filter((marker) => !inFence(marker.index!))` | survived |
| N04 | src/review/ledger.ts:204 | `!inFence(marker.index!)` → `!inFence(marker.index! + marker[0].length)` | survived |
| N06 | src/review/ledger.ts:205 | `for (let at = markers.length - 1; at >= 0; at -= 1) {` → `for (let at = 0; at < markers.length; at += 1) {` | killed |
| N07 | src/review/ledger.ts:207 | `const start = marker.index! + marker[0].length;` → `const start = marker.index! + marker[0].length - 1;` | killed |
| W01 | src/commands/review-slice.ts:171 | `const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);` → `const parsed = parseReviewResult(raw) ?? wholeFileResult(raw);` | survived |
| W02 | src/commands/review-slice.ts:171 | `const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);` → `const parsed = parseReviewResult(raw);` | killed |
| W03 | src/commands/review-slice.ts:180 | `return hasStatus(whole) ? whole as ReviewerResult : undefined;` → `return whole as ReviewerResult;` | killed |
| W04 | src/commands/review-slice.ts:171 | `const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);` → `const parsed = wholeFileResult(raw);` | killed |
| W06 | src/commands/review-slice.ts:164 | `async function readResult(source: string): Promise<ReviewerResult> {   let raw: string;   try {     raw = source === "-" ?` → `async function readResult(source: string): Promise<ReviewerResult> {   let raw: string;   try {     raw = source === "--" ?` | killed |
| D01 | src/commands/review-ledger.ts:99 | `result !== undefined && !isReviewerResult(result)` → `false` | killed |
| D02 | src/commands/review-ledger.ts:99 | `result !== undefined && !isReviewerResult(result)` → `result !== undefined && result.reviewer === undefined` | killed |
| D03 | src/commands/review-ledger.ts:100 | `ignored.push(`raw/${name}`);       continue;` → `ignored.push(`raw/${name}`);` | killed |
| D05 | src/commands/review-ledger.ts:93 | `result === undefined && !isEmptyOutput(body) && !isReviewerReply(name, body, replies)` → `result === undefined && !isEmptyOutput(body)` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
