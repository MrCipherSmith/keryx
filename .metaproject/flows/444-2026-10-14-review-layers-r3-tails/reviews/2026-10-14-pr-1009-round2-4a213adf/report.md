# PR 1009 — review round 2

**Verdict: mergeable once the round-2 fixes are in.** No blocker and no major in the code; three minor test gaps (mutation survivors) and one usage-text omission. The round-1 dispositions match the code and the two reviewer-input schema copies are byte-equal.

Evidence level: ran — bun test (focused suite, 167 pass), mutation pass of 11 mutants

## Summary

Head `4a213adf62eaceb66afba7f65c3b138112071568`, merge base `060701ca`. Review id `2026-10-14-pr-1009-round2-4a213adf`, mode all, flow 444.

Findings: 4 filed, all minor (R2-00, R2-01, R2-02, R2-03). Mutation pass: 11 mutants, 8 killed, 3 survived (R2-00, R2-01, R2-02). Evidence: `research-evidence/mutation-1.md`.

Question, not filed: AC1 names a "recover" phase; the signal test phase "the sweep that follows the lock" approximates it.

### R2-00 — minor — src/tui/review-layers-actions.ts

**Problem.** A refresh child killed for exceeding maxBuffer is classified as a timeout by wall clock only. Replacing the line with `const timedOut = true;` leaves the focused suite green (mutant r2-maxbuffer-misreported-as-timeout survived). Under Bun a maxBuffer overflow does not set `killed`, so the "too much output" message was unreachable and the operator saw the raw `stdout maxBuffer length exceeded`.

**Impact.** Trigger: a refresh that prints more than 16 MiB. Outcome: the TUI reports a timeout or an engine string instead of the intended "printed more output than the limit allows" message; no test notices.

**Suggested fix.** Treat a maxBuffer error as its own case independent of `killed`, and pin it with a child that floods stdout.

**Evidence.** Mutation pass at head: r2-maxbuffer-misreported-as-timeout survived (research-evidence/mutation-1.md). Source: review-layers-actions.ts:54-56.

### R2-01 — minor — src/review/layers.ts

**Problem.** The 5 s bound on signal cleanup is untested. Removing the race (`settled` alone) leaves every test green (mutant r2-signal-bound-removed survived), because no test has a cleanup that never returns.

**Impact.** Trigger: a hung `git worktree remove` at SIGINT/SIGTERM. Outcome without the bound: the process never dies by the signal and the lock stays; the regression the bound was added to prevent would pass CI.

**Suggested fix.** Add a signal test whose checkout removal hangs and assert the process still ends by the signal and the lock is gone within the bound.

**Evidence.** Mutation pass at head: r2-signal-bound-removed survived. Source: layers.ts:363-373.

### R2-02 — minor — src/review/layers-view.ts

**Problem.** The failed-graph retry hint printed by layersDetailLines has no test. Dropping the whole suffix leaves the suite green (mutant r2-view-failed-hint-dropped survived).

**Impact.** Trigger: a later edit of the line. Outcome: the operator loses the only pointer to `refresh --force` after a failed build, unnoticed.

**Suggested fix.** Assert the hint on a failed graph and its absence on other statuses.

**Evidence.** Mutation pass at head: r2-view-failed-hint-dropped survived. Source: layers-view.ts:37.

### R2-03 — minor — src/commands/review.ts

**Problem.** The main usage text still lacks `--force` on the `layers block` line, while printLayersHelp, the flag allow-list and docs/cli-reference.md accept it.

**Impact.** Trigger: `keryx review --help`. Outcome: the flag is accepted but not listed in the main help.

**Suggested fix.** Add `[--force]` to the usage line.

**Evidence.** Source: review.ts:4247 against review-layers.ts:137 (`force: rest.includes("--force")`).

## Structured findings

```json keryx:findings
[
  {
    "confidence": "high",
    "id": "R2-00",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/review-layers-actions.ts",
    "quote": "const timedOut = Date.now() - startedAt >= timeoutMs - 100;",
    "problem": "A refresh child killed for exceeding maxBuffer is classified as a timeout by wall clock only. Replacing the line with `const timedOut = true;` leaves the focused suite green (mutant r2-maxbuffer-misreported-as-timeout survived). Under Bun a maxBuffer overflow does not set `killed`, so the \"too much output\" message was unreachable and the operator saw the raw `stdout maxBuffer length exceeded`.",
    "impact": "Trigger: a refresh that prints more than 16 MiB. Outcome: the TUI reports a timeout or an engine string instead of the intended \"printed more output than the limit allows\" message; no test notices.",
    "suggested_fix": "Treat a maxBuffer error as its own case independent of `killed`, and pin it with a child that floods stdout.",
    "evidence": "Mutation pass at head: r2-maxbuffer-misreported-as-timeout survived (research-evidence/mutation-1.md). Source: review-layers-actions.ts:54-56.",
    "class_scope": {
      "sites": [
        "src/tui/review-layers-actions.ts:54"
      ],
      "enumeration_method": "One classification site."
    }
  },
  {
    "confidence": "high",
    "id": "R2-01",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/review/layers.ts",
    "quote": "Promise.race([settled, bound])",
    "problem": "The 5 s bound on signal cleanup is untested. Removing the race (`settled` alone) leaves every test green (mutant r2-signal-bound-removed survived), because no test has a cleanup that never returns.",
    "impact": "Trigger: a hung `git worktree remove` at SIGINT/SIGTERM. Outcome without the bound: the process never dies by the signal and the lock stays; the regression the bound was added to prevent would pass CI.",
    "suggested_fix": "Add a signal test whose checkout removal hangs and assert the process still ends by the signal and the lock is gone within the bound.",
    "evidence": "Mutation pass at head: r2-signal-bound-removed survived. Source: layers.ts:363-373.",
    "class_scope": {
      "sites": [
        "src/review/layers.ts:369"
      ],
      "enumeration_method": "One bounded wait in withSignalCleanup."
    }
  },
  {
    "confidence": "high",
    "id": "R2-02",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/review/layers-view.ts",
    "quote": "not retried automatically for a few minutes at the same head",
    "problem": "The failed-graph retry hint printed by layersDetailLines has no test. Dropping the whole suffix leaves the suite green (mutant r2-view-failed-hint-dropped survived).",
    "impact": "Trigger: a later edit of the line. Outcome: the operator loses the only pointer to `refresh --force` after a failed build, unnoticed.",
    "suggested_fix": "Assert the hint on a failed graph and its absence on other statuses.",
    "evidence": "Mutation pass at head: r2-view-failed-hint-dropped survived. Source: layers-view.ts:37.",
    "class_scope": {
      "sites": [
        "src/review/layers-view.ts:37"
      ],
      "enumeration_method": "One line; the other projections print the summary line only."
    }
  },
  {
    "confidence": "high",
    "id": "R2-03",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "src/commands/review.ts",
    "quote": "--files a,b [--max-bytes <n>] [--json]",
    "problem": "The main usage text still lacks `--force` on the `layers block` line, while printLayersHelp, the flag allow-list and docs/cli-reference.md accept it.",
    "impact": "Trigger: `keryx review --help`. Outcome: the flag is accepted but not listed in the main help.",
    "suggested_fix": "Add `[--force]` to the usage line.",
    "evidence": "Source: review.ts:4247 against review-layers.ts:137 (`force: rest.includes(\"--force\")`).",
    "class_scope": {
      "sites": [
        "src/commands/review.ts:4247"
      ],
      "enumeration_method": "Compared the three places that list the layers flags."
    }
  }
]
```
