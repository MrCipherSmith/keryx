# Phase 5 — the review round

Measurement, taxonomy, skill evaluation and cross-family review.
The evaluator found 27 real defects in the shipped tree on its first clean run.

```json keryx:findings
[
  {
    "id": "p5-01",
    "reviewer": "review-core-boundaries",
    "severity": "major",
    "file": "src/review/managed.ts",
    "line": 1,
    "scope": "diff",
    "problem": "No structured filter_stats existed: stage counts were readable by a person and by nothing else, so no Phase 2 claim could be checked afterwards.",
    "impact": "A claim that could not be checked, or a mechanism that measured nothing.",
    "suggested_fix": "Instrument at the producer; give every count a consumer; prove the evaluator fails something.",
    "evidence": "Established by enumeration over the tree and by running each surface end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 141ebac5 (PR #416); 17 mutations across both halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/review/managed.ts"
      ],
      "enumeration_method": "evaluateBundledTree sweeps all 65 shipped skills with a non-vacuity assertion; filter-stats tests read the real artifact off disk."
    }
  },
  {
    "id": "p5-02",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/review/filter-stats.ts",
    "line": 1,
    "scope": "diff",
    "problem": "Instrumentation that reports zero because nothing measured reads as a clean result; measured-zero and not-measured had to be distinguishable.",
    "impact": "A claim that could not be checked, or a mechanism that measured nothing.",
    "suggested_fix": "Instrument at the producer; give every count a consumer; prove the evaluator fails something.",
    "evidence": "Established by enumeration over the tree and by running each surface end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 141ebac5 (PR #416); 17 mutations across both halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/review/filter-stats.ts"
      ],
      "enumeration_method": "evaluateBundledTree sweeps all 65 shipped skills with a non-vacuity assertion; filter-stats tests read the real artifact off disk."
    }
  },
  {
    "id": "p5-03",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/review.ts",
    "line": 1,
    "scope": "diff",
    "problem": "A field with no reader repeats the attempts.count defect \u2014 declared and never written for a whole release.",
    "impact": "A claim that could not be checked, or a mechanism that measured nothing.",
    "suggested_fix": "Instrument at the producer; give every count a consumer; prove the evaluator fails something.",
    "evidence": "Established by enumeration over the tree and by running each surface end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 141ebac5 (PR #416); 17 mutations across both halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/commands/review.ts"
      ],
      "enumeration_method": "evaluateBundledTree sweeps all 65 shipped skills with a non-vacuity assertion; filter-stats tests read the real artifact off disk."
    }
  },
  {
    "id": "p5-04",
    "reviewer": "review-logic",
    "severity": "major",
    "file": ".metaproject/memory/review-notes",
    "line": 1,
    "scope": "diff",
    "problem": "The review-note type had never been written, so the learning loop had produced nothing to date.",
    "impact": "A claim that could not be checked, or a mechanism that measured nothing.",
    "suggested_fix": "Instrument at the producer; give every count a consumer; prove the evaluator fails something.",
    "evidence": "Established by enumeration over the tree and by running each surface end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 141ebac5 (PR #416); 17 mutations across both halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        ".metaproject/memory/review-notes"
      ],
      "enumeration_method": "evaluateBundledTree sweeps all 65 shipped skills with a non-vacuity assertion; filter-stats tests read the real artifact off disk."
    }
  },
  {
    "id": "p5-05",
    "reviewer": "review-core-boundaries",
    "severity": "blocker",
    "file": "src/gdskills/bundled",
    "line": 1,
    "scope": "diff",
    "problem": "65 shipped skills had no evaluation of any kind; the tree was assumed correct and carried 27 real defects including a skill dispatching an agent that never shipped and a script that never existed.",
    "impact": "A claim that could not be checked, or a mechanism that measured nothing.",
    "suggested_fix": "Instrument at the producer; give every count a consumer; prove the evaluator fails something.",
    "evidence": "Established by enumeration over the tree and by running each surface end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 141ebac5 (PR #416); 17 mutations across both halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled"
      ],
      "enumeration_method": "evaluateBundledTree sweeps all 65 shipped skills with a non-vacuity assertion; filter-stats tests read the real artifact off disk."
    }
  },
  {
    "id": "p5-06",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/lib/provider-config.ts",
    "line": 1,
    "scope": "diff",
    "problem": "Cross-family review capability existed in configuration and was read by nothing in the review pipeline.",
    "impact": "A claim that could not be checked, or a mechanism that measured nothing.",
    "suggested_fix": "Instrument at the producer; give every count a consumer; prove the evaluator fails something.",
    "evidence": "Established by enumeration over the tree and by running each surface end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 141ebac5 (PR #416); 17 mutations across both halves, each observed red and restored."
    }
  }
]
```
