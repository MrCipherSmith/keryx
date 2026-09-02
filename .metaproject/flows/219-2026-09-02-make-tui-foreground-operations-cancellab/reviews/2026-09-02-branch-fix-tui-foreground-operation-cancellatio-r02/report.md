# Flow 219 Managed Review — Round 2

Target: `fix/tui-foreground-operation-cancellation` at `198b3d1b`
Base: `09e8555c9079c3142125799c9e560e65d1eeae01`
Fix round: true

Reviewers: logic, architecture, high-load, testing practices, regression, verifier.

## Outcome

- 0 blockers
- 3 majors
- 1 minor
- 0 info
- Scope-B regression review: clean across 45 retained files.
- Independent verification: 4/4 findings confirmed by execution.
- Focused changed suite: 156 passed, 0 failed.
- Full-suite comparison: branch adds 7 passes; the same 49 failures and 18 skips reproduce at the base commit.

## Findings

### F-NEW-001 — Wiki enrichment error handler is not fenced after disposal

The natural-language wiki-enrichment catch calls `stopBusy()` and appends a renderer node after the foreground owner may have been disposed. A late rejection after busy exit can therefore mutate a destroyed TUI. Add a disposal/abort guard before all catch-side UI work and pin rejection-after-dispose behavior.

### F-ARCH-HL-001 — A second Force drops the first selected queue item

Two Force actions before settlement overwrite the single `priorityMainQuestion` slot. Both source items are removed, but only the last dispatches. Replace the single slot with an ordered pending-force handoff or requeue displaced work, and test the double-Force interleaving.

### F-ARCH-HL-002 — Default enrichment can start a model turn after cancellation

The non-RLM path has no abort fence immediately after its page read. Cancellation while the read is pending still reaches `runModelTurn`, potentially consuming a provider request. Check abort after awaited preparation and before provider dispatch; add a deterministic delayed-boundary test.

### F-T001 — Several new cancellation checkpoints are not independently pinned

Bounded deletion mutations survived for disposal-aware handoff, approval revalidation, deep cancellation result selection, and selected wiki cancellation checkpoints. Add controlled deferred fixtures that make the guards observably necessary.

```json keryx:findings
[
  {
    "id": "F-NEW-001",
    "severity": "major",
    "reviewer": "review-logic",
    "file": "src/tui/tui-shell.ts",
    "line": 4717,
    "title": "Wiki enrichment error handler is not fenced after disposal",
    "problem": "The wiki-enrichment catch mutates the TUI without checking whether the foreground operation was aborted or disposed.",
    "impact": "A late rejected wiki operation can mutate a disposed renderer.",
    "evidence": "The catch invokes stopBusy and transcript.add without an abort/disposal guard; the verifier executed a deterministic source probe.",
    "suggested_fix": "Return from the catch when the foreground operation is aborted or disposed, and add rejection-after-dispose coverage.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts:4717"],
      "enumeration_method": "Enumerated all foreground-operation completion and catch paths in tui-shell.ts; this is the only renderer-mutating wiki catch without a lifecycle guard."
    }
  },
  {
    "id": "F-ARCH-HL-001",
    "severity": "major",
    "reviewer": "review-architecture,review-highload",
    "file": "src/tui/tui-shell.ts",
    "line": 3765,
    "title": "A second Force drops the first selected queue item",
    "problem": "Two Force actions before settlement overwrite a single priority slot after both source items have been removed.",
    "impact": "Concurrent Force requests can silently lose a queued user command.",
    "evidence": "Two concurrent Force-style handoffs removed both inputs and dispatched only the second in the verifier probe.",
    "suggested_fix": "Use an ordered pending-force queue or preserve displaced priority work and test double Force.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts:3717", "src/tui/tui-shell.ts:3761", "src/tui/tui-shell.ts:3847"],
      "enumeration_method": "Enumerated both Force entry points and the sole priorityMainQuestion handoff implementation."
    }
  },
  {
    "id": "F-ARCH-HL-002",
    "severity": "major",
    "reviewer": "review-highload",
    "file": "src/wiki/enrich.ts",
    "line": 780,
    "title": "Default enrichment can start a model turn after cancellation",
    "problem": "The non-RLM worker does not re-check cancellation after awaiting the page read and before starting the provider turn.",
    "impact": "A cancelled default worker can consume a provider request and delay settlement.",
    "evidence": "The verifier aborted at the start callback and still observed one model call.",
    "suggested_fix": "Add a post-read/pre-provider abort fence and a deterministic regression test.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/wiki/enrich.ts:780-790"],
      "enumeration_method": "Compared every page read and runModelTurn site in enrich.ts; the RLM equivalent is already fenced and the default path is not."
    }
  },
  {
    "id": "F-T001",
    "severity": "minor",
    "reviewer": "review-testing-practices",
    "file": "src/tui/foreground-operation.ts",
    "line": 95,
    "title": "Several new cancellation checkpoints are not independently pinned",
    "problem": "Five changed cancellation guards can be deleted while their nearest test suites remain green.",
    "impact": "Cancellation guards can regress while the nearest suites remain green.",
    "evidence": "Five bounded deletion mutations survived; the verifier confirmed missing independent disposal/handoff coverage.",
    "suggested_fix": "Add deferred disposal, approval, deep-result, and post-abort checkpoint tests.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/tui/foreground-operation.ts:95", "src/tui/foreground-operation.ts:142", "src/wiki/deep-enrich.ts:435", "src/wiki/enrich.ts:854", "src/wiki/enrich.ts:1602"],
      "enumeration_method": "Bounded deletion mutations of the high-risk Flow 219 cancellation gates."
    }
  }
]
```

Routing audit: graph_used=yes; wiki_used=yes; ctx_used=yes; raw_rg_used=no.
