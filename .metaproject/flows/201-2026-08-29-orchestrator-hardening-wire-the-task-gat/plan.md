# Plan

## Approach

Four independent changes, ordered so that each is separately revertable. Nothing
here needs the others to land first, which is deliberate: if one turns out to be
wrong it comes out on its own.

### 1. The task gate (roadmap 0.1 + 0.2)

Add a fifth gate to `complete()` in `src/flow/service.ts`, calling the existing
`taskGateStatus()` from `src/flow/machine.ts:40`. Delete the false assertion in
`flow-orchestrator/SKILL.md` (~line 173) **in the same commit** — a doc promising
a safety property that does not exist is what let those 34 tasks through, so the tree
must not spend a single commit in a state where the doc is knowingly wrong.

**Two decisions this forces, neither of which may be made silently:**

- **Historical flows.** Turning the gate on retroactively invalidates 24
  completed flows (34 unfinished tasks between them). Gate on `schemaVersion: 2` or an opt-in config key so a
  version bump does not rewrite history.
- **`skipped` disposition.** Today a `skipped` task would pass the gate. It
  should not, unless the skip carries a recorded reason. Decide explicitly and
  write the decision into the flow journal.

### 2. Dead surface (roadmap 0.3)

Four deletions, no design: `--greptile` routes nowhere; `src/**/*.ts` →
`review-frontend-conventions` fires the frontend reviewer on every keryx review
in a repo with no frontend; `FAILED` is in the status enum but no worker can
emit it (`task-implementer` maps `failed → BLOCKED`, and the protocol document
is titled "The Four Statuses"); the legacy-profile prompt fires every review for
profiles that cannot be normalised.

### 3. Round-trip-safe review record (roadmap 1.1)

Emit and consume a structured findings array. `findings.json` must validate
against `review-finding.schema.json`. Keep the Markdown parser for legacy
reports only — deleting it would strand existing artifacts.

This is the one item with real design content, because it is the prerequisite
for phases 2, 4 and 5. Getting the shape wrong here is expensive later.

### 4. Attempt counters (roadmap 1.2 + 1.3)

`keryx flow task attempt <id> <Tn> --outcome started|failed|blocked` writing to
the existing `attempts: {count, log}` field in `src/flow/types.ts:27`. Then port
`job-orchestrator`'s §0.0 State Resumption Check into `flow-orchestrator`
Phase 0, since the input contract already declares `mode: "resume"` with no
procedure behind it.

## Trade-offs

**Gate on schemaVersion rather than repairing history.** The alternative —
back-filling task statuses on 24 old flows — would mean writing flow state by
hand for packages nobody will reopen, and would destroy the very audit trail
that made the leak visible. The leak is evidence; keep it.

**Keep the Markdown parser.** Deleting it is cleaner and would strand every
existing review artifact. Legacy-read, structured-write.

**Four separate commits, not one.** Slower to land, but item 3 is the one most
likely to need revision, and it must not drag the other three back out with it.

## Verification

Each item below is also a task, because a verification step written only in a
plan blocks nothing — which is the same failure this flow exists to fix.

- The task gate is exercised by a test that completes a flow with an open task
  and asserts failure, not by reading the code.
- The round-trip is exercised by writing a round-1 artifact and constructing a
  round-2 input from it, asserting schema validity — the exact operation that is
  impossible today.
- The attempt counter is exercised across a simulated resume, since a counter
  that survives only within one process is the bug, not the fix.
