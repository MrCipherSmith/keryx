# PR #799 review (flow366-pr799-review)

No blocker and no major. Five minor findings. The review was static.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow366-pr799-review",
  "severity": "minor",
  "problem": "The docs and CHANGELOG dated agy 1.2.12's live verification 2026-09-29, but its fixtures are recorded 2026-09-28.",
  "impact": "A reader checking the fixtures finds a date that disagrees with the docs.",
  "suggested_fix": "Give agy the 2026-09-28 date, or re-record it.",
  "evidence": "the reviewer read the fixtures' versions files; not run",
  "confidence": "high",
  "file": "docs/docs/harness.md",
  "line": 379,
  "quote": "Live-verified on 2026-09-29",
  "class_scope": {
   "sites": [
    "docs/docs/harness.md"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow366-pr799-review",
  "severity": "minor",
  "problem": "The docs said KERYX_LIVE_EXTERNAL=1 re-records the transcripts and that the tests replay them all; the live tests only assert, and the agy replay lives in another test file.",
  "impact": "The docs promise a recording step that does not exist.",
  "suggested_fix": "Reword to assert-against-real-processes, name where agy is replayed.",
  "evidence": "the reviewer read live-fixtures.test.ts; not run",
  "confidence": "high",
  "file": "docs/docs/harness.md",
  "line": 386,
  "quote": "re-records them",
  "class_scope": {
   "sites": [
    "docs/docs/harness.md"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow366-pr799-review",
  "severity": "minor",
  "problem": "The comment says the expired-login wording was seen live, but no fixture holds it.",
  "impact": "A reader expects a fixture and finds only a unit test.",
  "suggested_fix": "State that the transcript was not captured.",
  "evidence": "the reviewer searched fixtures/external/live/codex-cli; not run",
  "confidence": "high",
  "file": "src/harness/external/codec/codex-cli.ts",
  "line": 239,
  "quote": "seen live on 2026-09-29",
  "class_scope": {
   "sites": [
    "src/harness/external/codec/codex-cli.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-004",
  "reviewer": "flow366-pr799-review",
  "severity": "minor",
  "problem": "The fixture-scan regexes cover a known set of patterns, yet the test title claims nothing private is present.",
  "impact": "The title overclaims what the tripwire proves.",
  "suggested_fix": "Rename the test to what it checks.",
  "evidence": "the reviewer read the scan patterns; not run",
  "confidence": "high",
  "file": "src/harness/external/live-fixtures.test.ts",
  "line": 148,
  "quote": "holds nothing private",
  "class_scope": {
   "sites": [
    "src/harness/external/live-fixtures.test.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-005",
  "reviewer": "flow366-pr799-review",
  "severity": "minor",
  "problem": "The live tests defaulted to the repository as cwd, so its uncommitted work would reach the vendor prompt, and a non-JSON failure surfaced as an opaque SyntaxError.",
  "impact": "Enabling the flag could send local changes to a vendor, and a refusal was hard to read.",
  "suggested_fix": "Require an explicit scratch cwd and include exit code and stderr in the failure.",
  "evidence": "the reviewer read liveRun; not run",
  "confidence": "high",
  "file": "src/harness/external/live-fixtures.test.ts",
  "line": 176,
  "quote": "process.cwd()",
  "class_scope": {
   "sites": [
    "src/harness/external/live-fixtures.test.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 }
]
```
