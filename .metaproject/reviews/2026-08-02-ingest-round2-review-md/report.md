# Fix-round review, round two — PR #220 (flow 133)

## Verdict: REQUEST_CHANGES

Four reviewers over `2799ec92...HEAD`: closure verification, logic + security,
testing practices, architecture + comment truth. The tree was green throughout
at 2844 pass / 0 fail.

**Round one's ten findings: eight closed, two closed at the site but not the
class.** Five of round one's six green mutations are now red. The machinery
works.

**Round two found four new blockers, all introduced or left standing by the
fixes.** Every one was reproduced independently during consolidation.

One round-one-style finding was raised and is FALSE — recorded below so it is
not "fixed" into a regression.

## Stats (after dedupe)

- blocker: 4
- major: 9
- minor: 11
- false: 1

---

## Blockers

### F-001 — a harness run that FAILED is recorded as `completed` / `ok`, on the default install

- **Severity**: blocker
- **File**: `src/lib/serve-turn.ts:587`
- **Found by**: closure verification, by execution; reproduced during consolidation.

`runRemoteTurn` reads exactly one field off the harness run — `run.output.summary`
— and then calls `terminate("completed", "ok", …)` unconditionally.
`HarnessRunOutput` also carries `status`, a completion `gate`, and
`unresolvedBlockerIds`. All three are discarded.

Driven over a real socket with the production assembly, on a config directory
with no saved provider — which is what an operator gets after `keryx init`:

```
status  : 202
outcome : completed
reason  : ok
text    : "Startup blocked: missing required provider precondition(s): model."
```

The harness reported `status: "failed"`, `gate.status: "blocked"`,
`unresolvedBlockerIds: ["blocker:startup"]`. The record says the turn succeeded.
`outcome` is the field a client branches on.

This is not a regression introduced by the fix round — the fields were never
read. It is a blocker because the fix round claimed the opposite. The socket
suite added to close the previous blocker asserts `outcome === "completed"`, and
it passes here: **the capability assertion is satisfied by a failure**, because
the failure is recorded as a success one layer below the assertion. That is the
same shape as the blocker it replaced, one level deeper, in the test written to
prevent it.

**class_scope** — the class is "a terminal signal the harness run produces that
the transport must map into the recorded outcome".

- sites: `src/lib/serve-turn.ts:587` (`run.output.summary` — read, correct);
  `run.output.status` (DEFECTIVE — never read, and it is the field that says what
  the run did); `run.output.gate.status` (DEFECTIVE — never read);
  `run.output.unresolvedBlockerIds` (DEFECTIVE — never read); `run.events` at
  `:629` (read, correct); `run.decisions` at `:619` (read, correct — the `asked`
  path, and the model for what the other three should look like).
- enumeration_method: read every member of `HarnessRunOutput` in
  `src/harness/run/run.ts:81-95`, then grep for `run.output` inside
  `serve-turn.ts` — one hit. Then executed `runOffline` with the exact input
  `runRemoteTurn` builds, and separately drove the whole path through
  `startServeListener` with the production `makeSubmitTurn`.

### F-002 — the injection refusal returns an exit code no runtime treats as a refusal

- **Severity**: blocker
- **File**: `src/commands/security.ts:670`
- **Found by**: logic + security, by execution; reproduced during consolidation.

`exitCodeFor` returns `1` for a refusal. keryx's own hook layer, one directory
away, records and implements the contract:

```
src/ctx/runtimes.ts:27   // blocking (Claude/Codex/Windsurf: exit 2 + stderr) …
src/ctx/runtimes.ts:189  return { exitCode: 2, stderr: … };
```

Exit 1 on a Claude Code hook is a non-blocking error: stderr is surfaced and
execution continues. For the flat runtimes the security installer writes a
bespoke `{on, command}` schema with no exit-code contract at all.

So the sentence the fix was built on — "a guard that reports to a log nobody
reads and returns success is not a guard" — is answered by returning a code the
runtime treats the same way it treated success. Two modules in one repository
disagree about the block signal and only one was consulted.

The new test asserts `exit: 1`. That is the envelope: it proves the command
returns a number, and nothing about whether any runtime acts on it.

**class_scope** — the class is "a keryx CLI whose exit code is claimed to be a
proceed/refuse decision for an agent runtime".

- sites: `src/commands/security.ts:670` (`exitCodeFor` — DEFECTIVE on all three
  refusal paths: the injection rule, the gate fail, and needs-approval);
  `src/ctx/runtimes.ts:189` (correct — exit 2, and it is the authority);
  `src/security/agent-hooks/runtimes.ts` (DEFECTIVE by omission — supplies no
  exit-code contract for any of the four runtimes it installs into).
- enumeration_method: grep for `exit 2|exitCode:` across `src` and `docs`, then
  read both runtime registries side by side.

### F-003 — the claim is released on the one throw that proves the turn RAN, so one key buys two provider calls

- **Severity**: blocker
- **File**: `src/lib/serve-turn.ts:785`
- **Found by**: logic + security and closure verification independently, both by
  execution; reproduced during consolidation.

The release path added for round one's F-004 is documented as "the one place that
knows a claim was taken and not used". For `TurnRecordUnwritableError` — the
throw this round added — the claim WAS used: `terminate` throws only after the
provider has streamed its whole answer and `emitTerminal` has appended
`turn.finished`.

```
throw: the durable record for turn 1111… could not be written
events durably recorded: turn.started, assistant.delta, turn.finished
assistant text on disk : "THE ANSWER THE OPERATOR PAID FOR"
second submission, SAME key: {"kind":"accepted","turnId":<new>}
provider calls for ONE key : 2
turn directories on disk   : 2
```

The route answers a bare 500, which is what a well-behaved client retries.
At-most-once becomes at-least-once for a billed, network-reaching operation, and
the fault class that triggers it is not usually transient.

**class_scope** — the class is "a failure between the claim and the terminal
record, and whether releasing the claim on it is correct".

- sites: `src/lib/serve-turn.ts:369` (`createTurnRecord` — before any effect,
  release correct); `:437` on `turn.started` (correct); `:437` on an
  `assistant.delta` (DEFECTIVE — the provider has already streamed); `:460`
  (`emitForced` — DEFECTIVE, same); `:505` (`finishTurn` →
  `TurnRecordUnwritableError` — DEFECTIVE, demonstrated); `:593` (`runOffline`'s
  catch, becomes a terminal `failed` and never throws — correct).
- enumeration_method: read `runRemoteTurn` linearly and partitioned every
  throwing step by whether it is reachable after the first `provider.stream()`
  yield, then executed the first post-effect member with a counting provider and
  a pinned turn id.

### F-004 — the production containment default is never executed under assertion

- **Severity**: blocker
- **File**: `src/lib/serve-runner.ts:97`, `src/lib/serve-turn.ts:528`
- **Found by**: testing practices, mutation-proven; reproduced during
  consolidation.

The bidirectional probe test supplies the seam in both directions, so the
production default is never evaluated. Two mutations, both against the full
suite:

```
serve-runner.ts:97  real probe -> () => false   (round one's blocker, restored)
                                                    947 pass / 0 fail
serve-turn.ts:528   fail-closed () => false -> () => true
                                                   2858 pass / 0 fail
```

The second is worse in direction: it makes every turn under
`required-fail-closed` run UNCONTAINED whenever the composition root forgets the
seam, which is precisely what happened last round, and nothing observes it.

Five of the seven tests in the file run `remote-read-only`, whose isolation is
`not-required`, so the gate is never reached; the one test that reaches it
substitutes the thing under test. There is no test in which the shipped default
runs against the real probe.

The earlier verification of this fix was too coarse: it removed the seam
plumbing along with the default, so a test that supplies the seam failed for an
unrelated reason and the check was read as a pass.

**class_scope** — the class is "a seam with a production default, where every
test that reaches the branch supplies the seam".

- sites: `src/lib/serve-runner.ts:97` (DEFECTIVE — mutation-proven twice);
  `src/lib/serve-turn.ts:528` (DEFECTIVE — the fail-closed fallback, mutation-proven);
  `src/lib/serve-server.ts:249` (`localBaseline` default — correct, replacing it
  goes red in five tests, and it is the positive control for this class);
  `serve-turn.ts:686` (`newId` default — correct, pinned by the distinctness
  assertion); `:685` (`clock`) and `:687` (`toolRegistry`) — not weakening seams.
- enumeration_method: read the three seam-bearing option bags field by field,
  then for each asked whether any test reaches the branch with the seam ABSENT;
  each production default was then replaced and the owning suites executed.

---

## Major

### F-005 — the real PreToolUse guard is still inert for the injection class, and the comment names it as the one that was fixed

- **Severity**: major
- **File**: `src/commands/security.ts:648`, `src/security/agent-hooks/runtimes.ts:80`

`AGENT_CHECK_INPUT_COMMAND` is installed on `UserPromptSubmit`. `PreToolUse`
carries `AGENT_CHECK_OUTPUT_COMMAND`, with no `--source`, so `parseSource`
defaults to `generated` and `refusesOnInjection` — which requires
`untrusted-external` — never fires there. The class the round enumerated as three
sites has a fourth, and it is the tool-call guard the fix's own comment claims to
be describing.

The claim was inherited verbatim from round one's report and not checked, in the
round whose stated discipline is checking claims. The evidence was in the
session's own hook output the whole time.

**class_scope** — the class is "a site that turns a security decision into a
proceed/refuse for content that can drive agent execution".

- sites: `src/lib/serve-turn.ts:322` (FIXED, round one);
  `src/commands/security.ts:670` via `UserPromptSubmit` (FIXED this round, but see
  F-002 for the exit code); `PreToolUse` → `check-output` with source `generated`
  (DEFECTIVE — never considered); `src/security/guard.ts:119` (unchanged —
  correct, its inputs are content keryx produced); `src/mcp/tools.ts:136`
  (returns the decision, gates nothing — correct).
- enumeration_method: read every `merge` implementation in
  `src/security/agent-hooks/runtimes.ts` and matched each hook event to the
  command it installs, then executed each `--source` value through the real CLI
  in each mode.

### F-006 — an attacker keeps one address unthrottled forever by interleaving one throw-away address per nine guesses

- **Severity**: major
- **File**: `src/lib/serve-throttle.ts:189`

Rule 1 protects the peer that just inserted. It does not protect a peer with
accumulated but sub-limit failures from being evicted by somebody else's insert,
and on a table saturated with cooldowns that peer is the only non-cooldown
candidate, so it is always the victim.

```
1800 guesses from one address, 200 throw-away requests
  ever throttled: false
control (empty table): throttled after 10
```

The victim class was never named. That is the same omission as round one's Shape
C, on the fix for Shape C.

**class_scope** — the class is "an eviction policy that can discard a peer's
accumulated failure count".

- sites: `serve-throttle.ts:189` (oldest-non-cooldown branch — DEFECTIVE, evicts a
  peer at 9 of 10); `:182` (soonest-expiring branch — evicts the attacker's own
  ban first, documented but untested); `:179` (`justInserted` exclusion — correct,
  mutation-proven red in three tests).
- enumeration_method: enumerated the four states a tracked peer can be in when
  eviction runs, matched each to a test, and drove the unmatched ones against the
  real class with an injected clock.

### F-007 — enforced mode would refuse 3.3% of this repository's own prose and source

- **Severity**: major
- **File**: `src/commands/security.ts:695`

`refusesOnInjection` is unconditional and unappealable: no confidence floor, no
override. Over 300 ordinary `.md` and `.ts` files scanned as
`untrusted-external`, 10 refuse — including this project's own operator guide and
sandbox specification. `README.md` refuses. The single benign control in the new
test cannot measure a false-refusal rate.

**class_scope** — the class is "a detector class deliberately held below the gate
threshold, promoted to an unappealable refusal at one call site".

- sites: `src/commands/security.ts:674` (`check-input` — DEFECTIVE);
  `src/commands/security.ts:224` (`handleScan` shares `exitCodeFor`, so
  `keryx security scan --source untrusted-external` inherits it — unexamined);
  `:412` (`check-output` — unaffected, its default source is `generated`).
- enumeration_method: grepped every caller of `exitCodeFor`, then executed
  `analyze()` over a 300-file corpus of the repository's own content in all three
  modes.

### F-008 — three of the four source-level guards match a list of spellings where they mean a shape

- **Severity**: major
- **File**: `src/harness/policy/profiles.test.ts:317`, `src/lib/serve-server.test.ts:421`, `src/lib/config-dir.readers.test.ts:662`

Mutation-proven, each planted in a real production file:

| guard | evasion | result |
|---|---|---|
| `RANK_LITERAL` | quoted keys (`{"read-only": 0}`), if-chain, array + `indexOf`, multi-digit | GREEN |
| weakening seam | ES6 shorthand `{ containmentAvailable }` | GREEN |
| scanner importer | `require(…)`, `await import(…)` | GREEN |

Three of the five trustMode/isolation vocabulary words cannot be written
unquoted, and `code()` blanks quoted keys — so a verbatim copy of the tables the
guard exempts is invisible to it by construction. Both invisible import forms are
live in this repository.

`RANK_SWITCH` and `PROFILE_LITERAL` are correct and mutation-red; the round-one
mutation they were built for now fails as intended.

**class_scope** — the class is "a source-level guard whose predicate enumerates
spellings of a shape rather than the shape".

- sites: `profiles.test.ts:317` (`RANK_LITERAL` — DEFECTIVE); `:318`
  (`RANK_SWITCH` — correct); `:293` (`PROFILE_LITERAL` — correct);
  `serve-server.test.ts:421` (DEFECTIVE, both seams); `:418` (the per-FILE
  exemption of `lib/serve-turn.ts` — DEFECTIVE, it hides F-004's second site);
  `config-dir.readers.test.ts:662` (DEFECTIVE); the two `config-dir` guards via
  `scanFor` (correct — call-shape based).
- enumeration_method: for each guard, reconstructed at least two alternative
  spellings of the same offence, planted each in a real production file, and ran
  the owning suite.

### F-009 — seven branches added or changed this round have no test

- **Severity**: major
- **File**: `src/lib/serve-server.ts:882`, `src/harness/mutation/execute.ts:119`, `src/harness/child/model.ts:205`, `src/lib/serve-server.ts:558`, `src/security/service.ts:173`

Each mutated to its fail-open or pre-fix form, owning suite green:

- the `Bun.serve` `error:` handler — replaced with the old shape AND `cause.stack`
  in the body: 942 pass. Both the protocol-shape fix and the stack suppression are
  free.
- `execute.ts:119` — the new fail-closed branch on an unreadable posture, made
  fail-open: 1089 pass.
- `model.ts:205` — the unreadable-posture leg of the network gate, made fail-open:
  1089 pass.
- `serve-server.ts:558` — the `unavailable` → 500 branch added this round,
  collapsed back to a `sessionId: ""` 200: 97 pass.
- `src/security/service.ts` — the whole per-instance memo: nothing asserts a
  second `redact` agrees with the first, nothing asserts a fresh instance picks up
  a changed config, nothing pins that the cache is instance-scoped.

**class_scope** — the class is "a branch this diff adds or rewrites, and whether
any test observes it".

- sites: the five above (UNTESTED); `execute.ts:124`, `:130` (tested);
  `isolation.ts:169` (tested — flipping the direction is red in three);
  `ranks.ts:154` (tested — the pre-fix order is red in two).
- enumeration_method: read the diff file by file over every production module,
  listed every branch whose condition or return changed, grepped each new message
  string for a test naming it, then mutated each to its fail-open form.

### F-010 — `ensureTurnDir` still runs on every recorded append

- **Severity**: major
- **File**: `src/lib/serve-turn-store.ts:194`

The reorder moved the directory walk after the bound check, which removes it only
for events the bound REFUSES. For every event that is recorded it still runs:
17.6 µs against an 8.5 µs write, 67% of the append. Backing the reorder out moves
1,000 deltas from 53 ms to 54 ms — the site the fix names is worth 1 ms, and the
sibling it left is worth the other 17.

The `redactOut` half is a real fix and is measured: 81.9 → 11.8 µs isolated,
134 → 53 µs per delta end to end with the memo backed out as the control.

**class_scope** — the class is "per-event work in the append path that does not
vary per event".

- sites: `serve-turn-store.ts:194` (`ensureTurnDir` on a recorded append —
  DEFECTIVE, the directory exists after the first event); `:196`
  (`appendOwnerOnlyLine` — correct, one write per record, the point of the
  design); `serve-turn.ts:549` (`redactOut` — FIXED this round).
- enumeration_method: timed each call in the append path in isolation against the
  real modules, then reconciled with an end-to-end run at 1,000 and 10,000 deltas
  with each fix backed out separately as its own control.

### F-011 — round one's F-008 is closed at the site and not at the class

- **Severity**: major
- **File**: `src/lib/serve-server.ts:558`

Both named branches are now mutation-red. The sibling added by the same round is
not: collapsing `SubmitOutcome.unavailable` back to a `sessionId: ""` 200 leaves
97 tests green. That is the exact answer shape round one's F-004 called "a null
record standing in for a stated failure, on the one path that reaches a success
status" — reintroduced as an untested branch.

**class_scope** — the class is "a `TurnReadFailure` mapped onto a caller-visible
outcome, and whether a test pins it".

- sites: `serve-server.ts:715` (record route 500 — TESTED, red);
  `serve-server.ts:596` (SSE route 500 — TESTED, red); `serve-server.ts:558`
  (`unavailable` → 500 — UNTESTED); `serve-turn-store.ts:221`
  (`absent` → empty — tested at the store).
- enumeration_method: enumerated the six-member union, traced each to its branch,
  and mutated each branch to its pre-fix answer.

### F-012 — five policies now interpret six failure reasons, and they disagree about one

- **Severity**: major
- **File**: `src/lib/serve-turn.ts:743`, `src/lib/serve-server.ts:591`, `:714`, `src/lib/serve-turn-store.ts:221`, `:281`

Round one asked for a total function in the store instead of three policies at
three call sites. This round added a fourth explicit site. `not-regular` — a
`turn.json` replaced by a directory or a FIFO — is a 500 through the submission
path, a 404 through the record route, and a 200 with an empty body through the
events route. The record route's comment enumerates five of the six members and
misses that one.

**class_scope** — the class is "a site that maps a `TurnReadFailure` onto a
different vocabulary".

- sites: `serve-turn-store.ts:221`, `:281`; `serve-turn.ts:743` (added this
  round); `serve-server.ts:591`, `:714`. Five policies, six members.
- enumeration_method: produced each of the six members against the real store on a
  temp root, then read each of the five policies for what it returns.

---

## Minor (abridged)

- `TurnRecordUnwritableError`'s docstring says it is typed "so `createSubmitTurn`
  can tell it from a filesystem throw"; there is no `instanceof` anywhere. The
  round closed that shape for `finishTurn`'s boolean and reopened it for the
  exception replacing it, in one commit.
- `releaseIdempotencyKey` returns whether it removed an entry "so a caller can
  tell"; the one caller discards it.
- The throttle's rule 3 says the soonest-expiry branch "is what runs on a
  saturated table"; measured, it fires once in 500. And it defends the ordering
  with "rather than on the oldest bans" while a constant cooldown makes
  soonest-expiring exactly the oldest ban.
- `MAX_TRACKED_PEERS`'s docstring still says "the oldest entry is evicted", which
  after this round is not the rule.
- The `MAX_TURN_FILE_BYTES` docstring gives two different figures for one
  quantity: 1 518 890 is the empty-`text` shape, 1 418 890 is bare. The derived
  6 569 is exact and correct.
- `model.ts`'s adoption of `axesOf` changed behaviour for out-of-enum postures
  and is the only one of four whose comment does not say so.
- The source scoping names four of the five `SecuritySource` members;
  `trusted-user` is scoped out and named nowhere, and `trusted-project` is
  described as content keryx produced, which it is not.
- `widened` now carries `authority` and `inputTrust`, which the docstring calls
  "schema vocabulary"; the schema has neither. They reach the operator in a
  refusal message.
- The per-instance memo caches a REJECTED promise, so one transient fault
  degrades the whole turn's redaction where each call previously retried.
- `serve-server.ts`'s value-import closure is unchanged at 42 modules, 33 of them
  reached only through `serve-turn.ts`, for two pure validators.
- The composition-root wiring is still held by `tsc` alone.

---

## The finding that is FALSE

Recorded so it is not "fixed" into a regression.

One reviewer reported that the SSE route returns 200 with an empty body for an
unreadable record, quoting the line as `new Response("", …)`. It is
`errorResponse(500, "record-unreadable", …)`. Driven through the route:

```
SSE on an unreadable log -> status 500 | body: {"error":{"code":"record-unreadable",…
```

The comment above it is what misled the reader: it opens "200 with an empty body
is the answer this route used to give" without signposting the past tense. The
code is correct; the prose is not, and it should be rewritten.

---

## What held up

- The throttle blocker of round one is genuinely closed: a fresh peer on a
  saturated table is throttled at attempt 10, where the pre-fix rule never
  throttled it in 1000.
- The `trustMode` split is behaviour-preserving across all nine ordered pairs,
  checked through both `broadeningAxes` and the real `inheritPolicy`, and the one
  pair that moved is the fail-open it was raised for. No fingerprint moves. All
  four consumers are on the projection and all four fail closed out of enum.
- `finishTurn`'s boolean is consumed and pinned; the test corrupts the record from
  inside the provider's stream rather than by stubbing the store.
- The claim-release pair is honest and mutation-red in both directions, including
  the turnId guard.
- The backlog test is a test, not a benchmark: 10 000 events in 400–730 ms against
  a 120 s timeout, red for `force` and for `bounded` independently.
- `RANK_SWITCH` closes round one's F-007 for the recorded defect: the two
  historical `switch` functions pasted back verbatim are now red.
- The socket suite's 401 control is real now — deleting authentication is caught
  by `listTurnIds`, not by a constant id no production path mints.
- Determinism is clean throughout, and a before/after inventory of the real
  user-global directory across a `check-input` subprocess shows 34 files before,
  34 after, zero changed.
- Every self-check drives the same seam as its tree assertion; the `return []`
  failure mode is gone from all five guards.
</content>
