# PR 1003 — review round 2

- Review id: `2026-10-13-pr-1003-round2-1804c39d`
- Target: MrCipherSmith/keryx PR 1003, flow 441 T3b (turn-loop extraction + headless AC1 test)
- Orchestrator: `vantage-review` (generic engine: `review-orchestrator`, Keryx v1.11.0)
- Head reviewed: `1804c39d00ac3439f7bd451049d69e0a7f72dbb3`; merge-base `cf7d4e69375fdfd32a72db4ba26ee924260a59d5`; branch `feat/flow-441-t3b-headless-shell`
- Mode: all, deep round, mutation pass, severity-audit. Round 2 of 3 (the last round is the cap; after it verification is by mutation).
- Note: the reviewer subagent could not write this file (the harness refuses subagent Write of report.md). The parent assembled it from the hand-back text; the machine-readable block below is `findings.json` of this package, so the report and the ledger agree.

Verdict: request-changes

## Summary

Request changes, test pins only. No production defect was found. Behaviour of `tui-shell.ts` against the merge base is unchanged: the diff was read, and review-logic, review-regression, review-security-code and review-highload each independently returned no findings. The author's mutation claim reproduces: 42 of 42 killed on this head. The remaining weakness is that four changed shell sites and the recipient-choice idle predicate are pinned by presence of text, not by behaviour.

Counts: 0 blockers, 4 majors, 4 minors, 1 info. The four majors are minors that `keryx review severity-audit` raised mechanically, because each cites an executed surviving mutant on a changed file. Each is one missing needle or one missing assertion.

## Claims checked independently

- 42/42 killed: reproduced with `keryx review mutate` (8-file suite, baseline green): killed 42, survived 0, invalid 0 (`research-evidence/mutation-1.md`).
- Test count: exactly 20 in `turn-loop.test.ts`.
- Spec fidelity: the author's spec differs from round 1 only in 4 renamed anchors.
- Headers vs the modelled `runLine`: the boundary is stated honestly ("modelled `runLine`", "OpenTUI renderer is not mounted"). What is wrong is where the source-text pins live (F-005).
- Fresh mutants of this round: 35 across 4 specs; 22 killed, 12 survived, 1 invalid (N16 anchor error, redone as N16b). Survivors: N01, N02, N03, N10, N12, N14, N16b, N21, M08, P01, P02, P03. N12 and N14 are equivalent for current callers. M08 and N21 sit on text the PR did not change. P01, P02 and P03 came from the testing reviewer's claim; they were run and survive. Mutants M01 to M07 (the `createTurnLoop` inputs: paint, summarize, composer, `onDetachedFailure` text and `terminalSafe`, `runLine` origin) were killed.
- Behaviour preservation: push, paint and say order is unchanged at the four former push sites; `queued as qN` equals `queue.length` after the push; `source` is forwarded where it was and is absent at the recipient-choice site as before; no TDZ (`forceHandoff` is declared before `createTurnLoop`, everything else is a lazy closure); `bunx tsc --noEmit` exits 0; `bun test` over src/tui, shell-source-audits, product, shell-task-tools and bus: 2526 pass, 2 fail (`ci-triage-source.test.ts`, which the PR body says fails on the author's machine only; not compared with the merge base).

## Round 1 dispositions

| Round 1 | Disposition | Note |
|---|---|---|
| F-001 stale `mainQueue` comments | closed | No `mainQueue` or `mainQueueSeq` identifier in src/tui. One stale ownership sentence in main-queue.ts (F-009). |
| F-002 shell inputs unpinned | partial | Inputs pinned and killed, but headers misattribute (F-005). Four shell sites still unpinned (F-001..F-003 here). |
| F-003 replaceQueue/getQueue | closed | T14, T15, T16, S13 killed. |
| F-004 repaints | partial | T08, T13, N11 and N19 killed. Remote-wiring paint forwarding survives (F-004 here). |
| F-005 ids, positions, label split | closed | T05/T07/T07b/T10b/T17/T20/T21/N09/N13/N20 killed. |
| F-006 duplicate needle | closed | `remote.runQueued(` pinned once. A different duplication is F-007 here. |
| F-007 header | partial | Rewritten, still misattributes (F-005 here). |
| F-008 PR claims | closed | PR body corrected; its coverage file list still omits busy-dispatch and tui-shell tests (F-005 here). |
| F-009 idle predicate | partial, as declared | Renamed to `drainAfterRecipientChoice`; the predicate is still written twice. See Questions. |
| F-010 enqueueWhileBusy | partial | Documentation only (F-008 here). |
| F-011 readonly queue | closed | Typed `readonly`. |
| F-012 single nextId | closed | |
| F-013 harness shape | left (info) | As declared. |
| F-014 recipient-choice drain ignores detached work | left, pre-existing | Merge-base behaviour; belongs with PR 999 F-025/F-026. |

Regressions the round-1 fixes introduced: none in production code. In tests, the moved turn-loop.ts needles add coupling (F-007) and one stale comment pair (F-006).

## Findings by severity

### Blocker

none

### Major (all four raised by severity-audit; each cites an executed surviving mutant)

- **F-001** `src/tui/tui-shell.ts`: the `return` after `if (turnLoop.enqueueWhileBusy(...)) return;` is not pinned (mutant N01). Dropping it queues a slash command and also shows the refusal.
- **F-002** `src/tui/tui-shell.ts`: the lease-held `queued as q${position}` notices (two sites) and `sessionState.queued` are not pinned (N02, N03, N10).
- **F-003** `src/tui/main-queue.test.ts`: the recipient-choice idle predicate is pinned by five independent substring checks, so `&&` to `||` survives (P01, P02); `drainSites.onTurnSettle();` is pinned by a bare whole-file `toContain` in tui-bus.test.ts, so conditioning the call survives (P03).
- **F-004** `src/tui/turn-loop.ts`: forwarding of `paint: deps.paint` into `createRemoteQueueWiring` is not pinned (N16b); no test checks a repaint after `enqueueTelegramLine`.

### Minor

- **F-005** The turn-loop.ts header (lines 8-10), the turn-loop.test.ts header (10-12) and the PR body list name the wrong pinning files (the idle predicate is pinned in main-queue.test.ts, the busy deferred branch in busy-dispatch.test.ts, the lease-held branch in tui-hold.test.ts, the Force `replaceQueue` call in tui-shell.test.ts; remote-queue-wiring.test.ts pins only delegation counts).
- **F-006** The tui-hold.test.ts needle test is brittle (no `end > start` check, newline and indentation inside needles, slice not comment-stripped) and carries a stale comment pair and title.
- **F-007** `queue: () => queue,` of turn-loop.ts is pinned in three test files, plus other turn-loop.ts internals in busy-dispatch.test.ts; the behaviour tests already kill the same mutants.
- **F-008** `enqueueWhileBusy` and its boolean protocol are documented only in the interface comment (round 1 F-010 was a documentation-only fix).

### Info

- **F-009** About half of the 20 turn-loop tests repeat main-queue-drain.test.ts scenarios; two tests assert the same late-recipient-choice dispatch; the `createMainQueueDrain` doc in main-queue.ts still says "the shell and its test build the same wiring" and "the shell replaces its queue array"; the `drain` type is unnamed.

The full text of each finding (problem, impact, fix, evidence, quote) is in the machine-readable block below.

## Questions

1. The caller restates the three terms of `turnWorkInFlight` in the `drainAfterRecipientChoice` lambda (round 1 F-009, second half). review-architecture suggests `drainAfterRecipientChoice(extraGuard)` so the loop owns the in-flight terms. It is a design choice, not a defect, so no finding was raised.
2. Should `TurnLoop` expose `remote` and `drain` raw (review-architecture, info)? It is what the operator-chosen seam B needs, so not raised.

## Pre-existing (never blocks)

- Round 1 F-014, unchanged: the recipient-choice drain does not consult detached slash work. Belongs with PR 999 F-025 and F-026.
- Mutant M08 (the `mode` half of `sessionState`) and mutant N21 (the lease banner text in the held notice) survive; both lie on text the PR did not change.
- No cap on the main queue and an O(n) repaint per push (review-highload): unchanged, single-operator TUI.

## Verified clean

- Queue ownership: a single `queue` binding in `createTurnLoop`; `getQueue`, `setQueue`, `replaceQueue`, the drain's `queue: () => queue` and the `queue` getter all see it; `drainAfterRecipientChoice` reads it at call time. No PR 999 stale-queue class.
- Origin and source reach `remote.runQueued`; `terminalSafe` is kept in `onDetachedFailure`.
- No dependency cycle: only tui-shell.ts imports turn-loop.ts.
- The dispatched reviewers (logic, regression, security, highload) found no defect in the moved code.

## Not run

- review-style and review-performance were not dispatched as separate agents; their concerns were passed into the review-clean-code and review-highload dispatches (recorded as combined).
- Stack-excluded: review-backend, review-frontend, review-frontend-conventions. No matching paths: review-core-boundaries, review-flow-graph, review-layout.
- Scope B was capped at 40 retained files (100 dropped, 20 unresolved `.metaproject` entries).
- The mounted shell was not run; no unit test mounts OpenTUI.
- The full suite and lint were not rerun; review-regression ran tsc and the tui, bus, product and shell-source-audit tests. CI is 19/19 on this head.
- Cross-family review: not run.

## Metadata

- Orchestrator: `vantage-review`; generic engine `review-orchestrator` (`.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md`).
- Vantage overlays selected: none (scope A is src/tui/** TypeScript of a CLI, no React or MobX).
- Vantage rule files read: none.
- Reviewers run: review-logic, review-testing-practices, review-architecture, review-regression (scope B), review-clean-code (with style), review-highload (with performance), review-security-code, review-verifier. Verifier: 9 confirmed, 0 refuted (`verifications.json`).
- Stages: PR body vs diff agrees on structure, test count, mutation totals and dispositions; gaps are F-005 and F-009.

## Routing audit

graph_used: yes (review scope and blast-radius); wiki_used: no (not-relevant); ctx_used: yes; raw_rg_used: no.

## Findings (machine-readable)

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "vantage-review (mutation pass)",
    "severity": "major",
    "problem": "The return protocol of the shell's busy branch is not pinned. `if (turnLoop.enqueueWhileBusy(line, displayLine, command?.name, source)) return;` replaces an inline push, paint, say and return. Mutant N01 drops the `return` (the call stays, the line is queued, and the shell then falls through to its refusal transcript block as well). It survived the eight-file suite: turn-loop.test.ts drives a modelled runLine, and busy-dispatch.test.ts pins the call text but not the `return` that follows it.",
    "impact": "The one line the PR rewrote at the busy site is the one that decides queued-or-refused. A later edit that loses the `return` queues a slash command and also tells the operator it was refused, and no test fails.",
    "suggested_fix": "Pin the whole statement in busy-dispatch.test.ts (`if (turnLoop.enqueueWhileBusy(line, displayLine, command?.name, source)) return;` including `return;`), after the comment-stripping helper remote-queue-wiring.test.ts already uses.",
    "evidence": "mutant:N01-whileBusy-no-return",
    "confidence": "high",
    "file": "src/tui/tui-shell.ts",
    "quote": "if (turnLoop.enqueueWhileBusy(line, displayLine, command?.name, source)) return;",
    "pre_existing": false,
    "location_class": "changed",
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-2.json#N01-whileBusy-no-return"
    },
    "class_scope": {
      "sites": [
        "tui-shell.ts busy branch of runLine: `if (turnLoop.enqueueWhileBusy(...)) return;` (N01); the only call site of enqueueWhileBusy"
      ],
      "enumeration_method": "keryx ctx rg enqueueWhileBusy over src/tui (one non-test call site); mutation pass: N01 survived (mutation-2.json)."
    }
  },
  {
    "id": "F-002",
    "reviewer": "vantage-review (mutation pass)",
    "severity": "major",
    "problem": "Three shell sites that read the loop's queue length are unpinned. The two lease-held notices now take `position` from `turnLoop.enqueue`'s return value, and `sessionState.queued` reads `turnLoop.queue.length`; mutants N02 and N03 (`q${position}` -> `q1`) and N10 (`queued: 0`) survived. These were `mainQueue.length` reads in the merge base. The round 1 table covered the same count only inside turn-loop.ts (T21).",
    "impact": "The lease-held 'queued as qN' number and the Telegram `sessionState.queued` count are the user-visible output of the queue ownership this PR moved, and nothing asserts them at the shell.",
    "suggested_fix": "Pin `queued as q${position} (no side worker while held).`, `queued as q${position}.\\n` and `queued: turnLoop.queue.length` as source text in tui-hold.test.ts next to the existing held-lease needles.",
    "evidence": "mutant:N02-held-busy-notice-q1",
    "confidence": "high",
    "file": "src/tui/tui-shell.ts",
    "quote": "queued as q${position} (no side worker while held).",
    "pre_existing": false,
    "location_class": "changed",
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-2.json#N02-held-busy-notice-q1"
    },
    "class_scope": {
      "sites": [
        "tui-shell.ts lease-held busy notice `queued as q${position} (no side worker while held).` (N02)",
        "tui-shell.ts lease-held idle notice `queued as q${position}.` (N03)",
        "tui-shell.ts sessionState.queued reads turnLoop.queue.length (N10)"
      ],
      "enumeration_method": "mutation pass: N02, N03, N10 survived; the other shell-input mutants M01-M07 were killed (mutation-2.json)."
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "The recipient-choice idle predicate is pinned for the presence of five substrings only (main-queue.test.ts loops `expect(choice).toContain(guard)`). Mutants P01 (`!destroyed || !chrome.isBusy() && ...`) and P02 (`!forceHandoff.isAwaitingSettlement || leaseView()?.held() !== true`) keep every needle and survived. The same file pins `drainSites.onTurnSettle();` by a bare whole-file toContain (tui-bus.test.ts); mutant P03 (`if (Date.now() < 0) drainSites.onTurnSettle();`) survived. turn-loop.test.ts cannot reach either, because it passes its own `() => !h.busy` and calls `drain.onTurnSettle()` itself.",
    "impact": "The PR body says the shell inputs and call sites are pinned. That holds for presence, not for logic: a flipped operator in the only hand-written idle lambda, or a conditioned settle call, keeps all 20 headless tests and the needles green.",
    "suggested_fix": "Pin the predicate as one whitespace-normalised needle with its operators, and require the settle call to occur exactly once outside comments with no `if (`, `return` or `else` between the `suggestNextStep` guard and the call.",
    "evidence": "mutant:P01-idle-and-to-or-1",
    "confidence": "high",
    "file": "src/tui/main-queue.test.ts",
    "quote": "for (const guard of [\"!destroyed\", \"!chrome.isBusy()\", \"!foregroundOperation.isActive\", \"!forceHandoff.isAwaitingSettlement\", \"leaseView()?.held() !== true\"]) {",
    "pre_existing": false,
    "location_class": "changed",
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-5.json#P01-idle-and-to-or-1"
    },
    "class_scope": {
      "sites": [
        "main-queue.test.ts recipient-choice idle predicate presence loop (P01, P02)",
        "tui-bus.test.ts bare toContain of drainSites.onTurnSettle(); (P03)"
      ],
      "enumeration_method": "mutation pass: P01, P02, P03 survived (mutation-5.json); the same presence-loop shape was searched with keryx ctx rg over src/tui tests."
    }
  },
  {
    "id": "F-004",
    "reviewer": "vantage-review (mutation pass)",
    "severity": "major",
    "problem": "`paint: deps.paint` passed to createRemoteQueueWiring inside createTurnLoop is not pinned. Mutant N16b (a no-op) survived: createRemoteQueueWiring's own repaint is tested in remote-queue-wiring.test.ts against the factory, but no test checks that the loop forwards its paint to the wiring. turn-loop.test.ts's Telegram tests assert the queue and the run, not a repaint after `enqueueTelegramLine`.",
    "impact": "A Telegram-origin line would reach the queue without redrawing the queue panel after a refactor of the deps spread, and nothing fails.",
    "suggested_fix": "In turn-loop.test.ts, after `h.loop.remote.enqueueTelegramLine(...)` assert that `h.events` contains a `paint:<len>` entry for it, as the enqueue tests already do.",
    "evidence": "mutant:N16b-remote-paint-noop",
    "confidence": "high",
    "file": "src/tui/turn-loop.ts",
    "quote": "nextId,\n    paint: deps.paint,",
    "pre_existing": false,
    "location_class": "changed",
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-3.json#N16b-remote-paint-noop"
    },
    "class_scope": {
      "sites": [
        "turn-loop.ts createRemoteQueueWiring call: `paint: deps.paint` (N16b)"
      ],
      "enumeration_method": "mutation pass: N16b survived; the other deps forwarded into createRemoteQueueWiring and createMainQueueDrain were killed (mutation-3.json)."
    }
  },
  {
    "id": "F-005",
    "reviewer": "review-architecture, review-clean-code, review-testing-practices",
    "severity": "minor",
    "problem": "The coverage headers still point at the wrong files. turn-loop.ts lines 8-10 say the shell inputs, the idle predicate and the busy branch of runLine are 'pinned as source text in tui-hold.test.ts and remote-queue-wiring.test.ts'. The recipient-choice predicate is pinned only in main-queue.test.ts, the busy 'deferred' branch in busy-dispatch.test.ts, the lease-held branch in tui-hold.test.ts, the Force replaceQueue call in tui-shell.test.ts; remote-queue-wiring.test.ts pins only delegation counts. The turn-loop.test.ts header (lines 10-12) and the PR body list have the same gap. This is the F-007 pointer, only partly corrected.",
    "impact": "A maintainer who edits the idle predicate or the busy branch follows the header to a test file that does not pin it.",
    "suggested_fix": "Name each pin where it lives, or cut the list to 'the sibling *.test.ts files (tui-hold, busy-dispatch, main-queue, tui-bus, tui-shell, remote-queue-wiring)'. Fix the PR body list the same way.",
    "evidence": "keryx ctx rg over src/tui tests: the five idle guards appear in main-queue.test.ts:164 only; tui-hold.test.ts:132 holds turnWorkInFlight only",
    "confidence": "high",
    "file": "src/tui/turn-loop.ts",
    "quote": "they are pinned as source text in tui-hold.test.ts and remote-queue-wiring.test.ts",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "F-006",
    "reviewer": "review-testing-practices, review-clean-code",
    "severity": "minor",
    "problem": "The tui-hold.test.ts needle test that pins the shell's inputs to createTurnLoop is brittle and its comments are stale. The slice `source.slice(loop, source.indexOf(\"\\n    });\", loop))` has no `end > start` check (a missing terminator widens the slice to nearly the whole file, as -1 does for slice), two needles embed exact newlines and indentation, the slice is not comment-stripped, and the title and two comment lines still describe the removed structure ('the shell builds the same factory the behaviour test builds', title 'behaviour: main-queue-drain.test.ts').",
    "impact": "The test goes red on a prettier change and can go green when the pinned thing is only commented out; the comment tells the reader the shell builds createMainQueueDrain, which it no longer does.",
    "suggested_fix": "Assert the slice end is found (as tui-bus.test.ts:702 does), split or normalise the multi-line needles, strip comments, delete the 'Flow 441 (F-002/F-003)' lines and fix the title.",
    "evidence": "tui-hold.test.ts 115-164 read by review-clean-code and review-testing-practices",
    "confidence": "medium",
    "file": "src/tui/tui-hold.test.ts",
    "quote": "const loopBody = source.slice(loop, source.indexOf(\"\\n    });\", loop));",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "F-007",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "The needle `queue: () => queue,` of turn-loop.ts is asserted in three files (tui-hold.test.ts, busy-dispatch.test.ts, tui-shell.test.ts), and busy-dispatch.test.ts also pins `deferredBusyAction(line, commandName) !== \"queue\"` and `queuedCommandNotice(position)` inside turn-loop.ts. These were shell needles that moved with the extraction; they now pin the module's own spelling that the 20 behaviour tests already kill (mutants T01, T09, T10, T14, T16 in mutation-1).",
    "impact": "Renaming a local or inlining the getter fails three or four unrelated files with no behaviour change.",
    "suggested_fix": "Keep one pin on what tui-shell.ts passes into createTurnLoop and calls on it; drop the turn-loop.ts-internal needles from busy-dispatch.test.ts and tui-shell.test.ts.",
    "evidence": "git diff cf7d4e69 1804c39d -- src/tui, hunks in the three test files",
    "confidence": "medium",
    "file": "src/tui/busy-dispatch.test.ts",
    "quote": "expect(readFileSync(join(import.meta.dir, \"turn-loop.ts\"), \"utf8\")).toContain(\"queue: () => queue,\");",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "F-008",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "problem": "F-010 of round 1 is closed by documentation only. `enqueueWhileBusy` is the gated slash-command path whose boolean means 'queued, the caller returns' or 'refused'; the name does not say so, and `line` and `displayLine` are adjacent strings that a swap would not break at type level (the refusal test passes the same value for three parameters).",
    "impact": "A reader of `if (turnLoop.enqueueWhileBusy(...)) return;` must open the interface to learn what `false` means. This is also the line F-001 shows to be unpinned.",
    "suggested_fix": "Rename for the contract (for example `tryQueueDeferredCommand`), or return `\"queued\" | \"refused\"`. If the name stays, the doc comment is an acceptable, recorded trade-off.",
    "evidence": "turn-loop.ts 47-52 and 104-109; turn-loop.test.ts line 182",
    "confidence": "medium",
    "file": "src/tui/turn-loop.ts",
    "quote": "enqueueWhileBusy(line: string, displayLine: string, commandName: string | undefined, source?: QueuedMainQuestion[\"source\"]): boolean;",
    "pre_existing": false,
    "location_class": "changed"
  },
  {
    "id": "F-009",
    "reviewer": "review-testing-practices, review-clean-code",
    "severity": "info",
    "problem": "Overlap and stale ownership notes. (a) About half of the 20 turn-loop tests (compact then question, chain of slash commands, forced first, detached resolve and reject, empty drain settles) re-run scenarios main-queue-drain.test.ts already drives through the same createMainQueueDrain; what is new is the enqueue side, the shared-queue wiring and drainAfterRecipientChoice. Two tests (turn-loop.test.ts lines 215 and 326) assert the same late-recipient-choice dispatch. (b) The doc of createMainQueueDrain in main-queue.ts still says 'so the shell and its test build the same wiring' and 'the shell replaces its queue array', though turn-loop.ts now builds the factory and owns the swap. (c) `drain` is typed `ReturnType<typeof createMainQueueDrain<QueuedMainQuestion>>` and main-queue.ts exports no named type for it.",
    "impact": "The PR body's Covered list makes the coverage gain look larger than it is; the main-queue.ts doc tells a second ownership story one screen below a header this PR corrected.",
    "suggested_fix": "Say in the PR body and the test header that the drain-side scenarios repeat main-queue-drain.test.ts; reword the createMainQueueDrain doc; optionally export `MainQueueDrain<T>`.",
    "evidence": "main-queue-drain.test.ts:1-170 against turn-loop.test.ts:107-231; main-queue.ts 238-248",
    "confidence": "medium",
    "file": "src/tui/turn-loop.test.ts",
    "quote": "test(\"the recipient choice after the turn already settled runs the line at once\", () => {",
    "pre_existing": false,
    "location_class": "changed"
  }
]
```
