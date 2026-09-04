# Flow 227 Managed Review — Round 1

Target: `feat/lwg-phase-2-refresh` at `c9e86268`
Base: `main`
Fix round: true

Reviewers: logic, architecture.

## Outcome

- 0 blockers
- 1 major, fixed on the branch and re-verified at the reviewed head
- 1 info, dismissed with a stated reason
- External comments: collection ran against PR #455 head `c9e86268`; zero comments.
- Suite: 6758 pass, 48 fail — the same 48 that fail at the branch base.

## Note

The major was found in self-review, in a command written during this same
phase. It is the second time in this package that the tool built to stop
overclaiming was itself overclaiming — the first was the freshness range
label in phase 1. Both were caught by asking what the output ASSERTS rather
than whether it runs.

```json keryx:findings
[
  {
    "id": "F-NEW-001",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "`wiki verify` with no arguments stamped every page in the corpus.",
    "impact": "VerifiedAt exists to record that a human looked at a page. Stamping 44 pages in one keystroke asserted 44 reviews that did not happen \u2014 the exact class of quiet overstatement this package was built to prevent, committed by the tool meant to prevent it. Downstream, the freshness report would then show a corpus that looked reviewed and was not.",
    "suggested_fix": "Require explicit intent: --page for a real review, --baseline for a measurement starting line, and say in the output that a baseline is not a claim the pages were read.",
    "evidence": "Running `wiki verify` on this repository stamped 44 pages with no flag and no warning; the freshness report then reported 44 fresh.",
    "confidence": "high",
    "file": "src/wiki/refresh.ts",
    "line": 268,
    "class_scope": {
      "sites": [
        "src/wiki/refresh.ts:268",
        "src/commands/wiki.ts"
      ],
      "enumeration_method": "verifyPages is the only provenance-writing entry point."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed at c9e86268 (merged as edd93155): verifyPages throws unless --page or --baseline is given, and the command prints that a baseline is not a claim the pages were read."
    }
  },
  {
    "id": "F-NEW-002",
    "reviewer": "review-architecture",
    "severity": "info",
    "problem": "The Reference renderer lives inline inside collectGraphWikiCandidates, so `refresh` had to either duplicate it or call the whole candidate builder.",
    "impact": "Duplicating would have created a second renderer that drifts from the first \u2014 the failure this package has already paid for three times (validModuleNames, wikiPruneOrphans, computePageNodeHash). Calling the builder does redundant work for modules that are not being refreshed.",
    "suggested_fix": "Call the existing builder and lift the section out. Accept the redundant work; correctness of a single renderer outranks it.",
    "evidence": "collectGraphWikiCandidates renders Reference inline at src/wiki/service.ts:518-536, with no seam to call.",
    "confidence": "high",
    "file": "src/wiki/refresh.ts",
    "line": 178,
    "class_scope": {
      "sites": [
        "src/wiki/refresh.ts:178"
      ],
      "enumeration_method": "Single call site for Reference content."
    },
    "disposition": {
      "state": "dismissed-wont-fix",
      "evidence": "Deliberate at c9e86268 (merged as edd93155) and written down at the site: one renderer means a Reference format change reaches refresh automatically. Extracting a seam is a worthwhile follow-up but not at the cost of a second implementation now."
    }
  }
]
```
