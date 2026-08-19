# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A wrap-up dispatch attempt that fails (a group outcome of `"error"`,
  `"no_credential"`, or `"conflict"`) results in a durable
  `{recordType: "wrap-up-outcome", ...}` artifact written under the
  session's `slate-archive/` directory, via `runWrapUp`.
- AC2: A wrap-up dispatch attempt that succeeds (writes a proposal or an
  unbound-candidate artifact) ALSO results in the same durable outcome
  artifact being written — the write is unconditional on success/failure,
  per TRD §1.3.
- AC3: A wrap-up dispatch call with zero non-empty seed groups (the
  existing harmless no-op early return) does NOT write an outcome artifact.
- AC4: `classifySession` reads the newest wrap-up-outcome artifact for a
  session; when it exists and every group in it is a failure outcome, the
  resulting `CatchUpUnknownItem` carries a populated `wrapUpOutcome` field
  with the trigger, timestamp, and per-group outcomes.
- AC5: A session with a `terminal-state.json` (blocked) or an
  unbound-candidate artifact classifies exactly as before — unaffected by
  the new check, regardless of whether a wrap-up-outcome artifact also
  exists for that session (existing priority order wins).
- AC6: A session with real Slate engagement but no wrap-up-outcome artifact
  at all continues to classify as `unknown` with `wrapUpOutcome` absent —
  byte-for-byte the same behavior as before this change.
- AC7: The Review UI's detail view (`describeReviewItem`) shows the real
  trigger/timestamp/per-group failure reason when `wrapUpOutcome` is
  present on an `unknown` item, and shows exactly today's unchanged generic
  message when it is absent.
- AC8: `formatReviewListLines`'s list-row text for `unknown` items is
  unchanged (still `"<sessionId> — last seen <lastSeenAt>"`) regardless of
  `wrapUpOutcome`.
- AC9: The new outcome-artifact write is wrapped in its own try/catch (a
  write failure does not throw out of `runWrapUp` and does not prevent the
  function from returning its already-computed `WrapUpOutcome` to the
  caller).
- AC10: `src/commands/agent.ts` and `src/commands/harness.ts` are
  unmodified by this change (per TRD §1.2 — the fix is entirely inside
  `runWrapUp`/`catch-up.ts`/`review-inspector.ts`).
- AC11: The full existing test suite (`tsc --noEmit` and `bun test`) passes,
  including new tests added in `machine-wrap-up.test.ts`, `catch-up.test.ts`,
  and `review-inspector.test.ts` covering AC1-AC8.
