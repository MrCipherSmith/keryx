# Review Report — Flow 219, Round 1

## Verdict: REQUEST_CHANGES

The architecture, high-load, and bounded regression passes were clean. Logic and testing passes found two acceptance-criterion blockers and one behavioral-coverage gap.

## Review Scope

- Branch: `fix/tui-foreground-operation-cancellation`
- Parent ref: `main`
- Merge-base: `09e8555c9079c3142125799c9e560e65d1eeae01`
- Scope mode: `explicit-hash-range`
- Reviewers dispatched: `review-logic`, `review-architecture`, `review-highload`, `review-testing-practices`, `review-regression`
- Changed files: 9 code/test files
- Context mode: `light`
- Model strategy: `adaptive`
- Current model: `gpt-5.6`
- Model assignment: `Terra for domain reviewers`

## Stats

- blocker: 2
- major: 0
- minor: 1
- info: 0

## Stage counts

- dropped by pre-filter: 0 files, 0 blocks, 0 changed lines
- verification mode: `annotate`
- verdicts: pending Wave C
- retained before verifier: 3

## Findings

### [F-001] RLM preparation continues after cancellation

- **Severity**: blocker
- **File**: `src/wiki/enrich.ts:1584`
- **Problem**: `runRlmPipeline` does not observe `input.signal` while preparing pages and can continue callbacks, reads, hashing, classification, and unit construction after abort.
- **Why it matters**: violates frozen AC2 and AC6 for `rlm.enabled=true`.
- **Fix**: short-circuit at entry and after preparation awaits, return deterministic cancelled results, and add an RLM-enabled regression.

### [F-002] Foreground AgentIO callbacks are not fenced after teardown

- **Severity**: blocker
- **File**: `src/tui/tui-shell.ts:2611`
- **Problem**: a late `AbortError` or provider event can still reach TUI callbacks after the foreground owner is disposed.
- **Why it matters**: violates frozen AC4 by repainting or persisting after renderer teardown.
- **Fix**: pass an identity/disposal-guarded AgentIO facade to each foreground turn and test late callbacks behaviorally.

### [F-T001] TUI lifecycle assertions are source-text only

- **Severity**: minor
- **File**: `src/tui/tui-shell.test.ts:2921`
- **Problem**: new TUI lifecycle tests inspect source strings instead of executing the owner/Force/destroy behavior.
- **Why it matters**: exact-once priority handoff and post-dispose callback suppression are not behaviorally pinned.
- **Fix**: add a deterministic behavioral seam and direct unit tests.

## Checked and cleared

- Foreground ownership is identity-safe and Force waits for settlement.
- Signal propagation and deep timeout composition are bounded and backward compatible.
- Explicit CLI wiki-enrich commands retain normal command routing.
- All 46 retained blast-radius files were checked; no dependent regression was found.
- Six mutation targets were killed by their nearest tests; none survived.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "blocker",
    "file": "src/wiki/enrich.ts",
    "line": 1584,
    "problem": "The RLM-enabled pipeline never observes input.signal while it prepares pages, so after cancellation it can still emit progress, read pages, compute hashes and classifications, build units, and invoke the worker pool.",
    "impact": "Frozen AC2 and AC6 are unimplemented for rlm.enabled=true: cancelling a large enrichment permits new page work and callbacks after abort.",
    "suggested_fix": "Make runRlmPipeline abort-aware at entry and after each preparation await, return deterministic cancelled entries without dispatching units, and add an RLM-enabled cancellation regression.",
    "evidence": "The only preparation loop at src/wiki/enrich.ts:1584-1667 calls onPage and awaits read/hash work without a signal check; downstream checks begin only in runDeepSingle and runLightBatch.",
    "confidence": "high",
    "dedupe_key": "flow219-rlm-cancellation-preparation",
    "blocking_merge": true,
    "class_scope": {
      "sites": ["src/wiki/enrich.ts:1584", "src/wiki/enrich.ts:1587", "src/wiki/enrich.ts:1589", "src/wiki/enrich.ts:1696", "src/wiki/enrich.ts:1709"],
      "enumeration_method": "Enumerated the sole RLM preparation loop and sole unit-pool dispatch, then located every signal check with keryx ctx rg."
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "blocker",
    "file": "src/tui/tui-shell.ts",
    "line": 2611,
    "problem": "Renderer disposal cancels the foreground signal but does not fence foreground AgentIO callbacks, so a late provider abort/error event can still update destroyed TUI state.",
    "impact": "Frozen AC4 is unimplemented for late callbacks: teardown can be followed by transcript, fleet, or persistence callbacks.",
    "suggested_fix": "Pass a token- and disposal-guarded AgentIO facade to each foreground run and add a behavioral late-callback regression.",
    "evidence": "onDestroy disposes at src/tui/tui-shell.ts:2032, while runAgentTurn's abort path calls system/onSystem and the wrappers around src/tui/tui-shell.ts:2570-2624 have no owner/token guard.",
    "confidence": "high",
    "dedupe_key": "flow219-post-disposal-agentio-callback",
    "blocking_merge": true,
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts:2570", "src/tui/tui-shell.ts:2595", "src/tui/tui-shell.ts:2611", "src/tui/tui-shell.ts:2624"],
      "enumeration_method": "Enumerated the foreground TUI AgentIO write, history, reasoning/tool, system, approval, usage and auto-approval entry hooks installed for runAgentTurn."
    }
  },
  {
    "id": "F-T001",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/tui-shell.test.ts",
    "line": 2921,
    "problem": "The new TUI lifecycle tests read source text and do not execute queue/lifecycle behavior.",
    "impact": "Force exact-once/FIFO and suppression of late callbacks after destroy are not behaviorally pinned.",
    "suggested_fix": "Add a deterministic behavioral lifecycle seam with direct tests for Force-after-settlement and post-dispose callback suppression.",
    "evidence": "The flow-219 TUI describe block uses readFileSync and source string/regex assertions; the mutation pass killed all six existing guards but could not execute these TUI interactions.",
    "confidence": "high",
    "dedupe_key": "flow219-tui-lifecycle-source-audit-not-behavioral",
    "blocking_merge": false
  }
]
```
