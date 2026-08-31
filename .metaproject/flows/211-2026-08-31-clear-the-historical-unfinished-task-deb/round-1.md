# Flow 211 — the review round

The historical task debt, and the proposal to remove the scaffold that was
refuted by measuring it.

```json keryx:findings
[
  {
    "id": "s-01",
    "reviewer": "review-core-boundaries",
    "severity": "major",
    "file": ".metaproject/flows",
    "line": 1,
    "scope": "diff",
    "problem": "The programme quoted 34 unfinished tasks across 24 flows for a month; the count is 59 across 26, and the severity was overstated because the figure mixed bookkeeping with dropped work.",
    "impact": "A quoted number that overstated, a document that described a task that did not exist, or a proposed mechanism that would record an unmade decision.",
    "suggested_fix": "Measure before asserting; render the document from the same constant as the state; mark origin as a fact; refuse the time term.",
    "evidence": "Measured across all 206 flow packages; the template drift verified against the committed file.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 55e1bd83 and b1646404. Two mutations for the scaffold decision, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        ".metaproject/flows"
      ],
      "enumeration_method": "All 206 flow packages read and categorised; scaffold rows matched by id and title at the pre-cleanup commit."
    }
  },
  {
    "id": "s-02",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/flow/templates.ts",
    "line": 48,
    "scope": "diff",
    "problem": "tasks.md documented T4 as 'Review, fix findings, and prepare PR' while flow.json carried 'Self-review and prepare draft PR' \u2014 every generated package described a task it did not contain.",
    "impact": "A quoted number that overstated, a document that described a task that did not exist, or a proposed mechanism that would record an unmade decision.",
    "suggested_fix": "Measure before asserting; render the document from the same constant as the state; mark origin as a fact; refuse the time term.",
    "evidence": "Measured across all 206 flow packages; the template drift verified against the committed file.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 55e1bd83 and b1646404. Two mutations for the scaffold decision, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/flow/templates.ts"
      ],
      "enumeration_method": "All 206 flow packages read and categorised; scaffold rows matched by id and title at the pre-cleanup commit."
    }
  },
  {
    "id": "s-03",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "line": 82,
    "scope": "diff",
    "problem": "The scaffold rows carried no marker, so identifying them required matching titles \u2014 which breaks on any rewording and cannot distinguish a generated row from an identical hand-written one.",
    "impact": "A quoted number that overstated, a document that described a task that did not exist, or a proposed mechanism that would record an unmade decision.",
    "suggested_fix": "Measure before asserting; render the document from the same constant as the state; mark origin as a fact; refuse the time term.",
    "evidence": "Measured across all 206 flow packages; the template drift verified against the committed file.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 55e1bd83 and b1646404. Two mutations for the scaffold decision, each observed red and restored."
    }
  },
  {
    "id": "s-04",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/flow/machine.ts",
    "line": 1,
    "scope": "diff",
    "problem": "A time-based expiry for scaffold rows was requested; it would record a judgement nobody made, since 'expired' means nobody looked rather than that anyone decided.",
    "impact": "A quoted number that overstated, a document that described a task that did not exist, or a proposed mechanism that would record an unmade decision.",
    "suggested_fix": "Measure before asserting; render the document from the same constant as the state; mark origin as a fact; refuse the time term.",
    "evidence": "Measured across all 206 flow packages; the template drift verified against the committed file.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 55e1bd83 and b1646404. Two mutations for the scaffold decision, each observed red and restored."
    }
  }
]
```
