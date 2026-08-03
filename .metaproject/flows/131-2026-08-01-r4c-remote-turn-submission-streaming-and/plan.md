# Implementation Plan

Status: formalized

## Approach

Refusals before capabilities, in that order, for the reason R4b landed empty:
the paths that say no are the ones that must be proven while there is still
nothing behind them to go wrong. So the non-weakening startup check and the
throttle land before `POST /v1/turns` exists, and each is asserted on its own.

The turn machinery is built as a **durable record first, transport second**. The
event stream, the terminal result and idempotency are all views over one
append-only per-turn record, because AC7 and AC8 both require surviving a
process restart, and a stream implemented as a live pipe with a replay bolted on
afterwards cannot satisfy either. Writing the record first and streaming from it
means re-attachment is a read, not a second code path — and "re-attachment never
re-executes anything" becomes true by construction rather than by discipline.

## Steps

1. **D1 — the local-profile resolver.** `src/harness/policy/profiles.ts`, with
   the two `commands/harness.ts` literals moved in verbatim (fingerprints
   preserved: they are the input to every evidence record's
   `policyFingerprint`). Source-level guard: only this module constructs a
   profile literal. **Done — the guard found two further profiles in
   `tool/builtin/spawn-subagent-tool.ts` that the launch prompt recorded as not
   existing; both moved in.**
2. **D2 — `compareProfiles`.** Structural, union-of-keys, fail-closed on every
   uncertainty. **Done.**
3. **AC1 — wire it into startup.** A new `ServeRefusalReason` member, resolved
   inside `resolveServeStartup` so the refusal is terminal by construction and
   no socket is bound. The existing refusal suite already enumerates every
   state, extracts the instruction each prints and executes it requiring exit 0
   — the new member must satisfy that suite rather than sit beside it.
4. **AC11 / D4 — auth-failure throttling.** Keyed by peer, applied after the
   fixed 401 so it is not an oracle, and never consulted for a request that has
   already authenticated.
5. **The durable turn record.** One append-only file per turn under the shared
   directory, holding the ordered events and the terminal result. Reads go
   through the bounded helpers from flow 130 — this is a new reader of that
   directory, and the source-level guard will report it if it is not.
6. **`POST /v1/turns`.** Body size and content-type bound BEFORE parsing
   semantics; schema validation refusing `origin` outright rather than accepting
   and overwriting it; origin stamped server-side; identity-first session
   resolve or create; the prompt through `src/security` as untrusted content
   with a 422 that says only that it was rejected; idempotency key returning the
   original turnId; the 202/400/401/409/413/422/503 table.
7. **`GET /v1/turns/{turnId}`** — terminal result per `turn-result.schema.json`,
   read from the durable record.
8. **`GET /v1/turns/{turnId}/events`** — SSE with monotonic `seq`, bounded tool
   summaries, and `Last-Event-ID` replaying from the same record.
9. **Containment (AC6) and redaction (AC9)** on every event, result and error
   body.
10. **The offline fake transport** covering the subset specification.md
    §Testability requires of this slice.
11. **Gates and the mutation table** in the journal.

## Risks

- **Scope pressure toward R4d.** Every one of these steps has an approval-shaped
  hole next to it, and filling one "while we are here" is how a slice stops
  being reviewable. D3 is the boundary; a turn that raises `ask` denies, and the
  denial is written as a stated boundary in the source.
- **The durable record is a new writer AND a new reader of the shared
  directory.** Both flow-130 guards will report it. That is the desired
  behaviour, not an obstacle — but it means the record's IO has to go through
  the sanctioned helpers from the first line rather than being retrofitted.
- **Streaming under test.** No test may bind a fixed port; bind 0 and read the
  port back. A stream test that hangs must fail on a timeout rather than being
  killed by the runner — the same rule flow 130 arrived at for FIFOs.
- **`bun test` runs files sequentially in one process,** so any suite touching
  `process.exitCode`, `console.*` or `XDG_DATA_HOME` must restore them.
