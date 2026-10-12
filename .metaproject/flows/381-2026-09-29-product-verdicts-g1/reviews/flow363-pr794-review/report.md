# PR #794 review (flow363-pr794-review)

No blocker: nothing gates, no model code in src/product, all eight contract points hold. Six findings, all low severity.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow363-pr794-review",
  "severity": "minor",
  "problem": "The flow-journal observation regex was not fence-aware, unlike the docpack path.",
  "impact": "A journal holding a fenced example `outcome-observed: <verdict> \u2014 <note>` before a real observation reported observed:false plus a parse failure, and index exited 1.",
  "suggested_fix": "Ignore fenced lines and take the first line outside a fence.",
  "evidence": "the reviewer ran the input through the real function",
  "confidence": "high",
  "file": "src/product/extract.ts",
  "line": 16,
  "quote": "const OBSERVATION = /^outcome-observed:[ \\t]*(.*)$/m",
  "class_scope": {
   "sites": [
    "src/product/extract.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow363-pr794-review",
  "severity": "minor",
  "problem": "A docpack section with placeholder text (`_None yet._`, an HTML comment, a fenced example) was a failure.",
  "impact": "A package README with a comment placeholder made product index exit 1.",
  "suggested_fix": "Strip fences and HTML comments; an empty remainder is no observation. Keep the grammar strict.",
  "evidence": "the reviewer ran five inputs",
  "confidence": "high",
  "file": "src/product/extract.ts",
  "line": 82,
  "quote": "Outcome observations section parsing",
  "class_scope": {
   "sites": [
    "src/product/extract.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow363-pr794-review",
  "severity": "minor",
  "problem": "hasInstrument tested the joined criterion for a not measured prefix.",
  "impact": "A `not measured` bullet followed by a real bullet counted as no instrument.",
  "suggested_fix": "Evaluate per bullet.",
  "evidence": "the reviewer ran the input",
  "confidence": "high",
  "file": "src/product/extract.ts",
  "line": 37,
  "quote": "export function hasInstrument",
  "class_scope": {
   "sites": [
    "src/product/extract.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-004",
  "reviewer": "flow363-pr794-review",
  "severity": "minor",
  "problem": "The hint skip matched a prefix, so a real bullet starting with the hint words was dropped.",
  "impact": "`- State an outcome criterion for checkout: p95 under 2s` gave criterion null.",
  "suggested_fix": "Skip only the exact template hint line.",
  "evidence": "the reviewer ran the input",
  "confidence": "high",
  "file": "src/product/extract.ts",
  "line": 28,
  "quote": "hint prefix skip",
  "class_scope": {
   "sites": [
    "src/product/extract.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-005",
  "reviewer": "flow363-pr794-review",
  "severity": "minor",
  "problem": "No test covered an old-format index, and indexProblem accepted observed:true with verdict:null.",
  "impact": "Removing the new checks would not have failed any test.",
  "suggested_fix": "Add malformed-index tests and reject the inconsistent pair.",
  "evidence": "the reviewer read store.ts and the tests",
  "confidence": "high",
  "file": "src/product/store.ts",
  "line": 34,
  "quote": "indexProblem verdict and count keys",
  "class_scope": {
   "sites": [
    "src/product/store.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-006",
  "reviewer": "flow363-pr794-review",
  "severity": "info",
  "problem": "The document overstated that no journal line existed; G1a could be passed by writing not measured everywhere; the cli-reference header sketch omitted the counts.",
  "impact": "A reader could take the arm as nothing observed anywhere, and read G1a as measuring criteria.",
  "suggested_fix": "Soften the sentence, report the two shares separately, show the counts.",
  "evidence": "the reviewer read the docs",
  "confidence": "high",
  "file": "docs/requirements/keryx-product-module/metrics-and-validation.md",
  "line": 1,
  "quote": "before arm wording",
  "class_scope": {
   "sites": [
    "docs/requirements/keryx-product-module/metrics-and-validation.md"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 }
]
```
