# Consolidated Review — PR #219 (flow 130) and PR #220 (flow 131 / R4c)

## Verdict: REQUEST_CHANGES (both branches)

Five reviewers ran in parallel over both diffs: security, logic, architecture +
core-boundaries, highload/idempotency, testing-practices. Two blockers and a
large agreed set of majors. Neither branch should merge as it stands.

The strongest signal is convergence: four of five reviewers independently found
the same two defects, three of them by execution rather than by reading.

## Review Scope

- Branches: `fix/216-round4-findings` (PR #219), `feat/r4c-turn-submission` (PR #220)
- Merge-base: `345eaa55`
- Reviewers dispatched: review-security-code, review-logic, review-architecture,
  review-core-boundaries, review-highload, review-testing-practices — all via a
  general-purpose runtime, because no native agent type exists for any of them.
- Context mode: full (governing requirements, both frozen AC files, both flow
  journals, accepted project memory)
- Skipped: review-frontend / review-frontend-conventions / review-flow-graph /
  review-mobx-store (no frontend, MobX or ReactFlow files in scope);
  review-greptile (external index not confirmed available).

## Stats (after dedupe)

- blocker: 2
- major: 12
- minor: 14
- info: 6

---

## Blockers

### F-001 — `POST /v1/turns` is not wired in production

- **Severity**: blocker
- **File**: `src/lib/serve-server.ts:739`
- **Found independently by**: review-logic (blocker), review-architecture (major), review-highload (info), review-security-code (info)

`startServeListener` builds the only production `ServeContext` without
`submitTurn`, and `createSubmitTurn` has zero production callers. A real
`keryx serve` answers every submission with `503 unavailable`.

**Why it matters**: nine of flow 131's twelve confirmed criteria — AC2, AC5,
AC6, AC7, AC8, AC9 among them — were verified through `handleServeRequest` with
a runner injected by the test fixture, never against a listener the CLI can
start. The feature is unreachable outside the test suite.

**class_scope** — the class is "an optional dependency that silently disables a
capability"; the same defect the flow journal already records once ("the security
scan was implemented and unreachable"), one layer up.

- sites: `src/lib/serve-server.ts:339` (`submitTurn`, declared optional, never
  assigned in production); `src/lib/serve-server.ts:319` (`peer`, assigned at
  :751, correct); `src/lib/serve-server.ts:328` (`throttle`, assigned at :752,
  correct); `src/lib/serve-turn.ts:541` (`createSubmitTurn`, zero production
  callers); `src/commands/serve.ts:205` (the only caller of
  `startServeListener`).
- enumeration_method: read the three optional fields of `ServeContext`, then
  `grep -rn 'createSubmitTurn|submitTurn:|throttle,|peer:' src --include=*.ts |
  grep -v '\.test\.'` for each. Exactly one production `ServeContext` literal
  exists and it omits one of the three; 2 of 3 wired.

**Fix**: assemble `createSubmitTurn` inside `startServeListener`, and make the
field required (or split `ServeContext` into read-only and turn-capable
variants) so a listener without a runner cannot typecheck. Add a route test that
drives a real socket rather than a synthetic context.

### F-002 — the durable event log silently reads back as empty

- **Severity**: blocker
- **File**: `src/lib/serve-turn-store.ts:190`
- **Found independently by**: review-logic (blocker), review-security-code (major), review-highload (major), review-architecture (major) — demonstrated by execution by three of them.

`events.jsonl` is append-only and unbounded in bytes, but is read through
`readConfigFile`, whose bound is `MAX_CONFIG_FILE_BYTES` (1 MB). The module's own
`MAX_TURN_EVENTS` is 10,000, which serialises to at least 1,518,890 bytes even
with zero assistant text.

Measured: 8,000 events gives 1,302,890 bytes, and `readTurnEvents` then returns 0.

**Why it matters**: past roughly 6,500 events the SSE route answers 200 with an
empty body — the exact silent truncation `api-protocol.md` §Bounds forbids and
this module's own header says cannot happen. AC8 is false for any turn past that
point. An oversized `turn.json` additionally makes `readTurnRecord` return null,
so `GET /v1/turns/{id}` 404s for a turn that exists and `finishTurn` silently
no-ops, stranding the turn at 409 forever.

**class_scope** — the class is "a file whose size grows with content, read at
the config bound".

- sites: `src/lib/serve-turn-store.ts:190` (`events.jsonl`, append-only,
  DEFECTIVE); `src/lib/serve-turn-store.ts:216` (`turn.json`, carries unbounded
  `result.text`, DEFECTIVE); `src/lib/serve-turn-store.ts:260` (idempotency
  index, fixed shape, correct); `lib/shell-permissions.ts:216`, `:388`,
  `lib/shell-config.ts:41`, `lib/sandbox-config.ts:78`,
  `lib/project-registry.ts:310`, `lib/serve-credential.ts:177`,
  `lib/serve-config.ts:444`, `:529` (all fixed-shape documents, correct).
- enumeration_method: `grep -rn 'readConfigFile(|readTranscriptFile(' src
  --include=*.ts | grep -v '\.test\.'` on `feat/r4c-turn-submission` gives 11
  call sites; each classified by whether the file it reads is bounded to config
  size. The same grep on `fix/216-round4-findings` shows the sibling class
  (session transcripts) was already split out into `readTranscriptFile`, so the
  correct pattern exists and the turn store was not routed to it.

**Fix**: give the turn store its own bound, land #219 first so
`readTranscriptFile` exists, and make `too-large` a stated caller-visible failure
rather than an empty list.

---

## Major

### F-003 — prompt-injection detection never blocks

- **Severity**: major
- **File**: `src/lib/serve-turn.ts:289` · review-security-code · proved by execution

`scanPrompt` blocks on `block` and `require-approval`. Every prompt-injection
detector scores 0.35 to 0.45 against a default `gate.minConfidence` of 0.5, so
injection findings are always downgraded to `warn`. All four canonical injection
prompts return `rejected: false`; an AWS key returns `rejected: true`.

Step 5 of the required decision path works for the secret class and is inert for
the injection class, on the one surface that can cause agent execution from
outside the operator's terminal. Not reconfigurable: the scan root is the install
directory, which never receives a `security.config.json`.

**class_scope** — the class is "a site that turns a security decision into an
allow/deny".

- sites: `src/security/guard.ts:119` (pre-existing, outside this diff, same blind
  spot — a lone injection yields gate `pass`); `src/lib/serve-turn.ts:289` (new
  in #220). The other 9 matches are 3 producers inside `src/security/resolve.ts`
  and 5 CLI exit-code/formatting sites in `src/commands/security.ts` and
  `src/security/service.ts`, none of which gate anything.
- enumeration_method: a grep across `src` for the five comparison forms that turn
  a `SecurityAction`/gate into a branch, excluding tests, gives 11 hits; each was
  classified by whether it decides execution. Cross-checked with a grep for
  `createSecurityService` — 4 consumers, of which only these 2 gate.

### F-004 — `compareProfiles` duplicates an existing comparator and drops `trustMode`

- **Severity**: major
- **File**: `src/harness/policy/profiles.ts:237` · review-architecture,
review-security-code, review-logic

`src/harness/child/isolation.ts` already owns `TRUST_RANK`, `OUTCOME_RANK`,
`ISOLATION_RANK` and `rankOf`, including the fail-closed-on-unknown rule. The new
comparator is a second implementation, and it omits `trustMode`.

By the codebase's own ordering `untrusted` (2) outranks `trusted-local` (1), so
the shipped default `remote-restricted` resolving to `unattended-untrusted`
widens against the `trusted-local` baseline on a dimension AC-04 never inspects.
A probe with `trustMode` widened returns `{ok: true, widened: []}`.

This is the "third copy" mistake the same commit message argues against.

**class_scope** — the class is "an implementation of profile permissiveness
ranking".

- sites: `src/harness/child/isolation.ts:107,114,145,156` (`TRUST_RANK`,
  `OUTCOME_RANK`, `ISOLATION_RANK`, `rankOf` — ranks `trustMode`);
  `src/harness/policy/profiles.ts:180,194` (`rank`, `isolationRank` — does not).
- enumeration_method: a grep across `src` for the four rank-table identifiers and
  the two ranking function names, excluding tests — exactly two files implement
  profile permissiveness ranking, and the newer one governs the remote surface.

### F-005 — the idempotency key is claimed before anything that can fail

- **Severity**: major
- **File**: `src/lib/serve-turn.ts:545` · review-logic, review-security-code,
review-highload · demonstrated

The claim precedes the scan and the record. A 422-rejected prompt permanently
poisons its key: every later submission returns `200 {duplicate: true,
sessionId: ""}` pointing at a turnId whose record 404s forever, and the
legitimate prompt never runs. The "no turn is created" test checks `listTurnIds`
only, never the key index.

**class_scope** — the class is "a durable claim written before a step that can
fail".

- sites: `src/lib/serve-turn.ts:545` (the only claim call site);
  `src/lib/serve-turn.ts:551` (the scan, after it); `src/lib/serve-turn.ts:331`
  (`createTurnRecord`, the only record-creation site, on the far side of the scan
  await); `src/lib/serve-turn-store.ts:258` (`claimIdempotencyKey` — no release
  function exists anywhere).
- enumeration_method: a grep across `src` for `claimIdempotencyKey`,
  `claimTurnKey` and `createTurnRecord`, excluding tests — four sites, one claim
  path, one creation path, and no release path.

### F-006 — `sessionId`, `approvalId` and `turnId` are the same value in production

- **Severity**: major
- **File**: `src/lib/serve-turn.ts:565` · review-logic, review-highload

`createSubmitTurn` passes `newId: () => turnId`, a constant, so every id minted
through the seam collides. The 202 reports a `sessionId` that is really the
turnId. The test asserts both are uuid-shaped and never that they differ.

**class_scope** — the class is "an id minted through the injected `newId` seam".

- sites: `src/lib/serve-turn.ts:326` (turnId); `:327` (sessionId); `:491`
  (approvalId); `:543` and `:565` (the factory that supplies the constant seam).
- enumeration_method: a grep across `src` for `newId`, excluding tests — six hits,
  all in `serve-turn.ts`; one production factory supplies the seam, so every id
  minted through it collides.

### F-007 — the backlog bound drops the terminal event too

- **Severity**: major
- **File**: `src/lib/serve-turn.ts:338` · review-logic

`emit` discards `appendTurnEvent`'s `false`, so past the bound every later event
is dropped — including `terminate()`'s `turn.finished`. The stream never closes
with a terminal event, which the store's own contract and §Bounds both forbid.

**class_scope** — the class is "a caller of `appendTurnEvent` that must act on a
refused append".

- sites: `src/lib/serve-turn-store.ts:165` (definition, returns `false` at the
  bound); `src/lib/serve-turn.ts:338` (the only caller, discards it).
- enumeration_method: a grep across `src` for `appendTurnEvent(`, excluding tests
  — the definition and exactly one caller; the class has one member and it
  ignores the result.

### F-008 — no error boundary on the listener

- **Severity**: major
- **File**: `src/lib/serve-server.ts:735` · review-logic

`Bun.serve` gets no `error` handler and `handleServeRequest` has no try/catch,
while the submit path calls writers documented as propagating EACCES/ENOSPC/EROFS.
A disk-full or permission failure escapes as Bun's default 500 page carrying the
message and stack — including the absolute home-directory path the projects route
was specifically hardened to stop disclosing.

**class_scope** — the class is "a throwing writer reachable from an HTTP handler
with no error boundary".

- sites: `src/lib/serve-server.ts:735` (`Bun.serve`, no `error` handler);
  `src/lib/serve-server.ts:569` (`handleServeRequest`, no try/catch);
  `src/lib/serve-turn-store.ts:155`, `:170`, `:234`, `:274` (the four writers
  `config-dir.ts:193` documents as propagating what the write throws).
- enumeration_method: a grep across `src` for `handleServeRequest` and `Bun.serve`
  gives the boundary (one of each); then every `writeOwnerOnlyFile` /
  `appendOwnerOnlyLine` call in the modules the route reaches.

### F-009 — two source-level guards are decorative

- **Severity**: major
- **File**: `src/harness/policy/profiles.test.ts:240`,
`src/lib/serve-server.test.ts:381` · review-testing-practices

The "no fourth copy of a profile literal" and `localBaseline` seam guards copy
the comment about decorative guards and not the construction. Their self-checks
re-evaluate the regex on a string literal instead of driving the tree loop, and
neither asserts the scan reached the tree. Both currently have a zero
denominator.

Compounding it: the `localBaseline` guard's second clause is dead —
`/localBaseline\s*:/` does not match `localBaseline?:` because `?` is not `\s` —
so the stated rationale in its comment is wrong.

**class_scope** — the class is "a source-level guard and whether its self-check
drives the same seam as its tree assertion".

- sites: `src/lib/config-dir.writers.test.ts:190` (correct — drives
  `offenders()`, has scan-reach and numerator controls);
  `src/lib/config-dir.readers.test.ts:460` (correct — drives `readOffenders()`,
  same controls); `src/harness/policy/profiles.test.ts:221,240` (defective —
  inline predicate, no scan-reach, no numerator);
  `src/lib/serve-server.test.ts:352,381` (defective — same).
- enumeration_method: a grep across `src` for `scanSync` on both branches gives
  the four source-level guards; each was then read for whether its self-check
  calls the seam its tree assertion calls.

### F-010 — AC10's inventory test compares two empty inventories

- **Severity**: major
- **File**: `src/lib/serve-turns.route.test.ts:475` · review-testing-practices

The fixture creates only an empty `.metaproject/`, so both sides are `{}`. It can
detect a created file (it did catch the HMAC key) but not a modified one — which
is the failure AC10 names. The helper's own docstring claims "so an inventory
cannot be empty by accident". The sibling copy in `serve-server.test.ts` plants
`flow.json` and asserts the plant; this copy lost that control.

**class_scope** — the class is "a before/after inventory assertion and whether
its fixture can be empty".

- sites: `src/lib/serve-turns.route.test.ts:475` (vacuous — empty project
  fixture, no plant assertion); `src/lib/serve-server.test.ts:963` (correct —
  plants `flow.json` and asserts the plant).
- enumeration_method: a grep across the test files of both branches for
  `function inventory(` — two copies of the helper, one without the non-vacuity
  control.

### F-011 — a throttle test asserts a property that is false

- **Severity**: major
- **File**: `src/lib/serve-throttle.test.ts:122` · review-testing-practices,
review-highload, review-security-code

`flooding the table does not clear an existing cooldown` asserts only
`size() <= MAX_TRACKED_PEERS`, a duplicate of the previous test, while its own
comment records that the flood does evict the target. The underlying defect is
real: a throttled peer never reaches `recordFailure`, so its `seenAt` freezes and
oldest-first eviction takes it first — the exact escape the implementation
comment claims to prevent.

**class_scope** — the class is "a test whose title claims a property its
assertions do not cover", and separately "a comment asserting a control the code
does not perform".

- sites: `src/lib/serve-throttle.test.ts:122` (the test); `src/lib/serve-throttle.ts:145`
  (the implementation comment claiming throttled peers are not preferred for
  eviction); `src/lib/serve-throttle.ts:96` (`check`, which reads but never
  writes `seenAt` — the reason the claim is false).
- enumeration_method: every test in `serve-throttle.test.ts` was read and its
  title compared against its assertion set; this is the only one whose
  assertions do not intersect its title. The implementation claim was then
  traced to the two functions that decide `seenAt`.

### F-012 — merging the two branches turns the readers guard red

- **Severity**: major
- **File**: `src/lib/serve-turn-store.ts:284` · review-logic,
review-testing-practices, review-architecture · executed, not inferred

Running PR #219's scanner over the PR #220 tree reports
`lib/serve-turn-store.ts :: readdirSync(` — one new offender across 337 non-test
files. Each branch is green alone; the merge commit is not. Both flows' "full
`bun test` green" claims do not compose.

**class_scope** — the class is "a file on #220 that resolves a config path and
makes a raw read, measured against #219's guard".

- sites: `src/lib/serve-turn-store.ts:284` (`readdirSync`, the only new offender);
  `src/session/store.ts` (`readFileSync`, already fixed on #219).
- enumeration_method: executed the guard itself rather than searching — ran
  `scanFor(treeSources(src), {calls: RAW_READ_CALLS, exemptions: READ_EXEMPTIONS})`
  from #219's `config-dir.scan.ts` over the #220 working tree, 337 non-test
  files. The guard's own denominator, so the list is exhaustive by construction.
  The write side reported nothing.

### F-013 — flow 130's AC8 covers a subset of its own class

- **Severity**: major
- **File**: `src/commands/serve.recovery.test.ts:487` · review-logic

AC8 claims every operator instruction printed by `keryx serve` is executed
verbatim, but the extractor matches only `keryx serve config …`. Fifteen printed
instructions were enumerated; the `token issue` / `token rotate` and bare
`keryx serve --acknowledge-non-loopback` forms are `toContain`-asserted only.

A confirmed criterion covering a subset of its own class is the site-not-class
pattern the flow was opened to close.

**class_scope** — the class is "an operator instruction printed by `keryx serve`
that AC8 claims is executed verbatim".

- sites: `src/lib/serve-server.ts:173`, `:179`, `:188`, `:198`, `:220`, `:230`;
  `src/commands/serve.ts:229`, `:232`, `:406`, `:593`, `:672`;
  `src/lib/serve-config.ts:508`, `:510`, `:520`; `src/lib/serve-credential.ts:333`
  — fifteen printed instructions. The extractor at
  `src/commands/serve.recovery.test.ts:487` selects only the `config` subset.
- enumeration_method: a grep for `keryx serve ` across `serve.ts`,
  `serve-server.ts`, `serve-config.ts` and `serve-credential.ts`, filtered to
  lines containing Run/Re-run/rotate/issue — fifteen instructions; each was then
  matched against the extractor's regex.

### F-014 — a behavioural regression in session resume

- **Severity**: major
- **File**: `src/session/store.ts:431` · review-logic, review-architecture

`loadArchive` calls `readJsonl(archivePath)` before its fallback, so a
`TranscriptUnreadableError` on `archive.jsonl` aborts the resume even when
`context.jsonl` is perfectly readable — and `archive.jsonl` is the file most
likely to pass the 64 MiB bound. All three catch sites respond by starting a
brand-new session, so a resumable conversation is dropped rather than resumed
without its archive.

Related and contested between reviewers: `src/commands/sessions.ts:70` and
`src/tui/tui-shell.ts:1563` do not guard the new throw. review-architecture calls
both unguarded; review-logic assessed the CLI one as degrading acceptably via
`main().catch`.

**class_scope** — the class is "a caller of the newly-throwing transcript
readers and whether it guards the throw".

- sites: `src/commands/shell.ts:213`, `:870` (guarded);
  `src/tui/tui-shell.ts:1407`, `:1436`, `:1444`, `:1454` (guarded);
  `src/tui/tui-shell.ts:1492` (inside the catch, does not load);
  `src/commands/sessions.ts:70` (UNGUARDED); `src/tui/tui-shell.ts:1563`
  (UNGUARDED); `src/session/store.ts:431` (`loadArchive`'s own pre-fallback
  read — the behavioural regression).
- enumeration_method: a grep for `openSession(`, `exportSessionMarkdown(`,
  `loadContext(` and `loadArchive(` across `src` on `fix/216-round4-findings`,
  excluding tests, gave 11 call sites; each enclosing block was then read for a
  try/catch — 9 guarded or non-loading, 2 unguarded.

---

## Minor and info (abridged; full set in the reviewer results)

- A literal NUL byte in `src/lib/serve-turn-store.test.ts:83` makes git treat the
  file as binary, so that entire test suite was unreviewable in the PR diff
  (`Bin 0 -> 11891 bytes`). Use the ` ` escape.
- `emit("turn.started")` precedes the containment check whose comment says "a
  turn that began is a turn whose evidence says it began" — comment contradicts
  code, the class flow 130's AC9 exists for.
- `finishTurn` is not atomic (plain write, unlike the session store's
  temp+rename), so a crash mid-write makes a live turn 404.
- Empty `Last-Event-ID`: `Number("")` is 0, so event 0 is lost rather than
  replayed from the beginning.
- `sessionId` is accepted on shape alone — no existence or ownership check.
  Harmless today; an IDOR when R4d gives sessions state.
- `config set --profile` accepts any string while only two values start.
- No retention for `turns/` — every turn and every idempotency key is permanent.
- Write paths skip `isTurnId` while read paths apply it.
- `SubmitTurnOutcome` / `SubmitOutcome` are two hand-maintained copies of one
  union.
- Four of five profile constructors are unpinned, including both shell profiles
  (`network: allow`, `delegate: allow`).
- The throttle is never exercised through the real listener.
- The AC2 parity test never goes through the HTTP path — both sides call the
  runner directly.
- `POST /v1/turns` awaits the whole run before answering 202, and no
  concurrent-turn bound or wall-clock limit exists; `budget.maxSeconds` is
  declared and never read.
- `drain()` force-closes an in-flight turn, leaving a record stuck at 409 with no
  reconciliation, and its comment still claims the window is empty because the
  handler is synchronous.
- Flow 130's journal AC4 claim says the guard reported both reads; the scanner
  emits one offence per (file, call) pair and the recorded output shows one
  entry. The claim overstates the evidence.
- Test-support code (`config-dir.scan.ts`) lives in the production source tree;
  defensible but unpinned.
- `resolveServeStartup` / `describeServeStatus` sit in the transport module and
  want extracting.

---

## What held up

Recorded because the review attacked these and could not break them.

- Authentication runs before the URL is parsed; no path leaks to a stranger, and
  the 429 is not an oracle — a correct token bypasses the throttle block
  entirely, so 401/429 never distinguishes a valid token from an invalid one.
- Route matching is structural; `%2e%2e` and `%2f` survive as literals and fail
  `isTurnId`. No caller-supplied string reaches a path join anywhere: the
  idempotency key is hashed, the turn id is regex-gated before every read, and
  `resolveProject` returns the registry's own stored path rather than the
  caller's.
- `origin` is a refused unknown field, not an overwritten one.
- `compareProfiles` was probed with prototype pollution, non-enumerable keys,
  inherited keys, a flipping getter, missing `requiredControls` and seven
  non-string values — all fail closed. `trustMode` is the only real gap.
- All four moved profile fingerprints were verified by computation to be
  byte-identical to `main`. No evidence record's `policyFingerprint` moves.
- Dependency direction is clean: no HTTP type, header or framing concept crosses
  into a harness contract, and nothing under `src/harness`, `src/security`,
  `src/flow` or `src/session` imports `src/lib/serve-*`.
- `isTurnId` and `isUuid` do not match a trailing newline, so there is no
  newline-smuggling bypass.
- On #219, `statSync` following symlinks is consistent with `readFileSync`
  following them, so `isFile()` is not symlink-bypassable.
- Determinism and isolation: no fixed ports, no exit code read through a pipe,
  nothing touches the real `~/.local/share/keryx`, and the command suites restore
  `console.*`, `XDG_DATA_HOME`, `APPDATA` and `process.exitCode`.
- `config-dir.writers.test.ts` and `config-dir.readers.test.ts` are the strongest
  tests in either PR and are the template the two decorative guards should copy.

---

## Recommended order

NOTE ON FORMATTING: no line below begins with a finding identifier. The ingest
parser treats a line-opening `F-NNN` as the start of a new finding, and the first
draft of this section wrapped several prose references to line-start, producing
eight phantom findings in the recorded package. That is a defect in the pipeline,
recorded as the last finding in this report, not a property of the findings.

1. Fix and land PR #219 first. Its own findings are the AC8 subset, the session
   resume regression, and the journal claim about what the guard reported. It
   must land first because `readTranscriptFile` is the helper PR #220 needs in
   order to fix the event-log bound.
2. Rebase PR #220 onto it. Both branches modify the same region of
   `config-dir.ts` in disjoint directions, so a conflict is guaranteed; resolving
   it after #219 lands is the cheap direction. Add the `readdirSync` per-call
   exemption in the same pass.
3. Then fix #220, in this order: wire the turn runner into the listener; route
   the event log through the transcript-class bound; the injection threshold;
   `trustMode` in the comparator; claim ordering; the id collision; the terminal
   event at the backlog bound; the error boundary; and rebuild the two decorative
   guards from the `config-dir` template.
4. Re-review. A fix round is new code and deserves its own round — the lesson
   this repository has already paid for three times.

---

### F-015 — the ingest parser still creates phantom findings from prose

- **Severity**: major
- **File**: `src/review/managed.ts:315`
- **Found by**: running this review through `keryx review ingest`

Commit `9d4d3b84` fixed the case where a finding identifier appears mid-line in
prose, by requiring the identifier to OPEN the line after optional markdown
heading or list markers. That is necessary and not sufficient: ordinary text
wrapping routinely puts a reference at line-start, and an opening parenthesis
before it is not one of the accepted markers.

This report's first ingest produced eight phantom findings from its own
"Recommended order" section, each with `class_scope_present: false`. Two came
from lines whose first characters were an opening parenthesis and an identifier;
the rest from wrapped references where an identifier landed at line-start
followed by a comma or a closing parenthesis.

The rewrite of that section then reproduced the defect a second time, from the
paragraph describing it — which is as direct a demonstration as the pipeline is
going to give.

**Why it matters**: a phantom parsed as `major` would make the ingest guard
refuse an otherwise complete report — the guard would fire on a finding that does
not exist. This is the same class as the defect `9d4d3b84` fixed, and it is the
sixth defect in this pipeline found by running it rather than reading it.

**class_scope** — the class is "text that is not a finding heading being parsed
as one".

- sites: `src/review/managed.ts:315` (`FINDING_HEADING`, the regex);
  `src/review/managed.ts:322` (`findingBlock`, which ends the previous finding's
  body at the same false heading).
- enumeration_method: ran `keryx review ingest` on this report and read
  `findings.json`; 14 real findings and 8 phantoms, every phantom traced back to
  a line in the "Recommended order" section by matching its recorded `summary`
  against the report text.

**Fix**: identify a heading positively rather than by position alone. An
identifier that opens a line and is followed by `,`, `)` or `.` is a reference; a
heading is followed by a title separator, or carries a markdown heading or list
marker. Pin both directions with a test built from this report.
