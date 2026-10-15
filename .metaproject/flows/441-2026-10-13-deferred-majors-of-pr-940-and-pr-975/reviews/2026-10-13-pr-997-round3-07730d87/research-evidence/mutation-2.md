# Mutation pass

Command: `bun test src/review/ledger.test.ts` (baseline exit 0, 456 ms). Run in a scratch copy; the worktree was not written.

Killed 17, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| O08 | src/review/ledger.ts:86 | `const KEY_COLON = /\s*:/y;` → `const KEY_COLON = /:/y;` | killed |
| O09 | src/review/ledger.ts:85 | `const RESULT_KEYS = new Set(["status", "reviewer", "findings"]);` → `const RESULT_KEYS = new Set(["status"]);` | killed |
| O11 | src/review/ledger.ts:85 | `const RESULT_KEYS = new Set(["status", "reviewer", "findings"]);` → `const RESULT_KEYS = new Set(["reviewer", "findings"]);` | killed |
| B06 | src/review/ledger.ts:265 | `value.status !== last.status` → `value.status !== fencedResults[0]!.status` | killed |
| H01 | src/review/ledger.ts:191 | `typeof (value as { status?: unknown }).status === "string"` → `(value as { status?: unknown }).status !== undefined` | killed |
| N03 | src/review/ledger.ts:242 | `.filter((marker) => !inFence(marker.index!)).slice(-MAX_MARKERS)` → `.slice(-MAX_MARKERS).filter((marker) => !inFence(marker.index!))` | killed |
| R01 | src/review/ledger.ts:147 | `const FENCE_OPEN = /^ {0,3}(`{3,})[^`]*$/;` → `const FENCE_OPEN = /^ {0,3}(`{3,}).*$/;` | killed |
| R02 | src/review/ledger.ts:147 | `const FENCE_OPEN = /^ {0,3}(`{3,})[^`]*$/;` → `const FENCE_OPEN = /^ *(`{3,})[^`]*$/;` | killed |
| R03 | src/review/ledger.ts:168 | `close[1]!.length >= opened.length` → `close[1]!.length >= 3` | killed |
| R04 | src/review/ledger.ts:162 | `raw.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd` → `lineEnd` | killed |
| R05 | src/review/ledger.ts:175 | `if (opened !== undefined) ranges.push([opened.from, raw.length] as const);` → `if (opened !== undefined) ranges.push([opened.from, opened.from] as const);` | killed |
| R06 | src/review/ledger.ts:149 | `const FENCE_CLOSE = /^ {0,3}(`{3,})[ \t]*$/;` → `const FENCE_CLOSE = /^ {0,3}(`{3,}).*$/;` | killed |
| R07 | src/review/ledger.ts:216 | `if (parsed === undefined) {` → `if (false as boolean) {` | killed |
| R08 | src/review/ledger.ts:169 | `ranges.push([opened.from, lineEnd] as const);` → `ranges.push([opened.from, opened.from] as const);` | killed |
| R09 | src/review/ledger.ts:165 | `if (open !== null) opened = { from: lineStart, length: open[1]!.length };` → `if (open !== null) opened = { from: lineStart, length: 3 };` | killed |
| R10 | src/review/ledger.ts:204 | `const LINE_CLOSE = /^ {0,3}```[ \t]*\r?$/gm;` → `const LINE_CLOSE = /```/g;` | killed |
| R11 | src/review/ledger.ts:140 | `if (value !== undefined) found.push({ start, value });` → `found.push({ start, value });` | survived |
| R12 | src/review/ledger.ts:222 | `return { result: hasStatus(parsed) ? parsed : undefined };` → `return { result: parsed as ParsedResult };` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
