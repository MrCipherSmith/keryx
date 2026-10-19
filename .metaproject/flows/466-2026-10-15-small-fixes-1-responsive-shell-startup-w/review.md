# Startup review — small-fixes-1

**APPROVE_WITH_SUGGESTIONS — no blockers or majors; one minor coverage gap.**
Scope: nine source/test files on small-fixes-1, based on 22e99fe6b. Local review of uncommitted changes; remote CI not yet run. This is a bounded diff review, not merge certification.
Evidence level: ran — 333 tests across 7 files, 1490 assertions, 0 failures (41.74s); TypeScript and ESLint passed. Real PTY startup and targeted mutation runs executed by parent; independent reviewers inspected supplied evidence, not their own execution.

## Changes
- Reuse one asynchronous Git status snapshot within each orientation build; remove unused branch probe. No cross-call cache.
- Keep freshness failures unknown; cover edits, commits, renames and recovery, including isolated prefix-probe failure.
- Opt-in JSONL startup tracing for hooks, shell dependency construction and TUI, with event-loop lag and idempotent cleanup.

## Minor
TP-F03: shell/TUI completion wiring is not pinned by focused integration tests. TP-M13 and TP-M14 survive nearest suites. No production failure demonstrated. Add boundary tests that assert trace completion and kill both mutations.

## Prior findings repaired
TP-F01: isolated prefix failure now asserts unknown and recovery; TP-M06 killed.
TP-F02: timer cleanup and post-finish no-op assertions added; TP-M08 and TP-M10 killed.

## Performance evidence and limitations
Baseline warm orientation 371.7 / 320.3 / 371.1 ms; optimized warm samples 322.14 / 331.04 ms. Samples overlap: no statistically established speedup.
Final PTY process startup approximately 12.55 s; tui.loading approximately 9.249 s, tools/MCP/config approximately 8.7 s, orientation approximately 490 ms. The remaining dominant startup work is tools/MCP/config, not hooks. Event-loop lag values were redacted in captured output: no numerical smoothness claim is made. Installed-binary performance and cold/warm equivalence are not verified.

## Coverage
Required reviewers: review-logic and review-testing-practices (operator-selected changed-domain review). Both received targeted refill after NEEDS_CONTEXT; logic returned no findings; testing findings were repaired and independently rechecked, leaving TP-F03.
Stage counts: initial testing findings 2; repaired 2; retained final findings 1 minor; verifier-confirmed 0; verifier-refuted 0; unverified final findings 1. No separate findings-verifier was dispatched; mutation evidence is not mislabeled as verifier confirmation.
Not run: exhaustive repository suite, installed runtime benchmark, remote CI, focused shell/TUI completion boundary coverage. Broad health wrapper was incomplete due worktree binary discovery; direct root-installed tsc/eslint succeeded.
Flow stays in-progress and PR stays draft for additional fixes.

```json keryx:findings
[
  {
    "id": "TP-F03",
    "severity": "minor",
    "file": "src/commands/shell.ts",
    "line": 4268,
    "problem": "Shell and TUI startup trace completion wiring is not pinned by focused integration tests.",
    "impact": "Removing either completion call survives the nearest suite; diagnostics could silently stop flushing without a test failure. No runtime defect was demonstrated.",
    "suggested_fix": "Exercise actual shell and TUI startup completion boundaries and assert trace completion; rerun TP-M13 and TP-M14.",
    "evidence": "Independent final validation: TP-M13 shell suite 67 pass, TP-M14 TUI suite exit 0 with completion mutations applied. Also at src/tui/tui-shell.ts.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "blocking_merge": false
  }
]
```
