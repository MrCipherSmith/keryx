# Fix round — PR #220 (flow 131 / R4c)

## Problem

The consolidated review
(`src/review/fixtures/consolidated-review-2026-08-01.md`, recorded as a package
on this branch) returned REQUEST_CHANGES. PR #219 has since landed and #220 is
rebased onto it, F-012 is closed by the per-call exemption added during that
rebase, and F-013/F-014/F-015 were this branch's siblings and are in `main`.

What remains is #220's own set: two blockers and nine majors.

### Blockers

- **F-001** — `POST /v1/turns` is not wired in production.
  `startServeListener` builds the only production `ServeContext` without
  `submitTurn`, and `createSubmitTurn` has zero production callers. A real
  `keryx serve` answers every submission with `503 unavailable`. Nine of flow
  131's twelve confirmed criteria were verified through `handleServeRequest`
  with a runner injected by the test fixture, never against a listener the CLI
  can start.
- **F-002** — the durable event log silently reads back as empty.
  `events.jsonl` is append-only and unbounded, and is read through
  `readConfigFile`, whose bound is 1 MB. `MAX_TURN_EVENTS` is 10 000, which
  serialises to at least 1 518 890 bytes with zero assistant text; measured,
  8 000 events give 1 302 890 bytes and `readTurnEvents` then returns 0. Past
  roughly 6 500 events the SSE route answers 200 with an empty body. An
  oversized `turn.json` additionally makes `readTurnRecord` return null, so
  `GET /v1/turns/{id}` 404s for a turn that exists and `finishTurn` silently
  no-ops, stranding the turn at 409 forever.

### Majors

- **F-003** — prompt-injection detection never blocks. Every injection detector
  scores 0.35–0.45 against a default `gate.minConfidence` of 0.5, so injection
  findings are always downgraded to `warn`. All four canonical injection prompts
  return `rejected: false`; an AWS key returns `rejected: true`. Not
  reconfigurable: the scan root is the install directory, which never receives a
  `security.config.json`.
- **F-004** — `compareProfiles` duplicates `isolation.ts`'s ranking and drops
  `trustMode`. By the codebase's own ordering `untrusted` outranks
  `trusted-local`, so the shipped default widens on a dimension AC-04 never
  inspects.
- **F-005** — the idempotency key is claimed before the scan and the record, so
  a 422-rejected prompt permanently poisons its key.
- **F-006** — `createSubmitTurn` passes `newId: () => turnId`, so `sessionId`,
  `approvalId` and `turnId` are the same value in production.
- **F-007** — `emit` discards `appendTurnEvent`'s `false`, so past the backlog
  bound `terminate()`'s `turn.finished` is dropped too and the stream never
  closes with a terminal event.
- **F-008** — no error boundary: `Bun.serve` gets no `error` handler and
  `handleServeRequest` has no try/catch, while the submit path calls writers
  documented as propagating EACCES/ENOSPC/EROFS.
- **F-009** — two source-level guards are decorative. Their self-checks
  re-evaluate a regex on a string literal instead of driving the tree loop, and
  neither asserts the scan reached the tree. Both have a zero denominator, and
  the `localBaseline` guard's second clause is dead.
- **F-010** — AC10's inventory test compares two empty inventories, so it can
  detect a created file but not a modified one, which is the failure AC10 names.
- **F-011** — a throttle test asserts a property that is false, and the
  underlying defect is real: a throttled peer never reaches `recordFailure`, so
  its `seenAt` freezes and oldest-first eviction takes it first.

## Expected Outcome

`keryx serve` executes a turn submitted over a real socket. The durable record
survives its own bound and says so when it cannot. Each of the nine majors is
fixed at the level of its class. `bun test` green, health gate pass, and the
result goes to a fix-round review before it merges.

## Out of Scope

- The minor/info set of the review, except where a fix here closes one anyway.
- R4d work of any kind: session existence and ownership checks are named in the
  review as an IDOR that arrives when sessions gain state, which is not now.
</content>
