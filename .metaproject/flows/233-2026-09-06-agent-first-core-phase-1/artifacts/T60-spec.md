# T60 — spec: make a `warn` completion distinguishable from a genuine pass in the STORED record and the PUBLISHED comment (T57 F-001)

## Defect (from `T57-review.md` F-001, reproduced pre-fix with the reviewer's own probe)

T56 correctly closed the `incomplete`/unrecognized half of the completion
fold (they now block, `src/flow/service.ts:992-1008`,
`healthGateOutcome`). T56 also decided, with a defensible argument this task
does not reopen, that `warn` still completes (`GateOutcome.status: "pass"`,
`detail: "health gate: warn"`). What T56 got wrong is the claim that this
`detail` keeps the *stored* record distinguishable. It does not: `detail`
lives only on the in-memory `GateOutcome` returned from `complete()`. The two
durable/published surfaces never read it on the passing path:

- `flow.json` history: `transition(cwd, dir, flow, "done", "done", "all
  gates passed")` (`service.ts:667`, pre-fix) — a fixed string, no per-gate
  detail at all.
- `buildIssueComment` (`service.ts:1089-1101`, pre-fix): `` `${gate.name}:
  ${gate.status}` `` per gate — reads `status`, never `detail`. `status` is
  `"pass"` for both a clean pass and a warn.

Reproduced pre-fix with the reviewer's own probe,
`bun .metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts/T57-flow.ts`,
row C99, against the real `complete()` pipeline, reading `flow.json` back off
disk (not the return value):

```
{"label":"C99 stored flow record: genuine pass vs warn",
 "storedRecordsIdentical":true,
 "issueCommentsIdentical":true,
 "issueCommentHealthLinePass":"- Gates: ... health: pass",
 "issueCommentHealthLineWarn":"- Gates: ... health: pass",
 "storedRecordContainsWarnWord":false}
```

Raw: `.metaproject/data/gdctx/raw/T60-probe-before.log` (this session's
pre-fix re-run of the reviewer's own instrument, byte-identical claim
re-verified below in "Verification plan").

## What this task does NOT change

- The pass/fail fold: `gates.every((gate) => gate.status !== "fail")`
  (`:659`) — untouched. A `warn` completion still completes; an `incomplete`
  or unrecognized completion still blocks (T56, unchanged, not reopened).
- `GateOutcome`'s type (`src/flow/types.ts:195-206`,
  `status: "pass" | "fail" | "skipped"`) — untouched. `src/flow/types.ts` is
  outside this task's file ownership, and widening it to a 4th `"warn"`
  member (finding F-001's suggested option (b)) has a concrete external
  reader that would misrender: `src/commands/flow.ts:578-584` picks the
  terminal mark by `gate.status === "pass" ? green : gate.status ===
  "skipped" ? gray : red` — a `"warn"` value would fall into the `red`
  ("failed") branch, painting a completed flow's health row as a hard
  failure. That file is not in this task's ownership ("Nothing else. If the
  fix needs a change elsewhere, stop and reply STATUS: BLOCKED"), so option
  (b) is not available without a change outside scope. Chosen instead: keep
  `status: "pass"` for `warn` (matches T56's own, undisputed, decision) and
  fix what actually gets persisted/published.
- `healthGateOutcome` (`:992-1008`) — untouched. It already computes the
  correct, leak-safe `detail` (`"health gate: warn"` vs `"health gate:
  pass"`, an exhaustive switch over a closed vocabulary, T56). The defect is
  that nothing downstream reads that `detail` on the pass path — not that
  the `detail` itself is wrong.
- Any gate other than `health`. Enumerated below.

## Reader enumeration (what depends on the two surfaces this task touches)

**Method:** `bun src/cli.ts ctx rg` over the exact strings/symbols this task
touches, each match read.

1. `"all gates passed"` (the pre-fix constant `transition` detail) —
   `bun src/cli.ts ctx rg -n "all gates passed" src` → exactly one hit,
   `service.ts:667`, the site itself. No test or other file matches this
   literal string (`bun src/cli.ts ctx rg -n "all gates passed"
   src/flow/service.test.ts src/flow/security-gate.test.ts` → 0 matches). No
   reader depends on this exact text.
2. `flow.history` (what the "done" transition's detail becomes part of) —
   `bun src/cli.ts ctx rg -n "\.history\b" src/commands/flow.ts
   src/flow/service.test.ts src/flow/store.ts` → three sites:
   - `src/commands/flow.ts:334-337` (`flow status` command) — prints
     `` `${event.at} ${event.event}${event.detail ? \`: ${event.detail}\` :
     ""}` `` generically, for any event/detail pair. Appending more text to
     an existing `detail` string is compatible; nothing here parses the
     string's shape.
   - `src/flow/store.ts:150` — `migrateTask(task, flow.createdAt, flow.history
     ?? [])`, used for legacy task-attempt inferral from history *events*
     (`event.event`, e.g. `"task-done"`), never `event.detail`. Unaffected.
   - `src/flow/service.test.ts:225` — asserts
     `event.event === "completion-failed"` (the FAILING path's event name,
     untouched by this task). Unaffected.
   No reader parses or depends on the literal content of the `"done"` event's
   `detail` string.
3. `buildIssueComment`'s output (`result.issueComment`) —
   `bun src/cli.ts ctx rg -n "issueComment" src` → `src/flow/service.ts` (the
   producer, `:660,668,672,687`), `src/flow/types.ts:263` (the field's type,
   `string | null`, untouched), `src/commands/flow.ts:594,604`
   (`if (result.passed && result.issueComment) { ...
   console.log(result.issueComment); }` — logs it verbatim, asserts nothing
   about its shape), and `src/review/pr-comments.ts`/`.test.ts` (an unrelated
   `issueComments` *count* field on a different type — name collision only,
   confirmed by reading both call sites). No reader parses the comment's Gate
   line format; the only two "readers" are a human (terminal) and, when a
   tracker is configured, the issue tracker's comment body (opaque text to
   any code in this repository).
4. `GateOutcome.status` (left as `"pass" | "fail" | "skipped"`, unchanged) —
   readers already enumerated above under "What this task does NOT change";
   confirms why widening it was rejected rather than needed.

**Conclusion:** growing the `"done"` transition's `detail` string and
changing which per-gate line `buildIssueComment` renders for the `health`
gate specifically are both additive, string-only changes with no reader that
depends on the prior exact text. No schema/type field is added; nothing
needs to tolerate a new shape.

## Fix (option: make the record genuinely distinguishable, not touch other files)

The dispatch's own framing: "Prefer the first [making the record
distinguishable]... a durable record that signs [a warning] as passed is the
thing the policy forbids." Implemented narrowly, reusing data
`healthGateOutcome` already computes and that T56/T57 already established is
leak-safe (a closed-vocabulary switch's own literal output, never
interpolated external content):

Add one small helper, `healthWarnNote`, next to `healthGateOutcome`:

```ts
function healthWarnNote(gates: GateOutcome[]): string | null {
  const health = gates.find((gate) => gate.name === "health");
  return health && health.detail !== "health gate: pass" ? health.detail : null;
}
```

`health` is always present with `status: "pass"` at the point this runs (it
is only ever called from the `passed` branch, and `passed` requires every
gate's `status !== "fail"` — an unevaluable or `incomplete` health gate is
`"fail"` and never reaches here, per T56, unchanged). Its `detail` is one of
exactly two literals (`healthGateOutcome`'s pass arm: `` `health gate:
${health.status}` `` where `health.status` is `"pass"` or `"warn"`, nothing
else reaches that arm) — so the `!==` comparison is exact, not a fragile
text match.

Two call sites:

1. The `"done"` transition detail, replacing the fixed `"all gates passed"`:
   ```ts
   const warnNote = healthWarnNote(gates);
   flow = await transition(
     cwd, dir, flow, "done", "done",
     warnNote ? `all gates passed (${warnNote})` : "all gates passed",
   );
   ```
   A genuine pass is byte-identical to today (`"all gates passed"`, `warnNote
   === null`). A `warn` completion now records `"all gates passed (health
   gate: warn)"` in `flow.json` history — the word "warn" is in the stored
   record.

2. `buildIssueComment`, replacing the health gate's line specifically:
   ```ts
   const warnNote = healthWarnNote(gates);
   const gateLine = gates
     .map((gate) => (gate.name === "health" && warnNote ? warnNote : `${gate.name}: ${gate.status}`))
     .join(", ");
   ```
   Every gate but `health` is rendered exactly as today
   (`` `${gate.name}: ${gate.status}` ``). `health` on a clean pass is also
   unchanged (`"health: pass"`, since `warnNote` is `null`). `health` on a
   `warn` completion renders `"health gate: warn"` instead of `"health:
   pass"` — the published comment now contains the word "warn" too.

## Why not widen to every gate's `detail`

An earlier draft of this fix considered joining every gate's `detail`
(mirroring the failing path's `` failed.map((gate) => \`${gate.name}:
${gate.detail}\`).join(" | ") `` at `:683`, unchanged) into both surfaces for
ALL gates, not just `health`. Rejected: on the passing path today, **no**
gate's `detail` reaches `flow.json` history or the published comment except
through this task's fix — the failing path only ever exposes *failed*
gates' detail, and only into `flow.json` (never into `buildIssueComment`,
which is not called on failure). Blanket-exposing every gate's *passing*
`detail` into the externally-published comment would be new exposure for
detail text this file does not construct and cannot vouch for — in
particular `review`'s `verdict.detail`, built in the 2000-line
`src/flow/review-gate.ts`, a file outside this task's ownership that a
sibling task (T47) already flagged as carrying at least one accepted, un-fixed,
out-of-scope path where an unexpected `readFile`/`JSON.parse` failure's
`error.message` can reach a gate's `detail` on a path other than a `throw`
(`review-gate.ts`'s `readReviewGateConfig`, `T47-implementation.md`, "Out of
scope, flagged"). `security`'s declared return type
(`FlowServiceDeps.securityGate`) is `"pass" | "fail" | "skipped"` — no
`"warn"` equivalent — so security has no version of this defect to fix in
the first place. Scoping the fix to the one gate that can actually produce a
passing-but-not-clean state keeps the change's blast radius equal to the
defect's: zero new exposure for gates whose `detail` this task did not
audit and does not own.

## Code comment correction

`healthGateOutcome`'s doc comment (`:980-983`, pre-fix) states: "The row
stays distinguishable from a genuine pass even so: `detail` keeps naming the
underlying status... so a reader of `flow.json` can tell a warned gate from
a clean one." That was false before this fix (T57 F-001) and becomes true
after it, but only because of `healthWarnNote` — not because of anything in
`healthGateOutcome` itself, which only ever produces the in-memory
`GateOutcome`. The comment is corrected to point at the actual mechanism
(`healthWarnNote`, used by both the `"done"` transition note and
`buildIssueComment`) instead of asserting the property as if
`healthGateOutcome`'s own return value were what a reader of `flow.json`
sees.

`T56-implementation.md`'s acceptance table is a frozen artifact from a prior
task and is not edited by this task (constraints: no edits to
`acceptance-criteria.md`; the implementation-report files are historical
records of what T56 did and argued, not living documentation — the
correction belongs in the code comment, which is what a future reader of
`service.ts` actually consults, and in this task's own `T60-implementation.md`,
which supersedes the false claim for anyone reading the flow's artifact
trail in order).

## Regressions to add (RED before, GREEN after)

Both assert on the **persisted `flow.json`** (read back off disk after
`complete()` returns, not `result.gates`) and on **`result.issueComment`**
(the actual string that would be posted, not a status field), per the
dispatch's explicit instruction that an assertion on the returned object
alone is exactly the gap that let F-001 stand.

1. Strengthen the existing T56 test `"healthGate -> warn still completes,
   but the row is not identical to a genuine pass"` (`service.test.ts:392`)
   — it currently asserts only on `result.gates`/`result.passed`/
   `result.flow.status`. Add: read `flow.json` off disk and assert its
   `history` tail's `"done"` event `detail` contains `"warn"`; assert
   `result.issueComment` contains `"warn"`. Not deleting or loosening any
   existing assertion — the in-memory checks stay (they are still true and
   still worth pinning), this only adds the artifact-level checks that were
   missing.
2. New test: `"warn completion is distinguishable from a genuine pass in
   the STORED flow.json record and in the published issue comment"` — runs
   `complete()` twice (once `health -> pass`, once `health -> warn`) against
   two independent fixtures, reads `flow.json` back off disk for both, and
   asserts:
   - the two stored JSON blobs are **not** identical (`JSON.stringify`
     comparison, mirroring the reviewer's own `T57-flow.ts` C99 probe)
   - the stored JSON for the warn run contains the word `"warn"`
     (case-insensitive) and the stored JSON for the pass run does not
   - `result.issueComment` differs between the two runs and the warn run's
     comment contains `"warn"`
   - the pass run's stored JSON and comment are **byte-identical in shape**
     to what a pre-fix build already produced (`"all gates passed"` history
     detail, `"health: pass"` comment line) — pinning that a genuine pass is
     unaffected by this change.

## Verification plan

- `bun .metaproject/flows/233-…/artifacts/T57-flow.ts` before the fix
  (reproduces F-001, `storedRecordsIdentical: true`) and after (must show
  `storedRecordsIdentical: false`, `storedRecordContainsWarnWord: true`).
  Raw logs under `.metaproject/data/gdctx/raw/`.
- New/strengthened regressions in `src/flow/service.test.ts`: RED before the
  fix, GREEN after.
- `bun src/cli.ts ctx run -- bun test src/flow/` (dispatch's required,
  test-selection-restricted command) — must stay green, count reported.
- `bun run typecheck`, filtered to files this task touches.
- `bunx eslint` on every file changed.
