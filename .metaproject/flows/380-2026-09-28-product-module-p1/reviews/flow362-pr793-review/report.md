# PR #793 review (flow362-pr793-review)

No blocker: nothing gates, no model code in src/product, data confined to .metaproject/data/product/. Seven findings, two major.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow362-pr793-review",
  "severity": "major",
  "problem": "Staleness was mtime and count only.",
  "impact": "A renamed flow dir with the same count, files restored with cp -p or rsync -a (older mtimes), or an edit during the build left open answering from a stale index.",
  "suggested_fix": "Store a content fingerprint in the index and compare it.",
  "evidence": "the reviewer read checkStaleness at 825e0c3c",
  "confidence": "high",
  "file": "src/product/store.ts",
  "line": 75,
  "quote": "if ((await newestSourceMtime(cwd, packages)) > indexMtimeMs) {",
  "class_scope": {
   "sites": [
    "src/product/store.ts"
   ],
   "enumeration_method": "the reviewer read the module in full"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow362-pr793-review",
  "severity": "major",
  "problem": "looksLikeIndex validated three fields only, so a hand-edited or old index threw a TypeError in checkStaleness or buildOpenReport, and the TUI call site had no catch.",
  "impact": "CLI printed a raw stack instead of the message naming keryx product index; the TUI modal never opened.",
  "suggested_fix": "Validate every field the readers use; catch in loadOpenReport and at the TUI call site.",
  "evidence": "the reviewer read store.ts and tui-shell.ts",
  "confidence": "high",
  "file": "src/product/store.ts",
  "line": 31,
  "quote": "function looksLikeIndex(value: unknown): value is IntentIndex {",
  "class_scope": {
   "sites": [
    "src/product/store.ts"
   ],
   "enumeration_method": "the reviewer read the module in full"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow362-pr793-review",
  "severity": "minor",
  "problem": "The raw JSON.parse message entered the index and differs across runtimes.",
  "impact": "Byte-identity held only within one runtime.",
  "suggested_fix": "Store a fixed string.",
  "evidence": "the reviewer read corpus.ts",
  "confidence": "high",
  "file": "src/product/corpus.ts",
  "line": 97,
  "quote": "failures.push(`${repoPath}: ${error instanceof Error ? error.message : String(error)}`);",
  "class_scope": {
   "sites": [
    "src/product/corpus.ts"
   ],
   "enumeration_method": "the reviewer read the module in full"
  }
 },
 {
  "id": "F-004",
  "reviewer": "flow362-pr793-review",
  "severity": "minor",
  "problem": "readOptional mapped every error to null and reported it as an absent file.",
  "impact": "An unreadable file read as no flow.json.",
  "suggested_fix": "Swallow only ENOENT and record real errors.",
  "evidence": "the reviewer read corpus.ts",
  "confidence": "high",
  "file": "src/product/corpus.ts",
  "line": 21,
  "quote": "async function readOptional(file: string): Promise<string | null> {",
  "class_scope": {
   "sites": [
    "src/product/corpus.ts"
   ],
   "enumeration_method": "the reviewer read the module in full"
  }
 },
 {
  "id": "F-005",
  "reviewer": "flow362-pr793-review",
  "severity": "minor",
  "problem": "sectionOf was not code-fence aware.",
  "impact": "A heading inside a fenced block started or ended a section.",
  "suggested_fix": "Track fences.",
  "evidence": "the reviewer read extract.ts",
  "confidence": "high",
  "file": "src/product/extract.ts",
  "line": 23,
  "quote": "export function sectionOf(markdown: string, heading: RegExp): string | null {",
  "class_scope": {
   "sites": [
    "src/product/extract.ts"
   ],
   "enumeration_method": "the reviewer read the module in full"
  }
 },
 {
  "id": "F-006",
  "reviewer": "flow362-pr793-review",
  "severity": "minor",
  "problem": "The structural audit matched only three import shapes and could not catch a barrel or dynamic import.",
  "impact": "A flow file importing the product module through another path would pass the audit.",
  "suggested_fix": "Scan every specifier containing product, including dynamic import().",
  "evidence": "the reviewer read the test",
  "confidence": "high",
  "file": "src/product/never-gates.test.ts",
  "line": 149,
  "quote": "never-gates structural audit",
  "class_scope": {
   "sites": [
    "src/product/never-gates.test.ts"
   ],
   "enumeration_method": "the reviewer read the module in full"
  }
 },
 {
  "id": "F-007",
  "reviewer": "flow362-pr793-review",
  "severity": "info",
  "problem": "AC numbers in test header comments did not match the frozen criteria.",
  "impact": "Traceability from a test to its criterion was wrong.",
  "suggested_fix": "Reconcile the numbers.",
  "evidence": "the reviewer compared headers with acceptance-criteria.md",
  "confidence": "high",
  "file": "src/product/bulk-budget.test.ts",
  "line": 1,
  "quote": "header AC reference",
  "class_scope": {
   "sites": [
    "src/product/bulk-budget.test.ts"
   ],
   "enumeration_method": "the reviewer read the module in full"
  }
 }
]
```
