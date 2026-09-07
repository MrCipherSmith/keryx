STATUS: DONE

# T60 — implementation: make a `warn` completion distinguishable from a genuine pass in the STORED record and PUBLISHED comment (T57 F-001)

## Option chosen, and why

Two options were offered by the dispatch: (1) make the recorded row
genuinely distinguishable, or (2) if that cannot be done without changing
what completion means, remove the false claim from the code and the
acceptance evidence and say plainly that a warning is recorded as a pass.
**Chose (1)**, as instructed ("prefer the first"). It does not require
changing what completion means: `GateOutcome.status` stays `"pass"` for
`warn` (T56's decision, not reopened, not touched), and
`gates.every((gate) => gate.status !== "fail")` (`:659`) is untouched — no
flow that completes today stops completing, and no flow that fails today
starts passing.

Within option (1), two further design choices were made and are recorded
in `T60-spec.md` in full (reader enumeration, "why not widen to every
gate's `detail`"):

- **Did not widen `GateOutcome.status` to a 4th `"warn"` member**
  (F-001's suggested option (b)). Reader enumeration found a concrete
  breakage: `src/commands/flow.ts:578-584` picks the terminal color by
  `gate.status === "pass" ? green : gate.status === "skipped" ? gray : red`
  — a `"warn"` value falls into the `red` ("hard failure") branch, which
  would paint a *completed* flow's health row as a failure. Fixing that is a
  change to `src/commands/flow.ts`, outside this task's ownership
  (`src/flow/service.ts` and focused test files under `src/flow/` — nothing
  else). Kept `status: "pass"`, which that file already renders correctly.
- **Scoped the fix to the `health` gate specifically**, not a blanket join
  of every gate's `detail` into both surfaces (which the failing path
  already does for *failed* gates, at `:697` unchanged). Reasoning is in
  `T60-spec.md`: `health` is the only gate whose vocabulary admits a
  passing-but-not-clean state today (`tasks`/`pull-request`/`main-merge`/
  `acceptance-criteria` have none; `FlowServiceDeps.securityGate`'s declared
  return type is `"pass" | "fail" | "skipped"`, no `"warn"`), and widening
  to every gate would expose `review`'s `verdict.detail` — built in the
  2000-line `review-gate.ts`, a file this task does not own and cannot
  vouch for, which a sibling task (T47) already flagged as carrying at
  least one accepted, unfixed leak-adjacent path outside a `throw`
  (`readReviewGateConfig`). Scoping to `health` keeps this task's blast
  radius equal to the defect's.

## The fix

`src/flow/service.ts`:

1. New helper `healthWarnNote(gates)`, placed directly after
   `healthGateOutcome` (which it reads, not modifies): finds the `health`
   gate and returns its `detail` when it is not the literal string
   `"health gate: pass"`, else `null`. `healthGateOutcome`'s pass arm
   produces exactly those two literals (`` `health gate: ${health.status}`
   `` where `health.status` is `"pass"` or `"warn"`, nothing else reaches
   that arm), so the comparison is exact, not a text-pattern guess.
2. The `"done"` transition detail (previously the fixed constant `"all
   gates passed"`) now reads `` warnNote ? \`all gates passed
   (${warnNote})\` : "all gates passed" ``. A genuine pass is byte-identical
   to before (`warnNote === null`). A warn completion's `flow.json` history
   now reads `"all gates passed (health gate: warn)"`.
3. `buildIssueComment`'s `gateLine` renders every gate exactly as before
   (`` `${gate.name}: ${gate.status}` ``) except `health`, which renders
   `warnNote` in place of `"health: pass"` when it is not a clean pass. A
   genuine pass's comment is byte-identical to before. A warn completion's
   comment now reads `"...health gate: warn..."` instead of `"...health:
   pass..."`.
4. Corrected `healthGateOutcome`'s doc comment (previously asserted, as a
   property of `flow.json`, that a reader could tell a warned gate from a
   clean one — false before this fix, per F-001, since `healthGateOutcome`
   only ever returns an in-memory value). It now states plainly that this
   function only produces the in-memory `GateOutcome`, and points at
   `healthWarnNote` as the actual mechanism that reaches `flow.json` and
   the comment.

No change to `GateOutcome`, `FlowServiceDeps`, the pass/fail fold, any
other gate (1-4, 6), or `healthGateOutcome`'s own switch/return values.

## Reader enumeration (full detail in `T60-spec.md`)

Method: `bun src/cli.ts ctx rg` over every string/field this change touches,
each match read in full.

- `"all gates passed"` (the literal being changed): one hit before this
  task, the site itself (`service.ts:667`, pre-fix) — no test or other file
  matched it.
- `flow.history` (what the `"done"` event's `detail` becomes part of):
  three readers — `src/commands/flow.ts:334-337` (`flow status`, prints
  `event`/`detail` generically, tolerant of any detail text),
  `src/flow/store.ts:150` (`migrateTask`, reads `event.event` only, never
  `.detail`), `src/flow/service.test.ts:225` (asserts on the FAILING path's
  event name, `"completion-failed"`, untouched by this task). None depends
  on the literal content of the `"done"` event's `detail`.
- `result.issueComment` (what `buildIssueComment` builds): producer
  (`service.ts`), its type (`types.ts:263`, `string | null`, untouched),
  and `src/commands/flow.ts:594,604` (`console.log`s it verbatim, asserts
  nothing about its shape). `src/review/pr-comments.ts`/`.test.ts`'s
  `issueComments` is an unrelated counter field on a different type — a
  name collision only, confirmed by reading both call sites.
- `GateOutcome.status`'s readers — enumerated above under "did not widen";
  this is why widening was rejected, not something this task needed to make
  work.

**Conclusion, verified rather than assumed:** both changes are additive,
string-only, and no reader depends on the prior exact text.

## Evidence taken from the persisted artifact (not the return value)

Reproduced pre-fix with the reviewer's own probe,
`T57-flow.ts`, before touching code (raw:
`.metaproject/data/gdctx/raw/T60-probe-before.log`), row C99:
```
{"label":"C99 stored flow record: genuine pass vs warn",
 "storedRecordsIdentical":true,"issueCommentsIdentical":true,
 "issueCommentHealthLinePass":"- Gates: ... health: pass",
 "issueCommentHealthLineWarn":"- Gates: ... health: pass",
 "storedRecordContainsWarnWord":false}
```

Same probe, same row, after the fix (raw:
`.metaproject/data/gdctx/raw/T60-probe-after-final.log`, re-run twice,
byte-identical both times — `T60-probe-after-final2.log`):
```
{"label":"C99 stored flow record: genuine pass vs warn",
 "storedRecordsIdentical":false,"issueCommentsIdentical":false,
 "issueCommentHealthLinePass":"- Gates: acceptance-criteria: pass, pull-request: pass, tasks: pass, review: pass, health: pass",
 "issueCommentHealthLineWarn":"- Gates: acceptance-criteria: pass, pull-request: pass, tasks: pass, review: pass, health gate: warn",
 "storedRecordContainsWarnWord":true}
```

Row C01 (genuine pass) unchanged before/after
(`storedHistoryTail: ["done: all gates passed"]`,
`issueCommentHealthLine: "...health: pass"`) — the fix is a no-op for the
common case, read off disk, not inferred. Row C02 (warn) after the fix:
`storedHistoryTail: ["done: all gates passed (health gate: warn)"]`,
`issueCommentHealthLine: "...health gate: warn"`. All 18 rows re-checked;
`leakedPlantedReason: false` on every row, unchanged.

Cross-checked against `T39-exit.ts`'s F1 rows (raw:
`.metaproject/data/gdctx/raw/T60-T39exit-after.log`), which reads
`result.gates` (the return value, not the artifact) — byte-identical to
T56/T57's prior runs, confirming `healthGateOutcome`'s own in-memory
behavior is untouched:
```
healthGate -> pass        recordedGateStatus "pass"  detail "health gate: pass"
healthGate -> warn        recordedGateStatus "pass"  detail "health gate: warn"
healthGate -> incomplete  recordedGateStatus "fail"
healthGate -> fail        recordedGateStatus "fail"
healthGate -> banana      recordedGateStatus "fail"  (constant, leak-safe detail)
```

## Regression tests (RED before, GREEN after) — asserting on the artifact, not the return value

Per the dispatch's explicit instruction ("a test asserting on the returned
object would have passed while the defect stood" — true of T56's own
`"healthGate -> warn still completes..."` test, which only checked
`result.gates`), both changes below read the persisted `flow.json` off disk
and check `result.issueComment`'s actual text.

1. **Strengthened** (not weakened — no existing assertion removed) T56's
   `"healthGate -> warn still completes, but the row is not identical to a
   genuine pass"` (`service.test.ts:392`+): added reading `flow.json` back
   off disk and asserting the `"done"` history entry's `detail` contains
   `"warn"` and is not the bare `"all gates passed"`; added asserting
   `result.issueComment` contains `"warn"`.
2. **New**: `"a warn completion's stored flow.json and issue comment are
   NOT identical to a genuine pass's"` — a committed version of the
   reviewer's own `T57-flow.ts` C99 probe. Drives `complete()` twice, same
   title/slug/id (both roots start fresh, so a differing title cannot be
   what makes the records differ — the first draft of this test used
   `` `Health gate ${status}` `` as the title, which trivially made the two
   records differ regardless of the fix since the warn run's own title
   contained the literal word "warn"; caught during RED verification below
   and corrected to a shared, fixed title before recording this as the
   committed regression). Reads `flow.json` back off disk for both,
   compares the raw JSON text and `result.issueComment` byte for byte:
   not identical, warn run contains `"warn"` (case-insensitive), pass run
   does not, and the pass run's `"done"` history entry is pinned exactly
   equal to the pre-fix constant.

**RED** (reverted the two call-site edits in `service.ts` by hand — not
`git stash`/`git checkout`, since this file already carries substantial
uncommitted work from T45/T47/T56 in this same session and the dispatch
forbids any git state change; re-applied by hand afterward, confirmed by a
clean `git diff` shape matching what this report describes):
```
bun test src/flow/service.test.ts -t "NOT identical to a genuine pass"
error: expect(received).not.toBe(expected)
Expected: not "{...\"detail\": \"all gates passed\"...}"
(fail) a warn completion's stored flow.json and issue comment are NOT identical to a genuine pass's
0 pass / 1 fail
```
and, for the strengthened test:
```
bun test src/flow/service.test.ts -t "warn"
error: expect(received).toContain(expected)
Expected to contain: "warn"
Received: "all gates passed"
(fail) healthGate -> warn still completes, but the row is not identical to a genuine pass
1 pass / 1 fail
```
(the 1 pass in that second run is the C99-style test's title-bug false
pass, caught and fixed before this became the recorded RED — see the note
above; re-ran after the title fix, confirmed genuinely RED, transcript
shown first).

**GREEN** (`bun test src/flow/service.test.ts -t "warn|NOT identical"`):
2 pass / 0 fail / 16 expect(). Full file: 14 pass / 0 fail / 86 expect()
(direct, quick check; not routed).

## Verification

| Check | Command | Result | Raw log |
|---|---|---|---|
| Reviewer's probe, before | `bun .metaproject/flows/233-.../artifacts/T57-flow.ts` | row C99: `storedRecordsIdentical:true` (F-001 reproduced) | `.metaproject/data/gdctx/raw/T60-probe-before.log` |
| Reviewer's probe, after | same | row C99: `storedRecordsIdentical:false`, `storedRecordContainsWarnWord:true`; re-run twice, byte-identical | `.metaproject/data/gdctx/raw/T60-probe-after-final.log`, `T60-probe-after-final2.log` |
| Other reviewer probe (return-value only, sanity that `healthGateOutcome` itself is untouched) | `bun .metaproject/flows/233-.../artifacts/T39-exit.ts` | F1 rows byte-identical to T56/T57's prior runs | `.metaproject/data/gdctx/raw/T60-T39exit-after.log` |
| New/strengthened regressions, GREEN | `bun test src/flow/service.test.ts -t "warn\|NOT identical"` | 2 pass / 0 fail / 16 expect() | not routed (quick local check) |
| Full `service.test.ts` | `bun test src/flow/service.test.ts` | 14 pass / 0 fail / 86 expect() | not routed (quick local check) |
| Full flow-focused suite (dispatch's required command) | `bun src/cli.ts ctx run -- bun test src/flow/` | 192 pass / 0 fail / 660 expect() across 20 files | `.metaproject/data/gdctx/raw/2026-09-06T16-46-30-223Z_run.md` (summary; raw under same dir) |
| Typecheck | `bun src/cli.ts ctx run -- bun run typecheck` | exit 0, zero errors | `.metaproject/data/gdctx/raw/2026-09-06T16-46-02-465Z_run.md` |
| ESLint on every file changed | `bun src/cli.ts ctx run -- bunx eslint src/flow/service.ts src/flow/service.test.ts` | clean, no output | `.metaproject/data/gdctx/raw/2026-09-06T16-46-08-659Z_run.md` |

192 = T56's recorded 191 baseline + 1 new test (the strengthened test added
assertions to an existing test, not a new `test(...)` block; the C99-style
test is the one new `test(...)`).

## Files changed

- `src/flow/service.ts` — added `healthWarnNote(gates)` next to
  `healthGateOutcome`; the `"done"` transition detail in `complete()` now
  calls it instead of using the fixed string `"all gates passed"`;
  `buildIssueComment`'s `gateLine` renders the health gate's distinguishing
  detail instead of `status` when it is not a clean pass; corrected
  `healthGateOutcome`'s doc comment to stop asserting the distinguishability
  property of itself and point at the actual mechanism.
- `src/flow/service.test.ts` — strengthened T56's existing `warn` test with
  artifact-level assertions (persisted `flow.json`, `result.issueComment`);
  added one new test comparing a genuine pass's and a warn completion's
  persisted `flow.json` and `issueComment` byte for byte.

## Concerns

None blocking. One thing worth a follow-up, not fixed here (out of
ownership and out of this task's named defect): `review-gate.ts`'s
`verdict.detail` on a genuinely *passing* review gate has not been audited
for leak-safety by this task (only its `catch`-path text, already fixed by
T47, was in scope there). This task did not expose that detail anywhere it
was not already reachable — the "why not widen" section in `T60-spec.md`
is the record of why that was deliberately avoided, not evidence that the
underlying file is either safe or unsafe.

## Routing audit

graph_used: no (not-relevant — the dispatch named the exact file, the exact
finding (T57 F-001), and pinned the artifacts to read; no
structural/dependency discovery question needed the graph, and the graph
answers from the last build, not this session's uncommitted tree).
wiki_used: no (not-relevant — the normative source is `policies.md`,
supplied directly and read in full, same as T45/T47/T56). ctx_used: yes —
every project-code search via `bun src/cli.ts ctx rg` (raw logs referenced
above by timestamp), every verification command via `bun src/cli.ts ctx
run`, all file reads via the `Read` tool at bounded offsets per the
dispatch's stated workaround for the raw-`sed`/`cat`/`grep` hook. The
reviewer's own probes (`T57-flow.ts`, `T39-exit.ts`) were run directly
rather than through `ctx run`, for the same reason T57 itself gave: gdctx
compaction drops the per-case JSON rows that are the evidence. raw_rg_used:
no.
