# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A widening remote profile is a startup refusal that binds no socket, and the instruction that refusal prints, when executed verbatim, exits 0. The comparison is structural over the resolved profile's fields — never `profileId` or `profileVersion` — and an unrecognised value, a key present in one profile and absent in the other, or a dropped isolation requirement each fail closed.
- AC2: Parity (spec AC-03): the same prompt over HTTP and through the existing harness CLI path produces identical policy decisions and evidence shape, differing only in recorded origin.
- AC3: Origin is unforgeable (spec AC-05): a body claiming a local origin is recorded with the server-assigned remote origin, and `origin` is refused by the request schema rather than accepted and overwritten.
- AC4: Identity-first binding (spec AC-11): two concurrent sessions for different projects, a declared path resolves to its own session regardless of arrival order or idleness; an unknown project fails rather than falling back.
- AC5: An `ask` terminates in a recorded denial, visible in both the turn result and the stream, with nothing executed and nothing left pending. The denial is written in the source as a stated R4d boundary, not produced by the absence of an approval store.
- AC6: Containment required and launcher unavailable: the turn is refused, never run uncontained.
- AC7: A repeated idempotencyKey returns the original turnId and starts no second turn, across a process restart.
- AC8: Re-attachment with Last-Event-ID replays the missed events from the durable record and executes nothing; asserted by driving a real turn, detaching mid-flight and reattaching.
- AC9: Redaction: token-like strings, absolute paths and PII fixtures in tool output appear in no stream event, no turn result and no error body — with a positive control first proving the surrounding fields DO reach the caller, so the absence is meaningful.
- AC10: Task Manager stays read-only (spec AC-14) and the append-only session store stays the single writer (spec AC-15): a full recursive inventory of the fixture project (path -> size:mtime) is unchanged by every route, with a flow.json pinned as present so the inventory cannot be empty.
- AC11: Repeated authentication failures from one peer are throttled; an authenticated in-flight turn is never throttled.
- AC12: Gates: `bunx tsc --noEmit` clean, full `bun test` green, `keryx health run` PASS, and the command-registry coverage guard still green.
