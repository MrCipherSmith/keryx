# Flow Journal

- 2026-08-29T09:30:41.636Z - flow created
- 2026-08-29T09:32:32.668Z - task-added: T5: Baseline: record current bun test counts and the 34 affected historical flows
- 2026-08-29T09:32:32.856Z - task-added: T6: Wire taskGateStatus() into complete() as a fifth gate, opt-in by schemaVersion
- 2026-08-29T09:32:33.046Z - task-added: T7: Decide and implement the skipped-disposition rule; record the decision in journal.md
- 2026-08-29T09:32:33.232Z - task-added: T8: Test: open task fails complete; a pre-existing package is unaffected
- 2026-08-29T09:32:33.431Z - task-added: T9: Remove the false task-gate claim from flow-orchestrator SKILL.md in the same commit
- 2026-08-29T09:32:33.620Z - task-added: T10: Structured findings array: findings.json conforming to review-finding.schema.json
- 2026-08-29T09:32:33.826Z - task-added: T11: Consume the structured array; keep Markdown parsing for legacy reports only
- 2026-08-29T09:32:34.043Z - task-added: T12: Test: construct a round-2 reviewer-input from a round-1 artifact and validate it
- 2026-08-29T09:32:34.266Z - task-added: T13: Test: a legacy Markdown review report still parses without error
- 2026-08-29T09:32:34.479Z - task-added: T14: keryx flow task attempt CLI verb writing to the existing attempts field
- 2026-08-29T09:32:34.686Z - task-added: T15: Test: attempt count survives a simulated session restart
- 2026-08-29T09:32:34.888Z - task-added: T16: Port job-orchestrator 0.0 State Resumption Check into flow-orchestrator Phase 0
- 2026-08-29T09:32:35.093Z - task-added: T17: Delete dead surface: --greptile, frontend-conventions misroute, FAILED, legacy-profile prompt
- 2026-08-29T09:32:35.293Z - task-added: T18: Verify both skill copies agree (src/gdskills/bundled and .metaproject/skills/gdskills)
- 2026-08-29T09:32:35.485Z - task-added: T19: Quality gate: typecheck, full suite against the baseline, doc-links
- 2026-08-29T09:32:53.124Z - frozen: 13 criteria; checksum recorded
- 2026-08-29T09:32:53.314Z - started
- 2026-08-29T10:00:32.108Z - ac-updated: Corrected a measurement error in AC2: the leak is 34 unfinished TASKS across 24 flows, not 34 flows. Recomputed directly from .metaproject/flows/*/flow.json (184 done flows; task statuses: 1155 done, 34 todo). No criterion was added, removed or weakened.

## 2026-08-29 — baseline and a corrected measurement

**Baseline (T5).** `bun test` at the branch point: **5398 pass / 18 skip / 0
fail**; `tsc --noEmit` clean. Any new failure in this flow belongs to this flow.

**Correction.** The benchmark reported "34 done flows with an unfinished task".
That was wrong, and it had already propagated into the requirements package and
into AC2 before it was caught.

Ground truth, recomputed directly over 184 done flows: task statuses are
**1155 `done` and 34 `todo`**, and those 34 todo tasks sit in **24 flows**. The
leak is *34 unfinished tasks across 24 flows*, not 34 flows. Of the 34, **24 are
`Self-review and prepare draft PR`**.

The argument is unchanged — roughly one completion in eight shipped without its
own review step — but the number of packages an opt-in gate has to protect is
**24**, and that is what AC2 now says.

Also recorded because it makes AC3 cheap: **no task in any done flow carries the
`skipped` disposition.** The only statuses ever present are `done` and `todo`.
The decision is therefore about a disposition the CLI supports and nothing has
ever used, so it can be decided strictly at no migration cost.

Corrected in `README.md`, `roadmap.md`, `description.md`, `plan.md`, and — via
`keryx flow ac update`, never by hand — `acceptance-criteria.md`.
- 2026-08-29T10:01:14.065Z - task-done: T1: Collect remaining context
- 2026-08-29T10:01:14.261Z - task-done: T5: Baseline: record current bun test counts and the 34 affected historical flows

## 2026-08-29 — T17: three of four dead-surface deletions landed; FAILED removal blocked by evidence

Edited `src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md` (mirrored byte-for-byte
into `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md`):

1. **`--greptile`** — removed the trigger entry, the `review-greptile` mention in the Model
   Strategy complexity table, the `--greptile` row and the `--all` clause in the Routing Table,
   and a whole `### Greptile Reviewer` subsection (dispatch instructions, PR_NUMBER/REPO/REMOTE
   payload, findings-merge note, auto-include rule) that the initial case-sensitive search missed
   because the heading capitalizes "Greptile" — caught on the case-insensitive verification pass.
   Case-insensitive `greptile` search over both copies now returns zero matches; the only other
   "greptile" hits in the tree are `context-collector/SKILL.md`'s unrelated MCP context-source use
   and the flow's own roadmap/spec docs, both out of scope.
2. **Frontend-conventions misroute** — narrowed the auto-detect row from `src/**/*.ts` (fires on
   every TypeScript file) to `.tsx` files, `*.stories.tsx`, or a `.ts`/`.js` change in a repo whose
   `package.json` declares react/react-dom/mobx/mobx-react(-lite). Reviewer itself untouched.
4. **Legacy-profile prompt** — removed the interactive "Include legacy/profile reviewers? A/B/C"
   prompt block and the Step 5 workflow instruction to ask about it. Legacy/profile reviewers are
   now reachable only via explicit flags (`--legacy-profiles`, `--code-ai`, `--b091`,
   `--code-style`, `--mobx-store`) or `job-orchestrator` automation settings; the
   `code-mobx-store-review` auto-suggestion stays informational-only in the Review Plan Preview.

**3. `FAILED` enum removal — NOT done. Stopped per the task's own instruction to verify before
removing.** `subagent-result.schema.json`'s status enum is not dead surface: it is mirrored
verbatim by `src/harness/child/contract.ts` (`CanonicalSubagentStatus`, `CANONICAL_STATUS_TOKENS`),
which parses a real child worker's `STATUS: FAILED` first line into a canonical result. That parser
is wired into production via `src/harness/extension/execute.ts:167` (`parseChildResult`, imported
from `../child/contract`), not just tests. `childResultToEvidence` in `spawn.ts` stamps the
disposition into evidence as `child-result:${status}` for any status including FAILED.
`spawn.test.ts:505` asserts, by name, "a FAILED child disposition maps through the parent's gate to
a 'failed' completion, never a false 'completed'" — a safety property this same hardening flow
cares about. `contract.test.ts:257` asserts `STATUS: FAILED` round-trips and validates against
`subagent-result.schema.json`. Deleting `FAILED` from the enum would break both tests and remove a
real, tested completion-safety path in the harness child layer — a different producer from the
`task-implementer` SKILL.md worker the flow plan had in mind (which indeed never emits it, and
`subagent-status-protocol.md` indeed never mentions it — that document is untouched). Left the
schema and the protocol doc as-is; not reporting T17's item 3 as complete.

**Note for the agent removing the `FAILED` routing row in `flow-orchestrator/SKILL.md`:** the
premise that FAILED is unreachable does not hold at the schema/harness level — worth confirming
that removal is still correct for that file's routing table before it lands.

**Baseline check:** `bun test` — 5398 pass / 18 skip / 0 fail (unchanged from T5 baseline).
`tsc --noEmit` — clean. Only markdown was touched, so no code-level effect on either.
- 2026-08-29T10:10:54.900Z - ac-updated: AC11 corrected: the premise that FAILED is unreachable is false. src/harness/child/contract.ts parses STATUS: FAILED from external child workers, wired at src/harness/extension/execute.ts:167, and spawn.test.ts:505 asserts a FAILED disposition maps to a failed completion 'never a false completed'. Removing it would delete a tested completion-safety path. The real defect is documentation: the protocol doc says four statuses, the schema carries five. AC11 now requires correcting the doc instead of deleting the enum value; the other three deletions are unchanged.

## 2026-08-29 — T10–T13: where the structured findings array comes from, and why

**The decision.** The array is produced by the **reviewer** and carried by the
**orchestrator**; it is never re-derived from the report. Three doors accept it,
in order of decreasing fidelity, and `normalizeFindings` takes the first that
answers:

1. `ManagedReviewInput.findings` — the caller passes the reviewer payloads it
   already holds. Accepts both the normalized array and the reviewer's own
   `{ reviewer, findings }` result, so an orchestrator with five payloads passes
   the five instead of merging them by hand.
2. A fenced code block whose info string carries `keryx:findings`, inside the
   report itself.
3. The markdown parser — legacy reports only.

**Why not "re-parse the report better".** Because the fields are not there to
parse. `src/review/fixtures/consolidated-review-2026-08-01.md` is a real
consolidated report: it contains the word `confidence` zero times and carries no
evidence field under any label. The loss is not a regex problem; it happens when
the orchestrator renders reviewer JSON to prose. So the parser was demoted to
reading what is already on disk rather than being made the source.

**Why the embedded block and not a sidecar `--findings <path>`.** A sidecar needs
a new CLI flag in `src/commands/review.ts` and a new convention for where the
file lives; the report is the one artifact `keryx review ingest --report`
already moves, so a block inside it cannot be separated from the findings in
transit, and a legacy report simply has no block — the fallback is automatic
rather than a mode someone must remember to set. `src/commands/review.ts` was
also outside this agent's file ownership, which is a second reason and is stated
so it is not mistaken for the first.

**Open, and NOT this agent's file:** nothing yet instructs `review-orchestrator`
to emit the block. The code accepts it; the skill has to be told to write it.
That edit belongs to whoever owns `review-orchestrator/SKILL.md`.

**What `findings.json` now holds.** An array whose every element is exactly a
`review-finding.schema.json` object. That schema is `additionalProperties: false`,
so `classification` and `flow_relevance` had to leave the record — and they are
not properties of a finding anyway: the reviewer states what is wrong, the
pipeline states what it intends to do about it. Both are recorded in
`decisions.md`, whose line format now carries them
(`- F-001: … (valid_followup, standalone_review).`). `learning_candidate` stays
in the record because the contract has a slot for it.

**Legacy read, structured write.** A markdown-derived finding is written in the
same shape, with the fields the format does carry recovered from their real
labels — `**Why it matters**` to `impact`, `**Fix**` to `suggested_fix`,
`**Found independently by**` to the originating `reviewer` — and the rest filled
with a stated provenance (`"not recorded: derived from a markdown review report,
which carried no evidence field"`). `confidence` on this path is `low`, not
`medium`: a field recovered by keyword-scanning prose is a low-confidence
derivation whatever the reviewer believed, and saying otherwise would let a fix
round treat a guess as the reviewer's own judgement.

`class_scope` is now extracted into `{sites, enumeration_method}` rather than
recorded as a boolean. The ingest **guard** deliberately still runs on the old
shape check (`hasClassScope`): a legacy report is refused for exactly the reasons
it was refused before, and extraction failing where the shape check passes costs
a `class_scope` in the persisted record and nothing else.

**Fail-closed on structured input.** A structured payload is a claim that the
fields exist, so an incomplete one is refused against
`review-finding.schema.json` before anything is written, rather than papered over
with the legacy placeholders. Recording it would put a finding into
`prior_findings` that the next round's dispatch then rejects — this flow's own
defect, reintroduced one layer down.

**No schema change.** `src/gdskills/contracts/review-finding.schema.json` and its
twin at
`src/gdskills/bundled/skills/review/review-orchestrator/reviewer-finding.schema.json`
are untouched. `confidence` is carried as the string enum the schema says today;
the roadmap's move to a number in [0,1] is a later phase and was not made here.

**T12, the proof.** `src/review/round-trip.test.ts` runs a round-1 review, reads
its `findings.json`, builds a round-2 `reviewer-input` with `is_fix_round: true`
out of that file and nothing else, and validates it against
`reviewer-input.schema.json` — green from a structured round and from a legacy
markdown round. Non-vacuity is pinned in the same file: the old `findings.json`
shape is asserted to still be **rejected**, naming `impact`, `suggested_fix`,
`evidence`, `confidence` and the forbidden `classification`.

**T13.** Every `report.md` under `.metaproject/reviews/` — 11 real packages — is
ingested in one test, alongside the pinned copy of the consolidated report.

**Numbers.** `tsc --noEmit` clean. `bun test src/review/`: 26 pass / 0 fail
(17 pre-existing + 9 new). Full-suite runs on this shared branch also show
failures in the `src/flow/service.ts` gate tests (another agent's in-flight
T6/T7) and a cross-file tmpdir-pollution flake in
`src/harness/tool/builtin/spawn-subagent-child-slate.test.ts`; the latter passes
in isolation and passes when run together with the whole of `src/review/`.
Neither is in this agent's files.

## 2026-08-29 — two decisions forced by the task gate (T6, T7)

### Decision 1 — the opt-in is a per-package field, not `schemaVersion` (T6, AC2)

**`schemaVersion` cannot carry this flag.** `readFlow` runs `migrateFlow` on
every read, which rewrites a v1 package to v2 in memory, and the next mutation
persists that v2 to disk. Measured over this repository: **195 of 197 packages
on disk are already `schemaVersion: 2`, and all 24 of the leaking packages are
among them.** A version number therefore cannot separate "written under the new
rules" from "written before them" — the discriminator the plan assumed exists
does not. (The plan's phrasing "gate on `schemaVersion: 2`" was written when v2
was the *new* version; it has since become the *universal* one.)

Bumping to a hypothetical v3 was rejected: it would mean using a document-shape
version as a feature flag while the document shape has not changed, and it would
touch the schema enum, the migration, `flow check`, and the committed docpack
schema — a large blast radius for a boolean.

**A repository-level config key does not work either.** Default-off leaves the
gate dead everywhere, which is exactly the state this flow exists to end (AC1
would then be satisfied only by a test that turns the key on). Default-on is
retroactive, which AC2 forbids. Neither default is correct, because the question
is not "does this repository want the gate" but "was this package written under
the gate".

**Chosen: `FlowState.gates.tasks`, written by `flow init`.** Creation is the one
moment that distinguishes the two populations. Every package created from now on
is covered automatically — nothing to configure, so the gate cannot quietly stay
off — and every pre-existing package lacks the field and reports
`tasks: skipped`. `skipped` rather than omitted-entirely, deliberately: an
invisible non-gate is the precise mechanism that let 34 tasks through, so a
package the gate does not cover must say so in the output an operator already
reads.

Follow-up, not done here (file ownership): `flowStateSchema()` in
`src/flow/schema.ts` does not yet declare `gates` or `dispositionReason`.
Nothing fails — both objects are `additionalProperties: true`, so `flow check`
and `schema.test.ts` validate the new fields today — but the runtime schema and
its committed docpack copy should be regenerated together with
`keryx flow schema --out docs/requirements/keryx-metaproject-native/schemas/flow-state.schema.json`,
since `schema.test.ts` asserts the two are byte-consistent.

### Decision 2 — `skipped` passes only with a recorded reason (T7, AC3)

**The decision: a task with `disposition: "skipped"` is terminal-pass if and
only if it carries a non-empty `dispositionReason`. A bare skip fails the gate.**

The two rejected alternatives:

- *`skipped` always passes* (today's behaviour). This makes "skipped" a one-flag
  bypass of the gate we are installing in the same commit. The gate would be
  enforceable and trivially avoidable at once, which is worse than no gate,
  because the output would then read `tasks: pass` over work nobody did.
- *`skipped` always fails.* Cheap — **no task in any of the 184 done flows has
  ever carried the `skipped` disposition; the only statuses present are `done`
  and `todo`** — so a strict rule costs zero migration. But it deletes a
  legitimate outcome. Tasks genuinely do become unnecessary mid-flow (an
  approach changes and a planned test no longer has a subject), and if the only
  way to close such a task is `completed`, the record becomes a lie. Removing
  the honest option does not remove the pressure to close the task; it moves the
  dishonesty somewhere harder to see.

The reason requirement keeps the outcome and prices it. The cost of skipping is
one sentence a reviewer can read, and that sentence is what makes the skip
auditable rather than silent. Zero-migration applies to this rule too: nothing
has ever used the disposition, so nothing is broken by constraining it.

**Where it is enforced.** At the gate (`evaluateTaskGate` in `machine.ts`), not
at write time. `taskGateStatus()` keeps its TM-01 §6.2 mapping
(`skipped -> terminal-pass`) unchanged: it is a pure `(status, disposition)`
function and a reason is neither of those. The condition lives one level up,
where the whole task is visible. Enforcing at the gate rather than in `taskDone`
also means state written by any other path — the harness `ManagedFlowPort`, a
migration, a future MCP writer — is caught too, instead of only CLI-typed skips.
`keryx flow task done --disposition skipped` without `--reason` still succeeds,
but prints a warning at the moment of the mistake rather than at completion,
when the fix is a round trip away.

### Also landed

- `keryx flow task attempt <id> <Tn> --outcome started|failed|blocked
  [--detail "..."]` (T14) increments the `attempts.count` that has existed since
  TM-01 and was never once incremented (non-zero in 3 of 196 packages, and only
  via migration back-fill). Tested across a real reload from disk (T15), because
  a counter observed only inside the process that wrote it would pass while the
  restart bug is fully present.
- `flow-orchestrator/SKILL.md` (both mirrors): the false "`flow complete` gates
  on them" claim replaced with the gate's actual scope including its opt-in
  limit (T9); a §0.0-equivalent State Resumption Check ported from
  `job-orchestrator` into Phase 0, reading `attempts.count` from `flow.json`
  rather than from session context (T16).
- The `FAILED` routing row was **kept**, against the original T17 brief. The
  premise that no worker can emit it is false: `src/harness/child/contract.ts`
  parses `STATUS: FAILED` from real child workers and it is wired into
  production at `src/harness/extension/execute.ts:167`. The row was clarified
  instead — `FAILED` comes from harness child workers, never from skill workers,
  which do map `failed -> BLOCKED`.
- 2026-08-29T10:23:05.839Z - task-added: T20: review-orchestrator emits the keryx:findings block (producer side of T10/T11)
- 2026-08-29T10:29:50.044Z - task-done: T2: Implement per plan
- 2026-08-29T10:29:50.135Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-29T10:29:50.225Z - task-done: T6: Wire taskGateStatus() into complete() as a fifth gate, opt-in by schemaVersion
- 2026-08-29T10:29:50.316Z - task-done: T7: Decide and implement the skipped-disposition rule; record the decision in journal.md
- 2026-08-29T10:29:50.408Z - task-done: T8: Test: open task fails complete; a pre-existing package is unaffected
- 2026-08-29T10:29:50.501Z - task-done: T9: Remove the false task-gate claim from flow-orchestrator SKILL.md in the same commit
- 2026-08-29T10:29:50.593Z - task-done: T10: Structured findings array: findings.json conforming to review-finding.schema.json
- 2026-08-29T10:29:50.686Z - task-done: T11: Consume the structured array; keep Markdown parsing for legacy reports only
- 2026-08-29T10:29:50.776Z - task-done: T12: Test: construct a round-2 reviewer-input from a round-1 artifact and validate it
- 2026-08-29T10:29:50.865Z - task-done: T13: Test: a legacy Markdown review report still parses without error
- 2026-08-29T10:29:50.957Z - task-done: T14: keryx flow task attempt CLI verb writing to the existing attempts field
- 2026-08-29T10:29:51.049Z - task-done: T15: Test: attempt count survives a simulated session restart
- 2026-08-29T10:29:51.139Z - task-done: T16: Port job-orchestrator 0.0 State Resumption Check into flow-orchestrator Phase 0
- 2026-08-29T10:29:51.230Z - task-done: T17: Delete dead surface: --greptile, frontend-conventions misroute, FAILED, legacy-profile prompt
- 2026-08-29T10:29:51.322Z - task-done: T18: Verify both skill copies agree (src/gdskills/bundled and .metaproject/skills/gdskills)
- 2026-08-29T10:29:51.412Z - task-done: T19: Quality gate: typecheck, full suite against the baseline, doc-links
- 2026-08-29T10:29:51.503Z - task-done: T20: review-orchestrator emits the keryx:findings block (producer side of T10/T11)
- 2026-08-29T10:30:19.242Z - ac-confirmed: AC1: src/flow/task-gate.test.ts drives a flow to completion with an open task and asserts the fifth gate fails; taskGateStatus() wired into service.ts complete().
- 2026-08-29T10:30:19.410Z - ac-confirmed: AC2: Opt-in via FlowState.gates.tasks written by flow init, not schemaVersion (195/197 packages are already v2, so it cannot discriminate). Pre-existing packages report tasks: skipped; covered by task-gate.test.ts.
- 2026-08-29T10:30:19.579Z - ac-confirmed: AC3: skipped passes only with a recorded dispositionReason; enforced in evaluateTaskGate so harness-written state is caught too. Decision and reasoning recorded in journal.md.
- 2026-08-29T10:30:19.750Z - ac-confirmed: AC4: Commit cfb4c3b5 touches both src/flow/service.ts and flow-orchestrator/SKILL.md - the gate and the claim removal land together, verifiable on that commit.
- 2026-08-29T10:30:19.918Z - ac-confirmed: AC5: findings.json is now an array of pure contract objects validating against review-finding.schema.json and carrying the real reviewer; asserted in round-trip.test.ts.
- 2026-08-29T10:30:20.086Z - ac-confirmed: AC6: round-trip.test.ts builds a round-2 reviewer-input with is_fix_round true from a round-1 findings.json alone and validates it; green from both structured and legacy rounds. Non-vacuity pinned by asserting the old shape is still rejected.
- 2026-08-29T10:30:20.271Z - ac-confirmed: AC7: Legacy Markdown path retained and exercised over the 11 real packages under .metaproject/reviews/; covered in round-trip.test.ts.
- 2026-08-29T10:30:20.448Z - ac-confirmed: AC8: flow task attempt with --outcome started|failed|blocked increments attempts.count and appends to attempts.log through the service layer; src/flow/attempts.test.ts.
- 2026-08-29T10:30:20.614Z - ac-confirmed: AC9: attempts.test.ts reloads the package from disk and asserts the persisted count, not an in-process value.
- 2026-08-29T10:30:20.784Z - ac-confirmed: AC10: flow-orchestrator/SKILL.md Phase 0 gains a State Resumption Check; Phase 4 reads attempts.count from flow.json rather than from context. Both mirrors updated.
- 2026-08-29T10:30:20.950Z - ac-confirmed: AC11
- 2026-08-29T10:30:21.121Z - ac-confirmed: AC12: diff over both skill trees reports no differences for every file touched.
- 2026-08-29T10:30:21.292Z - ac-confirmed: AC13: typecheck clean; bun test 5423 pass / 18 skip / 0 fail against a 5398/18/0 baseline; test:guards 161/0; check:doc-links 1128 links 0 broken.
- 2026-08-29T12:40:00.000Z - review-fix: b9c7ab82 post-review remediation, src/review/** + review-orchestrator SKILL.md + managed-review-feedback-loop/specification.md. Seven defects, each reproduced by execution first.
  - MAJOR legacy path wrote schema-invalid records: the contract gate moved out of fromStructuredSource into createManagedReviewPackage, so schemaErrors now runs over the toContractFinding projection on BOTH paths. Additionally class_scope_present now derives from parseClassScope rather than a separate prose shape check, so the guard and the record cannot disagree. Proof: a legacy major whose class_scope was prose produced findings[0] with $.class_scope "Missing required property"; now refused before mkdir.
  - MAJOR keryx:findings door degraded silently: presence is now decided by an opening-fence match (EMBEDDED_FINDINGS_FENCE, /gm, up to 3 leading spaces per CommonMark) instead of by the parsed value, and a present block that is neither an array nor a { reviewer, findings } result throws. Proof: a block holding JSON null and a block indented two spaces each wrote 1 prose finding with no error; both now throw.
  - MAJOR a second block was dropped: fences are counted; more than one is an error naming both character offsets. Proof: two blocks with the real finding in the second ingested as 0 findings.
  - MINOR "found by"/"found independently by" removed from the evidence labels (attribution is not evidence); round-trip.test.ts now asserts evidence on the repo fixture, which was the only one of the five contract-critical fields it never asserted.
  - MINOR Step 12 named reviewer-finding.schema.json and called it additionalProperties:false; it is review-finding.schema.json and the findings item is additionalProperties:true, so unknown properties are DROPPED by toContractFinding, not rejected. Text corrected in both skill copies.
  - MINOR Step 12 claimed a legacy round "cannot seed a fix round"; round-trip.test.ts proves it can. Replaced with what is true: four fields carry not-recorded provenance and confidence is stamped low.
  - MINOR specification.md findings.json example was the removed shape (8 schema errors); replaced with a contract array (0 errors) and AC5 now points classification at decisions.md.
  - INFO all three done: the report path is threaded into every block refusal, a non-array block reports "not an array", isFindingClassification (exported, called nowhere) deleted with its import.
  - Verification: 7 new tests in round-trip.test.ts, all 7 fail against the reverted code and pass against the fix. bun test src/review/ src/gdskills/ 73 pass / 0 fail (was 66). bun run typecheck clean. bun test 5435 pass / 18 skip / 0 fail.


## 2026-08-29 — self-review round 1, and what it caught

Two reviewers, not nineteen — the branch's own conclusion applied to itself.
Both were held to the discipline this branch proposes generalising: a finding
not proven by executing something is not a finding, no theoretical findings, a
concrete failure path above INFO, and a cap of ten.

Both returned "not safe to merge". They were right, and three of the defects
were in work I had just called finished.

**The gate shipped with a wider hole than the one it closed.**
`disposition: "blocked"` passed it — and unlike `skipped`, required no reason at
all. Not a hypothetical: `ManagedFlowPort` maps a harness completion gate of
`blocked` to exactly that disposition and writes it through `taskDone`, so a
harness run ending blocked completed the flow. Separately, `--disposition` was
cast rather than parsed, so `--disposition skiped` reached disk and passed,
proven against the real CLI.

**The protocol correction was written to a generated file.** I spent the day
guarding two copies of every skill, wrote an acceptance criterion about it, and
then edited `.metaproject/rules/core/` — an install target that
`installBundledRules` overwrites from `src/gdskills/bundled/rules/core/` with
`force: true`. The reviewer proved it by running the installer and watching the
heading revert. The fix would have shipped nowhere and died at the next
`keryx update`.

A guard test now compares the two rule trees byte-for-byte, and was itself
verified by breaking the source and watching it fail. The skill mirror had
review discipline; the rule mirror had nothing, which is why it drifted
silently.

**The structured findings door failed open in three shapes** it claimed it
could not: a block containing `null`, an indented fence, and a second block —
each silently falling back to the lossy prose path, the exact behaviour the
change was written to eliminate.

Reviewers also checked my claims rather than only my code: the round-trip test
was attacked by deliberately loosening the schema (it failed, as it should), and
the `FAILED` analysis was verified accurate in both directions.

All findings fixed, each with a test that fails without the fix. Suite: 5435
pass / 18 skip / 0 fail against a 5398 baseline; guards 161/0; doc-links 0
broken; both mirrors agree on every common file.

**Note on this flow's own gate.** Flow 201 carries no `gates.tasks` field: it
was created by the globally-installed keryx, which predates the gate. So the
gate this flow adds reports `skipped` for the flow that added it. That is the
opt-in-by-creation rule working as designed, and it is also the gap the reviewer
flagged — there is no way to opt an in-flight package in. Recorded as follow-up
rather than fixed here.
- 2026-08-29T12:41:33.614Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-29T12:41:35.970Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/408 (warning: PR is not a draft)
