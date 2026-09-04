# Flow 228 Managed Review — Round 1

Target: `feat/lwg-phase-5-health` at `82b8c365`
Base: `main`
Fix round: true

Reviewers: testing-practices, architecture.

## Outcome

- 0 blockers, 1 minor, 1 info — both fixed on the branch and re-verified.
- External comments: collection ran against PR #458 head `82b8c365`; zero comments.
- Suite: 6776 pass, 48 fail — the same 48 that fail at the branch base.
- The new CI job ran on its own PR and passed, and reported honestly: the
  runner had no tree-sitter, so classification degraded to `body` and the
  report declared `symbol-layer-unavailable` rather than looking clean.

## Note

Both findings are about tests that would have PASSED while proving nothing.
That is the third distinct shape of the same failure in this package — after
a range label that did not describe its measurement and a stamp that asserted
reviews nobody made. The through-line: ask what a thing asserts, not whether
it runs.

```json keryx:findings
[
  {
    "id": "F-NEW-001",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "The first AC8 test asserted an always-empty array and a vacuous typeof check, proving nothing.",
    "impact": "A test that looks like evidence and is not is worse than no test: it makes a criterion read as confirmed while the property stays unchecked. AC8 claims the metric reads one file and starts no traversal, and nothing verified it.",
    "suggested_fix": "Assert the observable consequence \u2014 the metric resolves in a project with no graph and no wiki, and a directory full of pages does not change its numbers.",
    "evidence": "The test built an `opened` array, never populated it, and asserted it was empty.",
    "confidence": "high",
    "file": "src/health/metrics/wiki-freshness.test.ts",
    "line": 119,
    "class_scope": {
      "sites": [
        "src/health/metrics/wiki-freshness.test.ts:119"
      ],
      "enumeration_method": "Reviewed every test added in this phase for vacuous assertions."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Replaced at 82b8c365 (merged as 6babe28f) with two tests: one asserts .metaproject contains only data/, the other that 20 wiki pages on disk do not change pagesTotal from the report's 50."
    }
  },
  {
    "id": "F-NEW-002",
    "reviewer": "review-architecture",
    "severity": "info",
    "problem": "AC7 (the gate cannot see the metric) was initially planned as a runtime comparison of gate verdicts.",
    "impact": "computeGate does not receive the report, so any such comparison passes trivially and would keep passing if someone later wired the metric in \u2014 the exact moment the guarantee breaks.",
    "suggested_fix": "Assert it at the type level instead, so the guard fails at compile time when the input gains the field.",
    "evidence": "computeGate takes {findings, projectMetrics, sources, config, strict}; the report never reaches it.",
    "confidence": "high",
    "file": "src/health/wiki-freshness-gate.test.ts",
    "line": 26,
    "class_scope": {
      "sites": [
        "src/health/wiki-freshness-gate.test.ts:26"
      ],
      "enumeration_method": "Single guard for this property."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Implemented at 82b8c365 (merged as 6babe28f) as a conditional type over Parameters<typeof computeGate>[0] that stops compiling if wikiFreshness is added."
    }
  }
]
```
