# PR #801 review (flow368-pr801-review)

No blocker. Two major, four minor. The review was static.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow368-pr801-review",
  "severity": "major",
  "problem": "The diff cap is stated in the run output but never in the posted review, and the run record does not keep the truncation facts.",
  "impact": "A reader of a review of a truncated diff assumes full coverage.",
  "suggested_fix": "Persist the truncation facts and write them into the review body.",
  "evidence": "the reviewer read post.ts and run.ts; not run",
  "confidence": "high",
  "file": "src/review/bot/post.ts",
  "line": 75,
  "quote": "buildReviewPayload",
  "class_scope": {
   "sites": [
    "src/review/bot/post.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow368-pr801-review",
  "severity": "major",
  "problem": "Only finding bodies are screened; the file header and the assembled body are not, and `file` is a free-form model string.",
  "impact": "A secret-shaped string placed in `file` reaches the public review unscreened.",
  "suggested_fix": "Screen the assembled body and comments; drop a file that is not in the diff.",
  "evidence": "the reviewer read post.ts; not run",
  "confidence": "high",
  "file": "src/review/bot/post.ts",
  "line": 210,
  "quote": "screenComments",
  "class_scope": {
   "sites": [
    "src/review/bot/post.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow368-pr801-review",
  "severity": "minor",
  "problem": "A finding without a quote keeps a model-supplied line and can become an inline comment on an unverified line.",
  "impact": "An inline comment can land on the wrong code.",
  "suggested_fix": "Inline only findings whose locator state is derived.",
  "evidence": "the reviewer read run.ts and post.ts; not run",
  "confidence": "high",
  "file": "src/review/bot/run.ts",
  "line": 286,
  "quote": "locateFinding",
  "class_scope": {
   "sites": [
    "src/review/bot/run.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-004",
  "reviewer": "flow368-pr801-review",
  "severity": "minor",
  "problem": "postedAt is written only after the POST and nothing dedupes across runs, so a reopened pull request or a failed state write can post a second review.",
  "impact": "Exactly one review holds per invocation, not per head.",
  "suggested_fix": "A per-head marker with a pre-POST read of existing reviews; report a failed state write instead of throwing.",
  "evidence": "the reviewer read post.ts; not run",
  "confidence": "high",
  "file": "src/review/bot/post.ts",
  "line": 229,
  "quote": "postedAt",
  "class_scope": {
   "sites": [
    "src/review/bot/post.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-005",
  "reviewer": "flow368-pr801-review",
  "severity": "minor",
  "problem": "The guide implies the Action produces metrics, but the packages stay on the ephemeral runner.",
  "impact": "A team that installs the workflow sees n/a metrics.",
  "suggested_fix": "State that metrics need the packages where `review complete` is run.",
  "evidence": "the reviewer read the guide and action.yml; not run",
  "confidence": "high",
  "file": "docs/docs/guides/review-as-a-pr-bot.md",
  "line": 8,
  "quote": "metrics",
  "class_scope": {
   "sites": [
    "docs/docs/guides/review-as-a-pr-bot.md"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-006",
  "reviewer": "flow368-pr801-review",
  "severity": "minor",
  "problem": "One schema-invalid finding makes the whole ingest throw after all model turns were paid for.",
  "impact": "All findings of a run are lost when one is invalid; the failure is loud.",
  "suggested_fix": "Pre-validate each finding and drop the invalid ones.",
  "evidence": "the reviewer read run.ts; not run",
  "confidence": "high",
  "file": "src/review/bot/run.ts",
  "line": 325,
  "quote": "createManagedReviewPackage",
  "class_scope": {
   "sites": [
    "src/review/bot/run.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 }
]
```
