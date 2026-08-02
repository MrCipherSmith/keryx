# Implementation Plan

## Approach

The blockers first, because the second one changes a signature the majors touch,
and because the first one is what makes any of the rest observable through the
product rather than through a fixture.

### F-001 — assemble the runner in `startServeListener`

`createSubmitTurn` needs a profile, a provider, a model and the install
directory. All four are already resolvable at startup:

| Dependency | Source |
|---|---|
| `profile` | `resolveRemoteProfile(startup.config.profile)` — already validated by the startup path |
| `provider` / `model` | `loadShellConfig(dir)` + `applySavedApiKeys(dir)` + `makeProvider`, the same assembly `keryx shell` uses |
| `dir` | `keryxConfigDir(input.dir)` — the install directory, which is also the scan root |

An optional `makeSubmitTurn` seam on `StartServeInput` lets a test substitute a
deterministic runner; production passes nothing and gets the real assembly. The
default is the wiring, so forgetting it is not possible — which is the actual
defect, since the previous shape made the wiring the thing you had to remember.

The type-level option the review offers — making `submitTurn` required — is NOT
taken. Eighty-one synthetic contexts across three suites would each grow a field
they are not testing, and the guard that would actually have caught this is
behavioural: **a route test that drives a real socket**. That test is the
control, and it is what AC1 and AC2 are.

### F-002 — the turn store's own bound

`readTurnFile` in `config-dir.ts`, bounded by `MAX_TURN_FILE_BYTES`, with the
reason stated where the bound is: `events.jsonl` grows with the turn and
`turn.json` carries an unbounded `result.text`, so neither is a config document
and neither may be read at the config bound.

`readTurnEvents` and `readTurnRecord` stop collapsing a failed read into `[]` and
`null`. Both return a typed result, so the routes can answer "the record is
there and I could not read it" instead of 200-with-nothing or 404. `finishTurn`
returns whether it wrote, so a turn cannot be stranded at 409 in silence.

### The majors, each at its class

| # | Fix |
|---|---|
| F-003 | `scanPrompt` treats an injection finding as blocking regardless of the confidence gate. The gate decides how loud a finding is; it must not decide whether a prompt from outside the operator's terminal can start an agent. The class is "a site that turns a security decision into an allow/deny", and `security/guard.ts` has the same blind spot — fixed with it, or the class is half-closed again. |
| F-004 | `compareProfiles` uses `isolation.ts`'s `TRUST_RANK`/`rankOf` rather than a second copy, so `trustMode` is ranked. A source-level guard fails on a second ranking table. |
| F-005 | Claim the key AFTER the scan and immediately before the record. The window that remains — two concurrent identical keys both passing the scan — is a duplicate turn, not a poisoned key, and that is the direction to fail in. |
| F-006 | Stop passing `newId: () => turnId`. `runRemoteTurn` takes the turn id as a value and keeps its own `newId` for the session and approval ids. |
| F-007 | `emit` acts on `false`: it records the terminal event through a path that is not subject to the backlog bound, and marks the record as bounded so the caller can tell truncation from completion. |
| F-008 | A try/catch in `handleServeRequest` and an `error` handler on `Bun.serve`, both answering a bare 500. Nothing from the error reaches the body. |
| F-009 | Both guards rebuilt from `config-dir.writers.test.ts`: a pure seam, a self-check that calls it, a scan-reach assertion, a numerator control. The `localBaseline` regex matches `localBaseline?:` as well as `localBaseline:`. |
| F-010 | The inventory fixture plants a file and asserts the plant, and the assertion detects a modified file — content, not merely presence. |
| F-011 | `check` refreshes `seenAt` for a peer in cooldown, so oldest-first eviction cannot prefer it; the test asserts the cooldown survives the flood, which is what its title says. |

## Steps

1. T1 — context: the eleven sites, each read and confirmed against the review.
2. T2 — F-002: the turn-store bound and the typed reads (first, it changes signatures).
3. T3 — F-001: assemble the runner in `startServeListener`.
4. T4 — the real-socket route test (AC1, AC2) — the control for F-001.
5. T5 — F-005, F-006, F-007: the submission pipeline's order, ids and terminal event.
6. T6 — F-003: injection findings block, at both sites of the class.
7. T7 — F-004: one ranking, `trustMode` included, guarded.
8. T8 — F-008: the error boundary.
9. T9 — F-009, F-010, F-011: the three test defects.
10. T10 — verify: full suite, typecheck, health.
11. T11 — the fix-round review, recorded as a package.
12. T12 — PR #220 updated and readied.

## Risks

- Making injection findings block changes what the security service does for
  every caller of `scanPrompt`'s class. The `security/guard.ts` site is
  pre-existing and outside the original diff; fixing only the new one leaves the
  class half-closed, and fixing both changes existing behaviour. The second is
  correct and is what the review asks for, but it is the change most likely to
  surface elsewhere in the suite.
- The real-socket test binds a port. It must use port 0 and read the bound port
  back, or it will be the flake this repository's testing rules forbid.

---

# Round two — the plan after the second review

`.metaproject/reviews/2026-08-02-ingest-round2-review-md/` — four reviewers,
four blockers, eight majors. Round one's ten findings: eight closed, two closed
at the site and not the class. Five of round one's six green mutations are red.

## What the second round changes about how this work is done

Three process corrections, each earned:

1. **Mutate the production DEFAULT, not the plumbing around it.** The round-one
   containment check removed the seam along with the default, so a test that
   supplies the seam failed for an unrelated reason and the check read as a pass.
   A mutation must change exactly the thing whose absence is the defect.
2. **Never mutate a shared tree while reviewers are reading it.** Four agents were
   working on this checkout while mutations were applied to it; one reviewer's
   full-suite run failed six tests as a result and had to be redone. Mutations go
   in a worktree or wait.
3. **Check an inherited claim before repeating it.** Two factual claims were
   copied verbatim out of the round-one report — the hook event and a byte
   figure — and both were wrong. A claim in a review is evidence to verify, not
   a fact to quote.

## Order

The two that are a redesign rather than a patch come first, because the shape of
the fix decides what the tests around them look like.

### 1. F-001 — the transport must read what the run returned

`runRemoteTurn` reads `run.output.summary` and terminates with a hardcoded
`("completed", "ok")`. `status`, `gate.status` and `unresolvedBlockerIds` are
discarded, so a stock install records a blocked startup as a successful turn.

Map the harness terminal state onto `TurnOutcome` explicitly and totally — a
switch over `run.output.status` with no default that invents success — and carry
the gate and the blocker ids into `reasonCode`. The test is the one this round
should already have had: submit through the production assembly on a config
directory with no provider, and assert the record does NOT say `completed`.

This is missing functionality rather than a regression, and it is why the socket
suite's capability assertion passed on a failure.

### 2. F-002 — the refusal has to use the signal the runtime reads

`exitCodeFor` returns 1; `src/ctx/runtimes.ts` documents and implements exit 2 as
the block for Claude/Codex/Windsurf, plus stdout-JSON forms for the others. The
fix is not a number change: the exit contract belongs with the runtime registry
that already owns it, so `security` and `ctx` stop disagreeing. Take the contract
from `ctx/runtimes.ts`, apply it per runtime, and assert the emitted signal
against that registry rather than against a literal.

With F-007 in the same pass: an unappealable refusal that fires on 3.3% of this
repository's own prose is not shippable. The refusal needs either a confidence
floor of its own or an explicit operator override, decided before the exit
contract is wired.

### 3. F-003 — release only the failures that precede the effect

Split the catch: a throw before the first provider yield releases the claim; a
throw after it does not, because the turn ran and releasing converts
at-most-once into at-least-once for a billed operation. Prefer a tombstone the
second submission can be answered from over a release.

### 4. F-004 — pin the production defaults

A test that reaches the containment gate with the seam ABSENT, under the shipped
profile, asserting the outcome tracks the real probe. Plus the fail-closed
fallback in `serve-turn.ts`, which is currently mutable to fail-open with the
whole suite green — and which the new weakening-seam guard cannot see because it
exempts that file wholesale. Narrow the exemption to the declaration.

### 5. The majors — ALL EIGHT CLOSED (2026-08-02)

| id | what it was | how it closed |
|---|---|---|
| F-005 | the fourth injection site: `PreToolUse` carries `check-output` and nothing tested it | same `handleCheck`, now pinned on both surfaces incl. §7a non-refusal (`64a949bc`) |
| F-006 | eviction dropped the peer at 9 of 10 failures; 1800 guesses unthrottled | single value scale, `BAN_VALUE = 0.5`, load-bearing in both directions (`246dfa43`) |
| F-007 | 3.3% false refusals | fell out of the round-one revert; confirmed on both hook surfaces (`64a949bc`) |
| F-008 | three guards matching spellings, not shapes | rank table now three shapes; profile literal discriminated by terminator; importer sees `require`/dynamic `import`; seam sees ES6 shorthand (`839aba24`) |
| F-009 | branches added this round with no test | unreadable trust mode in `mutation/execute.ts`; the `model.ts` behaviour change; `Bun.serve`'s error hook extracted to one `internalErrorResponse` (`8652e4e9`) |
| F-010 | `ensureTurnDir` on every recorded append | optimistic append, ENOENT retry only: 26.1µs → 9.4µs, −64% (`f608cc19`) |
| F-011 | `SubmitOutcome.unavailable` produced and consumed, never exercised | 500 on a damaged claimed record, with a removed-record control (`9b76ca1e`) |
| F-012 | five sites interpreting six reasons, disagreeing about `not-regular` | `isServerFault`, total with no default arm; `not-regular` is a server fault (`6625d534`) |

Six of the eight carry a mutation showing the fix is load-bearing; `64a949bc`
and `839aba24` offer passing controls and planted probes instead, which is a
different form of evidence. The blanket "every one" was false and was filed. Full suite after
the eight: **2874 pass, 14 skip, 0 fail** across 287 files.

New durable note: `.metaproject/memory/constraints/code-blanks-string-literals.md`
— `code()` blanks string literals, which silently disabled **two** source guards.

> Corrected twice. This line said "four", which round three showed was double the
> real count with two guards misattributed; the note itself was fixed and this
> restatement was not, which round four then filed. Correcting a number where the
> fixer happens to be reading is not correcting it.

### 6. The minors — NINE OF ELEVEN CLOSED (2026-08-02), commit `ae1211ea`

One had behaviour behind it: the `createSecurityService` memo was `once ??=
load()`, caching a rejected promise, so one transient fault cost a whole turn's
redaction. `memoizeResolved` clears the slot on rejection; restoring `??=` fails
three of its four tests.

Two were real but silent: `releaseIdempotencyKey`'s boolean is now read (a
`false` means another submission legitimately re-took the key, which had no
witness anywhere), and `widened` now emits `trustMode.authority` rather than a
bare `authority` that named no field in the schema its docstring invoked.

Six were false statements in comments: the unwritable-record class claiming a
discrimination nothing performs; the throttle's rule 2 describing a step F-006
removed; the tie-break offering two names for one record; `MAX_TURN_FILE_BYTES`
giving one quantity two numbers (measured: 1 418 890 bare, 1 518 890 with an
empty `text` field); the SSE comment whose first clause read as current
behaviour and produced a false finding that cost a round to disprove; and
`SecuritySource`, which had no per-member documentation at all — the reason
prose about it named four of five and called `trusted-project` content keryx
produced, when that is `generated`.

**Deliberately NOT actioned — carried to the next round, not silently dropped:**

- *`serve-server.ts`'s value-import closure is 42 modules, 33 reached only
  through `serve-turn.ts`, for two pure validators.* Real, and the fix is to
  move the validators out of the turn module — a structural change with its own
  blast radius, not a minor. It belongs in a change that can be reviewed as
  one.
- *The composition-root wiring is held by `tsc` alone.* Also real. A wiring test
  is worth writing and is a new test surface rather than a correction, so it
  goes in with a scope of its own.

Full suite after the minors: **2878 pass, 14 skip, 0 fail** across 288 files.

### 7. Re-review

Sixth round. The trend is the argument for it, not against it: round one found
two blockers, round two found four, and every one of round two's was in code
written to close round one's.

## Not to be "fixed"

One reviewer reported the SSE route returning 200 with an empty body. It returns
`errorResponse(500, "record-unreadable", …)`, verified twice by execution.
Rewrite the misleading comment above it; change no behaviour.
