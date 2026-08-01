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
</content>
