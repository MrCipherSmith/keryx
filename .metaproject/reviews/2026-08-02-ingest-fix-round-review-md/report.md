# Fix-round review — PR #220 (flow 133)

## Verdict: REQUEST_CHANGES

Five reviewers ran in parallel over `de4a1ee9...HEAD`: logic, security, testing-practices,
architecture + core-boundaries, highload. Two blockers and eight majors.

**Both blockers are regressions introduced by this fix round.** That is the third
consecutive round in this repository to do it, which is the recorded lesson the
round was supposed to be applying rather than demonstrating.

The strongest signal is convergence. One finding was reported independently by all
five reviewers, two by four, and three of the four highest-severity ones were
demonstrated by execution rather than by reading.

## Review scope

- Range: `de4a1ee9...HEAD` — the rebase exemption, the two fix commits, the NUL escape.
- Reviewers: review-logic, review-security-code, review-testing-practices,
  review-architecture + review-core-boundaries, review-highload — all through a
  general-purpose runtime, because no native agent type exists for any of them.
- The tree was GREEN throughout: 2820 pass, 14 skip, 0 fail. Every finding below
  is against a passing suite.

## Stats (after dedupe)

- blocker: 2
- major: 8
- minor: 16
- info: 5

---

## Blockers

### F-001 — the throttle can be switched off globally, and this round switched it on

- **Severity**: blocker
- **File**: `src/lib/serve-throttle.ts:167`
- **Found independently by**: review-logic (blocker), review-highload (blocker),
  review-security-code (major), review-testing-practices (major) — three of them
  by execution, and reproduced a fourth time during consolidation.

`evictIfFull` now skips peers serving a cooldown. It runs from `recordFailure`
immediately after the new peer is inserted, so when every other tracked peer is in
cooldown the newcomer is the ONLY unthrottled candidate — and it evicts itself on
every failure. Its record is re-created empty on the next call and it can never
reach `AUTH_FAILURE_LIMIT`.

Measured on the real class:

```
after saturation: size 1024 of max 1024, all in cooldown
fresh peer, 1000 consecutive failed authentications -> ever throttled? false
control (empty table)                               -> throttled after 10
PRE-fix rule against the identical state            -> throttled after 10
```

Saturation costs 1024 x 10 = 10,240 failed authentications and about 171
requests/second to hold. Reachable on the default loopback bind: Linux lets any
unprivileged local process source from anywhere in `127.0.0.0/8`, which was
verified against a live listener — 16.7M distinct throttle keys.

The old code had the escape the previous review named, where a flood clears your
own ban. The new code has a strictly larger one: saturate, and every address gets
unlimited token guessing. The adversary this control exists for is exactly a
different local user brute-forcing the bearer token, because `auth.json` is 0600
and the listener is loopback.

The implementation comment states the mechanism and draws the opposite conclusion
from it — "the peer that overflows the table is itself unthrottled and is
available as a victim". It is available, it is the only one, and it is always
chosen. That sentence is the defect.

Three new tests were added for this area and none of them asks whether a NEW peer
can still be throttled. All three assert the bound plus a `check()` of a peer that
is already banned; the one the test picks is the first peer banned, which is the
one never evicted. That is the previous round's own finding — "a test whose title
claims a property its assertions do not cover" — reproduced by the commit that
fixed it.

**class_scope** — the class is "a decision about which peer's record exists, and
whether the peer being throttled can steer it".

- sites: `src/lib/serve-throttle.ts:182` (`peers.delete`, the only destruction —
  DEFECTIVE, caller-steerable to always select the newcomer);
  `src/lib/serve-throttle.ts:167` (the cooldown-skip branch — the mechanism);
  `src/lib/serve-throttle.ts:175` (the oldest-unthrottled branch — selects the
  newcomer when it is the only candidate); `src/lib/serve-throttle.ts:180`
  (`oldestKey ?? soonestKey` — the fallback is unreachable, so its stated
  rationale never applies); `src/lib/serve-throttle.ts:128` (`peers.set`, correct);
  `:91` and `:111` (`peers.get`, correct).
- enumeration_method: `keryx ctx rg "this\.peers\."` over the module gives six
  sites, the complete lifecycle of the only mutable state in the class, each
  classified create/destroy/read. Exactly one destroys. It was then driven with
  the real class under the state its own test constructs, with the pre-fix rule
  re-implemented from the diff as the control.

### F-002 — the newly-wired production listener refuses every turn

- **Severity**: blocker
- **File**: `src/lib/serve-runner.ts:54`
- **Found independently by**: review-testing-practices (blocker),
  review-security-code (major) — both by execution, and reproduced a third time
  during consolidation.

`assembleSubmitTurn` builds `SubmitDeps` without `containmentAvailable`.
`runRemoteTurn` defaults that seam to `() => false`, and the shipped default
profile `remote-restricted` resolves to `unattended-untrusted`, whose
`requiredControls.isolation` is `required-fail-closed`. The containment gate
therefore fires on every turn.

Driven through `startServeListener` with `assembleSubmitTurn` over a real socket —
exactly as `commands/serve.ts` composes it:

```
status 202  { turnId, sessionId }
record: {"outcome":"refused","reasonCode":"containment-unavailable"}
text:   undefined
```

The provider is never reached. A real detector exists and nothing calls it from
this path: `src/harness/process/sandbox/detect.ts:83` produces `launcherAvailable`.

This is the previous round's blocker reproduced one layer down. That blocker was
"nine of twelve criteria verified through a fixture, never against a listener the
CLI can start". The new socket suite was written specifically to close it, and its
five tests assert only shape: a refusal is also 202, a refusal also emits
`turn.started` then `turn.finished`, and a refusal's `outcome` is also defined.
Not one test asserts `outcome === "completed"`, an `assistant.delta`, or any
assistant text reaching the caller — while the fixture-driven suite asserts all
three. The runner is wired and the listener still cannot complete a turn.

Fail-closed, which is why one reviewer graded it major. It is a blocker because
steps 7, 8 and 9 of the required decision path — harness classification, the
approval boundary, outbound redaction of events and results — have no production
path at all under the default profile, and because the commit message claims
parity that is proven by a test passing on a turn that never ran.

**class_scope** — the class is "an optional dependency of the turn runner that the
composition root must supply for the capability to work".

- sites: `src/lib/serve-turn.ts:586` (`containmentAvailable`, defaults to
  `() => false` — DEFECTIVE, never supplied, and a real detector exists);
  `:587` (`clock`, default real clock — correct); `:588` (`newId`, default
  `randomUUID` — correct); `:589` (`toolRegistry`, empty by design this release —
  correct).
- enumeration_method: read the optional fields of `SubmitDeps` one by one, then
  `keryx ctx rg containmentAvailable` across `src` — 13 hits, four in
  `serve-turn.ts` and nine in tests, zero in `serve-runner.ts` or
  `commands/serve.ts`. Confirmed by executing a listener assembled exactly as the
  CLI assembles it.

---

## Major

### F-003 — the honesty boolean nobody reads

- **Severity**: major
- **File**: `src/lib/serve-turn.ts:436`
- **Found independently by**: all five reviewers.

`finishTurn` was changed from `void` to `boolean`, with a docstring reading "The
boolean is the point. This used to return void and no-op when the record could not
be read, so an unreadable `turn.json` left a turn that had finished reporting
`running`." Its only caller discards the value and `terminate` returns success
regardless.

Demonstrated two ways — a transient EACCES on `turn.json` mid-run, and a corrupted
record:

```
runRemoteTurn returned outcome: completed
on-disk record.result present?  false
GET /v1/turns/{id} would answer: 404 (or 500, or 409 forever, by failure kind)
```

The behaviour is unchanged from the `void` version. What changed is that the type
now asserts a property the code does not have, which is worse than what it
replaced, because the next reader will believe it. This is the same shape as the
previous round's finding about a caller that must act on a refused append — fixed
for `appendTurnEvent` and introduced for `finishTurn`, in one commit.

**class_scope** — the class is "a `serve-turn-store` function that reports a
refused or failed write, and whether its caller acts on the report".

- sites: `src/lib/serve-turn-store.ts:178` (`appendTurnEvent`) consumed at
  `src/lib/serve-turn.ts:381` (correct — sets `bounded`) and at `:401` (discarded,
  acceptable: `force: true` makes `false` unreachable, and it says so);
  `src/lib/serve-turn-store.ts:273` (`finishTurn`) consumed at
  `src/lib/serve-turn.ts:436` (DEFECTIVE — the only caller, discards it, and no
  test asserts the return either); `src/lib/serve-turn-store.ts:303`
  (`claimIdempotencyKey`) consumed at `src/lib/serve-turn.ts:631` (correct);
  `src/lib/serve-turn-store.ts:166` (`createTurnRecord`, returns `void` and throws
  instead — consistent, but see F-004).
- enumeration_method: read every exported function of `serve-turn-store.ts` and
  kept the ones whose return type carries a failure, then
  `keryx ctx rg` for every production call site — eight sites, each read for
  whether the signal reaches a branch. Six correct, two defective. Executed.

### F-004 — the claim still precedes four steps that can fail

- **Severity**: major
- **File**: `src/lib/serve-turn.ts:630`
- **Found independently by**: review-logic, review-highload — both end to end.

The claim moved behind the scan, so the 422 case is genuinely closed. The
docstring then justifies the new order with "a claim taken before a step that can
fail is a key burned for good" — and the run still is one. `createTurnRecord`
reaches `ensureKeryxSubdir` and `writeOwnerOnlyFile`, both documented as
propagating what the write throws, and there is still no release path for a claim
anywhere in `src`.

Demonstrated with a regular file where the turn directory belongs — the
ENOTDIR/EROFS/ENOSPC shape this module's own error-boundary rationale names:

```
submission 1 threw EEXIST -> the route answers 500
idempotency key file written?  true
record for the claimed turnId: absent
submission 2, same key:  {kind: "duplicate", turnId: <claimed>, sessionId: ""}
every later submission:  the same
```

That is the previous round's finding text reproduced verbatim after the fix — a
200 naming a turnId whose record 404s forever, and the legitimate prompt never
runs. Clearing the fault does not help; the key is burned. The new test covers the
422 path only, which is the EXAMPLE in that finding, not its stated class.

Separately, the stated trade-off is wrong in the safe direction, which should be
corrected rather than left standing. The comment claims two concurrent submissions
"can both pass the scan and both reach the claim … a duplicate turn under
contention". Measured with eight concurrent same-key submissions through the real
runner: 1 accepted, 7 duplicates, 1 record on disk, 0 empty sessionIds. The claim
and the record land in one tick, so the check-then-write is atomic against any
in-process writer. The window is smaller than the comment says, not bigger.

**class_scope** — the class is "a step reachable after the claim that can fail
without releasing it".

- sites: `src/lib/serve-turn.ts:369` (`createTurnRecord` — DEFECTIVE, demonstrated);
  `:381` (`emit` -> `appendTurnEvent` -> `appendOwnerOnlyLine` — DEFECTIVE, on
  every event); `:401` (`emitTerminal`, same writers — DEFECTIVE); `:436`
  (`finishTurn` -> `writeOwnerOnlyFile` — DEFECTIVE); `:499` (`runOffline`, wrapped
  in try/catch and becomes a terminal `failed` — correct); `:549` and `:570`
  (`redactOut`, contractually never throws — correct);
  `src/lib/serve-turn-store.ts:303` (`claimIdempotencyKey` — no release function
  exists anywhere in `src`).
- enumeration_method: read `runRemoteTurn` linearly from the claim to each of its
  four terminal exits, listing every call reaching a `config-dir.ts` writer;
  cross-checked with a grep for the three writer names restricted to the store,
  and for a release path — there is none. The first member was then executed end
  to end with a pinned id and a pre-planted file.

### F-005 — the trustMode split is justified by a claim that is false, contradicts the only enforcement of the field, and is inert in production

- **Severity**: major
- **File**: `src/harness/policy/ranks.ts:57`
- **Found independently by**: review-architecture, review-security-code,
  review-logic. Arithmetic reproduced during consolidation.

Three problems in one table.

**The justification does not describe the tables.** Both `ranks.ts` and
`profiles.ts` assert "the two orderings are inverses on the same field". They are
not:

```
TRUST_RANK          read-only 0 < trusted-local 1 < untrusted 2
its inverse         untrusted 0 < trusted-local 1 < read-only 2
REMOTE_TRUST_RANK   untrusted 0 < read-only     1 < trusted-local 2
```

Only `untrusted` moves. The design rests on a relationship the tables do not have.

**The ordering contradicts the only code that enforces the field.**
`src/harness/mutation/execute.ts:108` blocks every mutation when `trustMode` is
`read-only`, and `:114` blocks `untrusted` only when isolation is unavailable;
`src/harness/child/model.ts:205` treats `read-only` as the network-forbidding
posture. By the code that acts on it, `read-only` is strictly the tightest.
`REMOTE_TRUST_RANK` ranks it ABOVE `untrusted`, so a `read-only` local baseline
accepts an `untrusted` remote — a profile that may mutate under isolation clears a
ceiling that may never mutate at all. Not exploitable today, because both shipped
remote profiles have `network: "deny"` and the baseline is `trusted-local`. Live
the moment the baseline is tightened, which the baseline's own docstring discusses.

**In production the check cannot fire.** `localBaselineProfile()` is
`shellParentProfile()`, whose `trustMode` is `trusted-local` — the maximum of the
new table. So `remoteTrust > localTrust` is unsatisfiable for every in-enum value
and only garbage widens. The concrete probe the previous round named still returns
`{ok: true, widened: []}`. The dimension was added and is unconstrained.

`execute.ts` is also a third consumer that neither table describes: it does not
rank `trustMode` at all, it asks two independent yes/no questions. The new guard
cannot see it.

Both the architecture and security reviewers proposed the same resolution and it
is the right one: the field carries two axes. `read-only` and `trusted-local`
differ in AUTHORITY; `trusted-local` and `untrusted` differ in the PROVENANCE of
the input, at equal authority. There is no fourth cell, which is why three values
fit one enum and the compression looked free. Split it into `authority` and
`inputTrust` and there is one monotone ordering per field, no inverse to explain,
`execute.ts` stops being a special case, and a fourth posture becomes
representable. Fingerprints do not move: they are computed from string literals,
not from the profile body, so no recorded evidence shifts and the wire enum can
stay with a lossless projection at the schema boundary.

**class_scope** — the class is "a site that assigns meaning to a `trustMode`
value — ranks it, orders it, or branches on it".

- sites: `src/harness/child/isolation.ts:152` (`TRUST_RANK`, child exposure —
  correct for its question); `src/harness/policy/profiles.ts:233`
  (`REMOTE_TRUST_RANK` — DEFECTIVE on the `read-only`/`untrusted` pair, and inert
  under the shipped baseline); `src/harness/mutation/execute.ts:108` and `:114`
  (unordered discriminator — DEFECTIVE as a class member, outside both tables and
  outside the guard); `src/harness/child/model.ts:205` (same); `ranks.ts:47` and
  `profiles.ts:229` (the "inverses" claim — DEFECTIVE, false as shown);
  `src/harness/policy/profiles.ts:59,77,100,127,152` (literal assignments in the
  resolver — correct, the exempt site).
- enumeration_method: `keryx ctx rg "trustMode"` excluding tests — 31 hits across
  6 files; four are profile literals, two are type declarations, three are the
  tables and their doc, and the remaining five are the enforcement branches. Each
  ordering was compared pairwise against the enforcement branches, and both
  operator-selectable remote profiles plus both adversarial directions were
  executed through `compareProfiles`.

### F-006 — a third gating site for the injection class, on the surface an operator installs

- **Severity**: major
- **File**: `src/commands/security.ts:639` via `src/security/agent-hooks/runtimes.ts:19`
- **Found by**: review-security-code, by execution.

The injection fix reasoned about its class explicitly and named two members:
itself and `src/security/guard.ts`. There is a third, and it is the closer
sibling — same `source: "untrusted-external"`, same purpose, and it is the one an
operator installs believing it guards their agent.
`AGENT_CHECK_INPUT_COMMAND = "keryx security check-input --source untrusted-external"`
is installed as the PreToolUse guard in the supported agent runtimes. Its gate
branches on `decision.gate`, and a lone injection resolves to `warn` -> gate
`pass` -> exit 0 in every mode.

Executed against a real project fixture:

```
mode=advisory EXIT=0 :: gate PASS, action warn, prompt-injection detected
mode=enforced EXIT=0 :: identical
mode=ci       EXIT=0 :: identical
secret control (AWS key, enforced) EXIT=1
```

The hook detects the injection, prints it, and lets the tool call proceed. The
same asymmetry the round fixed on the remote surface is live one command away,
with the identical root cause.

**Leaving `guard.ts` unchanged was the right call**, and the security reviewer
confirmed it independently: its inputs are `generated`, `tool-output` and
`trusted-project` — content keryx itself produced on its way to disk — and
escalating there would fail the test suite of any repository whose fixtures
contain the canonical strings, including this one. Report-only in advisory is a
stated invariant. The class is not half-closed at `guard.ts`; it is half-closed at
`check-input`.

The structural cause behind all three: `resolveDecision` RECEIVES `source` and
never reads it. `buildFinding` and `escalateInjection` both ignore it, so the one
signal that distinguishes "a stranger posted this" from "we generated this" is
carried the whole way down and dropped, and every gate has to re-derive it.

**class_scope** — the class is "a site that turns a security decision into a
proceed/refuse for content that can drive agent execution".

- sites: `src/lib/serve-turn.ts:322` (FIXED this round);
  `src/security/guard.ts:119` (unchanged — correct, see above, and its five
  downstream consumers are all write seams);
  `src/commands/security.ts:639` via `src/security/agent-hooks/runtimes.ts:19`
  (DEFECTIVE, not considered); `src/mcp/tools.ts:136` (returns the decision, gates
  nothing — correct).
- enumeration_method: a grep for the service constructors excluding tests gives 27
  hits across 14 files, each classified by whether its return value branches
  execution; cross-checked with a grep for `untrusted-external` excluding tests —
  14 hits across 10 files, which is what surfaced the agent-hook command, because
  it is a string constant rather than a service call. Both greps were needed;
  either alone gives an incomplete class.

### F-007 — the guard against a second ranking cannot detect the duplicate it commemorates

- **Severity**: major
- **File**: `src/harness/policy/profiles.test.ts:260`
- **Found independently by**: review-testing-practices (mutation-proven),
  review-architecture, review-logic.

`RANK_TABLE` matches four identifiers. The duplicate it was written for was not a
table under any of them: the pre-fix `profiles.ts` implemented it as
`function rank(outcome: string)` and `function isolationRank(value: string)`, two
switch statements.

The testing reviewer pasted those two functions back verbatim and ran the guard:
**22 pass, 0 fail**. The guard whose comment cites that exact duplicate is green
with that exact duplicate present.

The scaffolding is otherwise honest — the seam is pure, the self-check drives it,
the scan-reach assertion is real and the numerator is non-zero and asserted. The
defect is the predicate: it is a name allowlist standing in for a check against
the structure the names describe, which is the recorded `allowlist-not-a-boundary`
lesson applied to a guard built to enforce that lesson. The person who writes the
fifth table is by definition the person who did not know about the first four.

**class_scope** — the class is "a source-level guard whose predicate must cover the
shape the defect it names actually took".

- sites: `src/harness/policy/profiles.test.ts:260` (`RANK_TABLE` — DEFECTIVE, name
  allowlist, misses the switch/function shape that is the recorded defect); `:258`
  (`PROFILE_LITERAL` — correct, structural, and planting a literal under a new
  name went red); `src/lib/serve-server.test.ts:398` (`baselineSuppliers` —
  adequate, because the seam is a named object property so the identifier IS the
  shape); the two `config-dir` guards via `scanFor` (correct — call-shape based).
- enumeration_method: a grep for `treeSources|scanSync` gives the four
  source-level guards on this branch; each predicate was compared against the
  concrete source of the defect it cites, read out of the pre-fix blob, and the
  comparison was executed as a mutation rather than reasoned about.

### F-008 — the route half of the durable-record fix has no test

- **Severity**: major
- **File**: `src/lib/serve-server.ts:561`, `:675`
- **Found by**: review-testing-practices, mutation-proven.

The blocker's stated cost was "past roughly 6,500 events the SSE route answers 200
with an empty body". The store now returns a typed failure and the store test pins
it. Nothing pins what the ROUTE does with it.

Both branches were reverted — the SSE route back to 200-with-empty-body, the
record route's 500 back to a 404 — and the suite run: **919 pass, 5 skip, 0 fail**.
The whole route-visible half of the blocker fix is free to regress.

**class_scope** — the class is "a `TurnReadFailure` reason and whether a test pins
the status the route gives for it".

- sites: `not-a-turn-id`, `absent`, `malformed` -> 404 (tested);
  `too-large` -> 500 and `unreadable` -> 500 at `serve-server.ts:675` (UNTESTED);
  the events-log equivalents at `:561` (UNTESTED); events-log `absent` -> 200 empty
  (tested at store level only).
- enumeration_method: read the six-member `TurnReadFailure` union, traced each to
  its branch in the router, then executed the revert of both 500 branches against
  the whole `src/lib` plus `src/commands` suite.

### F-009 — the forced terminal event has no test at the level that forces it

- **Severity**: major
- **File**: `src/lib/serve-turn.ts:400`
- **Found by**: review-testing-practices, mutation-proven.

Two things landed for the terminal-event finding: `emit` sets `bounded` on a
refused append, and `emitTerminal` forces the closing event past the window. Both
were removed and the suite run: **590 pass, 0 fail**.

The store test proves `appendTurnEvent` honours `force`. Nothing proves the one
caller passes it — which is precisely the shape of the finding being fixed, whose
own class named that caller as "the only caller, discards it".

**class_scope** — the class is "a store function whose return value the caller must
act on, and whether the CALLER's handling is tested".

- sites: `appendTurnEvent`'s bound honoured (tested at the store);
  `emit` acting on `false` (UNTESTED); `emitTerminal` passing `force` (UNTESTED);
  `finishTurn`'s boolean (UNTESTED and unread — see F-003).
- enumeration_method: a grep for the bound constant and the emit names across test
  files returns hits in the store suite only; then both production changes were
  removed and the `src/lib` plus `src/harness/policy` suites executed.

### F-010 — wiring the runner made an unmeasured path the hot path

- **Severity**: major
- **File**: `src/lib/serve-runner.ts:40`, `src/lib/serve-turn.ts:549`,
  `src/lib/serve-turn-store.ts:179`
- **Found by**: review-highload, measured.

The wiring itself is the right shape and the per-listener/per-request split is
correct. What it did was turn a path that had never executed in production into
the hot one, and that path does per-EVENT work nobody had measured.

- `redactOut` constructs a security service and calls `redact` for every
  `text_delta`, and `redact` does a config load plus an HMAC key read on every
  call with no cache anywhere: **80 microseconds per event**.
- `appendTurnEvent` calls `ensureTurnDir` BEFORE the bound check, so every append
  re-walks three `mkdirSync` plus three `chmodSync` on directories that already
  exist: **16.8 of 26.5 microseconds per event, 63% redundant**.

End to end with a zero-latency provider, so this is keryx's own cost:

| deltas | wall time | per delta |
|---|---|---|
| 1,000 | 121 ms | 121 us |
| 10,000 (the bound) | 1,063 ms | 106 us |

At eight in flight: 394 ms versus 121 ms for one — 3.26x, where perfect
parallelism is 1.0x. The submission awaits the whole run, there is no
concurrent-turn bound, `budget.maxSeconds` is set and read by nothing, and
`maxConcurrentTurnsPerSession` is declared in the config schema with no reader. A
single authenticated caller with 100 in-flight submissions queues about 12 seconds
of serve-layer CPU on the thread that also answers status and record reads.

The unbounded-concurrency half was a known item on the previous round's minor
list. What is new is that it now executes, and that the per-event constant is 121
microseconds rather than the 8 an append alone would cost.

**class_scope** — the class is "work inside the per-turn path whose cost scales
with the number of streamed events rather than with the number of requests".

- sites: `src/lib/serve-turn.ts:549` (`redactOut` per delta — DEFECTIVE, 80 us);
  `src/lib/serve-turn-store.ts:179` (`ensureTurnDir` per append — DEFECTIVE, 16.8
  us, and it runs even when the bound is about to refuse the event); `:189`
  (`appendOwnerOnlyLine` — correct, one write per durable record, the point of the
  design); `src/lib/serve-turn.ts:570` (`redactOut` on the summary — once per turn,
  correct); `:625` (`scanPrompt` — once per request, correct);
  `src/lib/serve-runner.ts:49,50,56` (once per listener, correct);
  `src/lib/serve-server.ts:812` (`resolveCredential` per request — deliberate,
  correct); `:497` (`resolveProject` — defensible, registrations change).
- enumeration_method: read `runRemoteTurn` top to bottom classifying every call by
  loop nesting — per-listener, per-request, or inside the delta loop — then timed
  each per-event call in isolation against the real modules and reconciled the sum
  with end-to-end runs at 1,000 and 10,000 deltas.

---

## Minor and info (abridged; full set in the reviewer results)

- The duplicate branch collapses a failed record read into `sessionId: ""` on a
  200, which is a null record standing in for a stated failure on the one path
  that reaches a success status.
- The `Bun.serve` error handler emits `{"schemaVersion","error","message"}` while
  the protocol defines `{"error":{"code","message"}}`, so a client reading
  `error.code` gets `undefined` on the one response class that means the server
  broke. The test asserts a substring and cannot tell the two shapes apart.
- The injection detectors are evadable by a single newline, a single period, 45
  characters of padding, a zero-width joiner, a Cyrillic homoglyph, a translation
  or base64. Twelve of fourteen probe prompts pass. Pre-existing and outside the
  diff; it becomes the ranking finding on this surface the moment a remote turn
  gets a tool.
- A `redact`-action finding reaches the provider unredacted while the new comment
  says "the first is handled by the redaction itself". `scanPrompt` throws the
  `redacted` string away. The default PII policy action is `redact`, so this is
  the common case.
- The socket suite's "never reaches the runner" control reads a constant turn id
  no production path mints, so it is unconditionally empty. Disabling
  authentication and deleting the status assertion leaves the suite green while an
  unauthenticated submission runs a turn.
- Neither error boundary is individually pinned: removing either alone leaves the
  suite green, and the `Bun.serve` handler has no coverage at all.
- Both rebuilt guards still miss ES6 shorthand and computed-key supply.
- `MAX_TURN_EVENTS` is a count and `MAX_TURN_FILE_BYTES` is a byte bound, with
  nothing connecting them. Ten thousand bare events are 1.35 MiB, leaving a
  per-event text budget of 6,569 bytes before the reader refuses — and no
  per-event byte bound exists. What actually holds the file down is a provider
  property keryx neither states nor enforces, and on the OpenAI-compatible path
  `maxOutputTokens` is silently dropped.
- The approval pair is not forced past the bound while `turn.finished` is, so past
  the window the turn's two accounts of itself disagree in exactly the way the
  comment a hundred lines above forbids. Unreachable until a tool is registered.
- Both catches are empty: the operator is told nothing on a fault that burns an
  idempotency key and strands a record. The argument against putting an id in the
  response does not argue against a line on the process's own stderr.
- `MAX_TURN_BODY_BYTES`, an HTTP framing bound, is declared in the run module.
- `SubmitOutcome` and `SubmitTurnOutcome` are one contract declared twice, in the
  round that removed a second copy of the rank tables and a third copy of the
  comment stripper. Drift is caught in one direction only.
- `readTurnFile` and `readTranscriptFile` are the same number for the same stated
  reason with byte-identical bodies — one class with two names.
- `config-dir.scan.ts` went from three importers to five and crossed into
  `src/harness` for the first time, still with nothing pinning that only test
  files may import it.
- The composition-root wiring is held by `tsc` alone; deleting the line leaves the
  suites green.
- `serve-runner.ts` has no test file: four of its five branches are never driven.
- The `approvalId` leg of the distinct-ids criterion is asserted nowhere.
- The unknown-field error echoes up to 64 characters of a caller-chosen JSON key
  without escaping `<`, `/` or `>`.
- `serve-server.ts:864` still says the drain window is "empty by construction"
  while `:633` in the same file says the opposite. Pre-existing; the round updated
  one half of the contradiction.

---

## What held up

Recorded because the reviewers attacked these and could not break them.

- The error boundary holds as a disclosure control. Every response path was driven
  over a real socket with headers and bodies dumped; a forced ENOTDIR inside the
  handler produced a bare 500 with three headers and nothing else — no errno, no
  frame, no config path, no home directory. The SSE route materialises its whole
  body before returning, so nothing can throw after headers are flushed.
- The throttle's ordering invariant holds: there is no code path from a successful
  verification into the throttle at all, so an authenticated caller is never
  throttled and the 429 is not an oracle for token validity.
- The turn store's containment holds. The id is gated before every path join, the
  idempotency key is hashed before becoming a filename, `resolveProject` returns
  the registry's stored path rather than the caller's, and no caller-supplied
  string reaches a path join.
- `validateTurnRequest` is closed: a `__proto__` key from `JSON.parse` is an own
  enumerable key, is seen, and is refused as an unknown field rather than applied.
- `compareProfiles` fails closed on eight of ten hostile shapes. The two
  exceptions — prototype pollution supplying a key the remote profile does not own,
  and a getter invoked once so the comparator does not snapshot what it cleared —
  are unreachable with the frozen literals the resolver returns, and are recorded
  because the previous round's "what held up" said prototype pollution failed
  closed, which for that shape is no longer accurate.
- The claim is atomic within a process. Eight concurrent same-key submissions gave
  one accepted, seven duplicates, one record, and a correct non-empty session id on
  all seven.
- `emitTerminal` runs exactly once per turn — four terminate call sites, all
  `return terminate(...)` — verified by a 10,000-delta run writing 10,001 events
  with the forced terminal at the first refused slot and no reused cursor.
- The shared provider is safe across concurrent requests: only readonly dependency
  fields, and the mutable sequence counter is a local inside `stream()`.
- No credential leak from the new wiring. Nothing is logged or returned, the
  provider construction makes no network call, and with no saved key it falls
  closed to the offline provider. One residual for an operator rather than a
  finding: the saved keys are written into `process.env` for the process lifetime,
  so any future subprocess this surface gains would inherit them.
- Outbound redaction is applied everywhere it is claimed, and its failure branch
  emits a fixed marker rather than the unredacted original.
- The inventory rebuild is closed properly: it plants a file, asserts the plant,
  and detects a modification rather than only a creation. Both halves go red under
  mutation.
- The idempotency-after-rejection test is the strongest in the round: it goes red
  for both underlying causes independently.
- Determinism is clean throughout — port 0 with the bound port read back, temp
  roots everywhere, explicit `dir` on every store read, a hand-driven clock for
  every throttle test, and no cross-test ordering dependency.
- The bound is exercised from the real constant: the event-log test sizes itself
  from `MAX_CONFIG_FILE_BYTES` and asserts the premise, so it cannot pass on a
  short log.
- Eighteen of twenty-four mutations went red as intended. The six that stayed
  green are F-007, F-008, F-009 and the type-only wiring.

---

## Recommended order

NOTE ON FORMATTING: no line below opens with a finding identifier. The ingest
parser now requires a bracketed id or a title separator, but a wrapped reference at
line start was the defect that produced eight phantoms two rounds ago, and prose is
written to avoid the shape rather than to rely on the fix.

1. The two blockers first, and the throttle one before the containment one. The
   throttle regression is a live security control that this round switched off; the
   containment one is fail-closed and costs coverage rather than safety.
2. Then the two majors that are the same mistake as each other — the discarded
   boolean and the claim before the throwing writers. Both are "a signal exists and
   the caller ignores it", and both have a demonstrated reproduction to test
   against.
3. Then the trustMode decision. This is the one that wants a human: the reviewers
   agree the field carries two axes and should be split, the split is contained
   because fingerprints do not move, and the current state is a dimension that is
   inert in production, justified by a false statement, and contradicted by the
   only code that enforces the field.
4. Then the third injection site, which is a live gap on a surface operators
   install, not on this branch's surface.
5. Then the three test-coverage majors, which are cheap and each has a mutation
   that already demonstrates the gap.
6. The per-event cost last: it is real, it is measured, and it is the only major
   that is a performance property rather than a correctness one.
7. Re-review. A fix round is new code, and this one proved that for the third time.
</content>
