# Review round — flow 263 P0 (supervised shell tasks with a bounded yield)

Target: PR #563, head `c0940dece8cf787b7a0b3c6717a3b4266db3e10d`, base `main`.

Three passes ran over the branch diff:

- **review-testing-practices** (dispatched reviewer) — seven findings, F-001…F-007,
  all fixed on the branch before merge.
- **orchestrator-logic** — run directly after the dispatched logic reviewer stalled
  twice with an empty transcript. No blocker or major; two accepted minors recorded
  as L-001 and L-002 so they are not rediscovered later as defects.
- **orchestrator-blast-radius** — same reason. No code consumer left on the old
  contract; one documentation finding, B-001.

What the logic pass checked and found sound: every kill path funnels through one
idempotent request, so a task emits exactly one terminal event carrying one reason;
`waitForExit` resolves immediately for a finished task, never kills on timeout, and
clears and unrefs its timer; the idle timer is re-armed on every output chunk and is
unrefed; the concurrency cap counts background-phase tasks only and `promote` never
kills, leaving the hard bound at `maxConcurrent + 1`; the approval gate, sandbox and
env resolution, process-group kill and session sweep are untouched.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/interactive-agent-tools.ts",
    "line": 184,
    "problem": "The session task registry is passed into shellExecTool as a positional argument that no test observes; the only pin matched the token 'jobRegistry' in the source text of the two shell.ts call sites, which 'jobRegistry: undefined' would also satisfy.",
    "impact": "Dropping that argument reverts every shell_exec to the blocking synchronous runner — the exact incident this phase exists to remove — while the whole suite stays green, because no assertion observes the supervised behaviour through the built roster.",
    "suggested_fix": "Build the tool list through buildInteractiveAgentTools with a stub registry that reports a still-running task, then assert shell_exec returns a task_id handle rather than a synchronous result.",
    "evidence": "src/commands/shell-task-registry-wiring.test.ts:37 matches the token only; src/commands/interactive-agent-tools.test.ts:253 asserts tool NAMES, not behaviour.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/interactive-agent-tools.ts:184 — the only shellExecTool construction; its registry argument had no behavioural test (this finding)",
        "src/commands/shell.ts:2212 — TUI session supplies the registry; pinned by source text only",
        "src/commands/shell.ts:2510 — readline session supplies the registry; pinned by source text only"
      ],
      "enumeration_method": "keryx ctx rg 'shellExecTool\\(' src and 'buildInteractiveAgentTools\\(' src over non-test sources: shell_exec is constructed in exactly one place, fed from exactly two production call sites. Each site was then checked for a test observing the resulting behaviour rather than the argument text."
    },
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "The new behaviour test in interactive-agent-tools.test.ts drives the built roster's shell_exec against a registry stub reporting a running task and asserts the task_id handle; removing the registry argument from interactive-agent-tools.ts:184 makes it fail.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Commit 09e820f816b55e63c2784d8f6d237889f6c79c02 ('test(shell): harden the flow-263 tests against the review findings') adds the behaviour-level wiring test in src/commands/interactive-agent-tools.test.ts."
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/harness/tool/builtin/background-job-registry.test.ts",
    "line": 1069,
    "problem": "Timing assertions run with margins under 5x: a 150 ms idle window against 40 ms ticks, a 400 ms window against real 100 ms ticks plus spawn jitter, and an absolute 250 ms bound on a foreground start measured against a 400 ms buffer.",
    "impact": "One GC pause or a loaded runner fails these tests on correct code, and the failure reads as 'the idle reset regressed' — the most expensive kind of false alarm, because the next person changes working code to chase it.",
    "suggested_fix": "Raise the idle windows an order of magnitude above the tick gap so the reset is still required, and assert the start-buffer test as a relation between the two starts instead of an absolute wall-clock bound.",
    "evidence": "background-job-registry.test.ts:1069 (150 ms vs 40 ms ticks), :1113 (400 ms vs real 100 ms ticks), :797 (fgElapsed < 250 against initialBufferMs 400).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/tool/builtin/background-job-registry.test.ts:1069 — 150 ms idle window against 40 ms ticks (3.75x)",
        "src/harness/tool/builtin/background-job-registry.test.ts:1113 — 400 ms idle window against real 100 ms ticks (4x)",
        "src/harness/tool/builtin/background-job-registry.test.ts:797 — foreground start under an absolute 250 ms against a 400 ms buffer",
        "src/harness/tool/builtin/shell-exec-background.test.ts:410 — real idle kill, 400 ms window inside an 8 s yield (20x, accepted)",
        "src/harness/tool/builtin/shell-exec-background.test.ts:127 — background:true returns under 2 s against a never-exiting fake (accepted)"
      ],
      "enumeration_method": "Every timing-dependent assertion in the files this branch touches was enumerated by reading them for performance.now(), delay(), idleMs and initialBufferMs: background-job-registry.test.ts, shell-exec-background.test.ts, shell-exec-tool.test.ts, background-job-session.test.ts, shell-task-registry-wiring.test.ts. The remaining files carry no wall-clock assertion."
    },
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Each listed site was read at the named line and carries the margin stated; the two accepted sites were kept and annotated rather than changed.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Commit 09e820f816b55e63c2784d8f6d237889f6c79c02: idle windows widened to 2 s, and the start-buffer test now asserts fgElapsed < bgElapsed / 2 instead of an absolute bound."
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/harness/tool/builtin/background-job-registry.test.ts",
    "line": 405,
    "problem": "The grandchild kill test waits a fixed 500 ms and then probes liveness once.",
    "impact": "Under load the OS can take longer than that slack to reap, so the test fails on a kill that worked.",
    "suggested_fix": "Poll to a deadline, as the AC6 sibling in shell-exec-background.test.ts already does.",
    "evidence": "background-job-registry.test.ts:405 setTimeout(500) followed by a single process.kill(pid, 0) probe.",
    "confidence": "high",
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Read at the named line: one fixed sleep, one probe, no retry.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Commit 09e820f816b55e63c2784d8f6d237889f6c79c02: the grandchild liveness probe now polls to a 10 s deadline."
    }
  },
  {
    "id": "F-004",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/harness/tool/builtin/background-job-registry.test.ts",
    "line": 358,
    "problem": "The same test has no try/finally around its real processes.",
    "impact": "Any failed assertion before the kill leaves two real `sleep 100` processes running for 100 seconds and never sweeps the registry.",
    "suggested_fix": "Wrap the body in try/finally, kill the captured grandchild pid and sweep the registry in the finally.",
    "evidence": "background-job-registry.test.ts:358-418 had no finally block; its AC6 sibling at shell-exec-background.test.ts:484 is the model.",
    "confidence": "high",
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Read at the named lines: no finally block existed in that test body.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Commit 09e820f816b55e63c2784d8f6d237889f6c79c02: try/finally added around the real-process body, with a cleanup kill of the captured grandchild pid and sweepAll."
    }
  },
  {
    "id": "F-005",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/background-job-session.test.ts",
    "line": 369,
    "problem": "A killed task's killReason is passed into the exit event but only the status is asserted; nothing checks the field reaches the entry or the Meta view.",
    "impact": "The reason could be dropped anywhere between event and view without a test noticing — and telling an operator kill from an idle kill is the whole point of splitting the killed status by reason.",
    "suggested_fix": "Assert killReason on the stored entry and in formatJobMeta's output.",
    "evidence": "background-job-session.test.ts around the killed-status test: EXIT(..., { killReason: 'idle' }) followed only by a status assertion.",
    "confidence": "high",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "The added test asserts entry.killReason and formatJobMeta output; dropping killReason from the store's exit branch makes it fail.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Commit 09e820f816b55e63c2784d8f6d237889f6c79c02: the AC4/AC8 killReason test was added to src/tui/background-job-session.test.ts."
    }
  },
  {
    "id": "F-006",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/harness/tool/builtin/background-job-registry.test.ts",
    "line": 1143,
    "problem": "An elapsed-time upper bound is asserted after pollUntil has already returned true within that same bound.",
    "impact": "The assertion cannot fail, so it reads as coverage of the idle rail's timing while proving nothing.",
    "suggested_fix": "Replace it with a lower bound proving the kill waited out the silence rather than firing on sight.",
    "evidence": "background-job-registry.test.ts:1143 expect(performance.now() - t0).toBeLessThan(8_000) after pollUntil(..., 8_000) returned true.",
    "confidence": "high",
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Read at the named line: the bound duplicates the poll deadline that already succeeded.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Commit 09e820f816b55e63c2784d8f6d237889f6c79c02: the redundant upper bound was replaced by expect(elapsed).toBeGreaterThanOrEqual(idleMs)."
    }
  },
  {
    "id": "F-007",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/harness/tool/builtin/shell-exec-tool.ts",
    "line": 394,
    "problem": "Two branches had no test: the 'task is no longer tracked' result, and the user-facing idle-kill message, which was proven only by a real-process test that skips on win32.",
    "impact": "An eviction between start and the post-wait read could fall through to a success-shaped result unnoticed, and the idle message has zero coverage on any platform where the real-process test skips.",
    "suggested_fix": "Cover both with scripted fakes so they run everywhere.",
    "evidence": "shell-exec-tool.ts:394 unknown/undefined-info branch; shell-exec-background.test.ts:410 describe.skipIf(win32) was the only proof of the message.",
    "confidence": "high",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "The added scripted-fake tests assert the idle message names both escapes and that a vanished task reports 'no longer tracked' with isError true; they run on every platform.",
      "verifier": "orchestrator"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Commit 09e820f816b55e63c2784d8f6d237889f6c79c02: the 'idle kill and lost-task results (fakes, every platform)' block was added to src/harness/tool/builtin/shell-exec-background.test.ts."
    }
  },
  {
    "id": "L-001",
    "reviewer": "orchestrator-logic",
    "severity": "info",
    "file": "src/harness/tool/builtin/background-job-registry.ts",
    "line": 765,
    "problem": "promote() flips phase and emits its one phase event even for a task that exited during the yield, because it does not re-check the status first.",
    "impact": "A phase event can be emitted for an already-terminal task.",
    "suggested_fix": "None taken: the TUI store drops a task that exited while still pending and keeps it dropped, so a late phase event lists nothing.",
    "evidence": "background-job-registry.ts promote() has no status guard before emitting; src/tui/background-job-session.ts drops pending entries on exit and ignores a later phase for a dropped id.",
    "confidence": "high",
    "disposition": {
      "state": "dismissed-wont-fix",
      "evidence": "Recorded as an accepted minor in .metaproject/flows/263-2026-09-15-background-task-execution-p0-every-shell/journal.md under the orchestrator logic review."
    }
  },
  {
    "id": "L-002",
    "reviewer": "orchestrator-logic",
    "severity": "info",
    "file": "src/harness/tool/builtin/background-job-registry.ts",
    "line": 142,
    "problem": "Retained bytes per terminated task are now the 4 KB ring tail plus the new 24 KB head snapshot, which the exit-time shrink deliberately does not touch.",
    "impact": "Per-task retention grew from 4 KB to about 28 KB; with the 50-task LRU bound the worst case is roughly 1.4 MB per session.",
    "suggested_fix": "None taken: the growth is bounded by the same LRU and is what makes a short command's synchronous result capped from the START rather than the tail.",
    "evidence": "TASK_OUTPUT_HEAD_BYTES = 24_000 alongside TERMINATED_OUTPUT_TAIL_BYTES = 4_000 and MAX_TRACKED_JOBS = 50.",
    "confidence": "high",
    "disposition": {
      "state": "dismissed-wont-fix",
      "evidence": "Documented in the constant's doc comment and in the flow journal as an accepted trade-off."
    }
  },
  {
    "id": "B-001",
    "reviewer": "orchestrator-blast-radius",
    "severity": "minor",
    "file": ".metaproject/wiki/architecture/background-jobs.md",
    "line": 15,
    "problem": "Project documentation still describes backgrounding as an opt-in flag with a wall-clock deadline and 'exited' status.",
    "impact": "A reader following the wiki would use a contract the code no longer has.",
    "suggested_fix": "Mark the page superseded in part with a summary of what changed, and schedule the rewrite with the rest of the documentation sweep.",
    "evidence": "keryx ctx rg over docs and .metaproject found the stale contract in .metaproject/wiki/architecture/background-jobs.md and docs/verification/keryx-shell-tui-test-catalog.md rows TOOL-11 and BGJOB-01..03; no non-test source still uses the old statuses, ids or env deadline, and all five sweep call sites are intact.",
    "confidence": "high",
    "disposition": {
      "state": "dismissed-deprioritised",
      "evidence": "decided-by: MrCipherSmith (repository owner), 2026-09-16, asked and answered explicitly during this flow: the documentation rewrite is deliberately deferred to phase P3 rather than done here. Partially addressed meanwhile — commit c0940dece8cf787b7a0b3c6717a3b4266db3e10d marks .metaproject/wiki/architecture/background-jobs.md superseded in part with a summary of what changed — while the full rewrite and the stale rows TOOL-11 and BGJOB-01..03 in docs/verification/keryx-shell-tui-test-catalog.md remain open, scheduled as phase P3 in docs/requirements/keryx-background-task-execution/. Recorded as deprioritised rather than fixed because the class this finding names is not closed."
    }
  }
]
```

## Round summary

F-001…F-007 were all fixed on this branch before merge; B-001 was partially acted
on (banner now, rewrite in P3); L-001 and L-002 are accepted as designed and
recorded in the flow journal. Re-run after the fixes: 109 pass / 0 fail across the
five affected files, `bun run typecheck` clean, full suite 10 297 pass / 0 fail.
