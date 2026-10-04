# Review of PR #885 (flow 402), head a8cf07b8

Acceptance criteria AC1 to AC8 were checked against the committed files. AC4 (byte equality with protocol v2), AC5 (45 log rows, quotes found verbatim, English changes faithful, held-back rows consistent), AC6, AC8 and the counts all pass. Three defects were found.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "file": ".metaproject/flows/402-2026-10-04-part1-materials/journal.md",
    "line": 8,
    "problem": "The flow journal committed in the PR quotes a withheld working-hours phrase and names the team-repository ban, which AC5 and the operator's privacy rule keep out of public text.",
    "impact": "A phrase the operator asked not to publish becomes public in the repository and its history.",
    "suggested_fix": "Reword the line to say only that some decisions were withheld for privacy and refer to the held-back list; drop the quote and the topic.",
    "evidence": "Line 8 listed the withheld working-hours quote and 'the ban on team-repository details' among rows without a findable quote.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        ".metaproject/flows/402-2026-10-04-part1-materials/journal.md",
        ".metaproject/flows/402-2026-10-04-part1-materials/flow.json",
        "PR #885 body",
        "docs/research/role-blurring-part1/README.md"
      ],
      "enumeration_method": "keryx ctx rg -n -i --hidden over the flow 402 folder, docs/research/role-blurring-part1 and src/docs for the withheld phrases, plus a read of the PR body"
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": null,
    "line": null,
    "problem": "The PR description says protocol part 2 is v1, but the committed file is version 2.",
    "impact": "A reader of the PR is told the wrong protocol version.",
    "suggested_fix": "Correct the PR body to version 2.",
    "evidence": "PR body: 'protocol part 2 (v1, fixed 2026-10-04)'. The file heading ends 'версия 2' and its SHA-256 is that of v2.",
    "confidence": "high"
  },
  {
    "id": "F-003",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/docs/part1-materials.test.ts",
    "line": 9,
    "problem": "The export allow-list is imported from the exporter instead of pinned in the test, and values are not type-checked.",
    "impact": "A later edit of the exporter widens the test silently, and a string-valued text field under an allowed name would pass.",
    "suggested_fix": "Pin the field list literally in the test and check value types.",
    "evidence": "import { EXPORT_FIELDS } from '../decisions/export'; only Object.keys were asserted.",
    "confidence": "high"
  }
]
```
