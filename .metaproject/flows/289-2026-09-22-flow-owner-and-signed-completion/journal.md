# Flow Journal

- 2026-09-22T22:30:55.194Z - flow created
- 2026-09-22T22:37:33.320Z - frozen: 10 criteria; checksum recorded
- 2026-09-22T22:37:33.519Z - started
- 2026-09-22T22:37:33.728Z - task-added: T5: Owner field, flow init --owner, flow owner set with reason and history
- 2026-09-22T22:37:33.928Z - task-added: T6: Identity with basis and source; signatures on ac confirm and complete
- 2026-09-22T22:37:34.129Z - task-added: T7: Opt-in owner gate for new flows; old flows skip it
- 2026-09-22T22:37:34.337Z - task-added: T8: Backward compatibility fixture: old flow.json loads, checks and completes unchanged
- 2026-09-22T22:37:34.535Z - task-added: T9: flow status shows owner and latest signature
- 2026-09-22T22:37:34.733Z - task-added: T10: Docs: help, CLI reference, README, decision record, limits
- 2026-09-22T22:37:34.940Z - task-added: T11: Verification: CI green, keryx health run
- 2026-09-22T22:37:35.139Z - task-attempt: T5: started (attempt 1)
- 2026-09-22T23:15:00.000Z - phase 2 implementation (T5-T10): added `src/flow/identity.ts`
  (Identity/IdentityBasis, resolveSignerIdentity, ownerIdentity, describeIdentity — mirrors
  src/forgetting/journal.ts's Attribution doctrine, no cross-module import). Added
  `FlowState.owner`/`FlowState.signatures`, `FlowGates.owner`, `GateOutcome` "owner" member
  to src/flow/types.ts, plus `ownerSet` on FlowService. Added `ownerGate` and owner/signature
  writes to src/flow/service.ts's `init`/`acConfirm`/`complete`. Extended
  src/flow/schema.ts (+ regenerated docs/requirements/keryx-metaproject-native/schemas/flow-state.schema.json)
  with `owner`/`signatures`/`identity`/`flowSignature` definitions, additive only, no new
  schemaVersion. Wired `flow init --owner`, `flow owner set`, `--signed-by` on `ac confirm`/
  `complete`, and owner/signature lines on `flow status` in src/commands/flow.ts. Added
  src/flow/identity.test.ts, owner.test.ts, owner-gate.test.ts, signatures.test.ts,
  owner-backward-compat.test.ts, owner-status-cli.test.ts (94 new assertions). Fixed 16
  pre-existing src/flow/*.test.ts assertions that hardcoded the gate list/count (owner gate
  now appears between tasks and review) and 3 harness FlowService mock literals needing the
  new `ownerSet` method. Documented in docs/decisions/keryx-harness/TM-02-flow-owner-and-signed-completion.md,
  docs/docs/cli-reference.md, and README.md. `bun run typecheck` clean, `bunx eslint` clean
  on every touched/added file, `bun test src/flow/` 257/257 pass, `keryx flow check` reports
  all flows consistent. AC10 (CI green) left for the PR pipeline.
- 2026-09-22T23:01:33.060Z - task-done: T5: Owner field, flow init --owner, flow owner set with reason and history
- 2026-09-22T23:01:33.168Z - task-done: T6: Identity with basis and source; signatures on ac confirm and complete
- 2026-09-22T23:01:33.270Z - task-done: T7: Opt-in owner gate for new flows; old flows skip it
- 2026-09-22T23:01:33.375Z - task-done: T8: Backward compatibility fixture: old flow.json loads, checks and completes unchanged
- 2026-09-22T23:01:33.476Z - task-done: T9: flow status shows owner and latest signature
- 2026-09-22T23:01:33.582Z - task-done: T10: Docs: help, CLI reference, README, decision record, limits
- 2026-09-22T23:20:00.000Z - PR #649 review fixes (5 items, HEAD 3bd43608 committed/pushed
  by the coordinator beforehand): (1) added a test for the REAL flow-201/204 legacy shape
  (`gates: { tasks: true, review: true }`, no `owner` key) in src/flow/owner-gate.test.ts —
  pins that the gate reads `!flow.gates?.owner`, not `!flow.gates`. (2) added a test in
  src/flow/signatures.test.ts that `flow ac update` clears `acConfirmed` but leaves
  `signatures` and the owner + its history untouched. (3) `flow init --owner "   "` now
  throws the same `BLANK_OWNER_MESSAGE` as `flow owner set` instead of silently yielding
  "not set" (src/flow/service.ts: new shared constant + an early guard in `init()`); added
  3 tests in src/flow/owner.test.ts, including one asserting the init and ownerSet error
  messages are byte-identical. (4) fixed the review-gate.test.ts title at line ~1334
  ("sixth, after tasks" -> "seventh, after owner") and strengthened its assertion to also
  check review comes after owner, not just after tasks. (5) reworded every `headCommit`
  description (src/flow/types.ts doc comment, src/flow/service.ts's `evaluatedHeadCommit`
  comment, docs/docs/cli-reference.md, TM-02 doc §3) to say precisely "the head commit the
  pull-request gate observed" (not "the completion gates evaluated") and added an explicit
  note that base-branch/review re-fetch independently, so a mid-`complete()` push could make
  them see a different head than the one the signature records — no gate re-architecture, per
  instruction. Verification: `bun run typecheck` clean; `bunx eslint` clean on
  src/flow/service.ts, types.ts, owner.test.ts, owner-gate.test.ts, signatures.test.ts,
  review-gate.test.ts; `bun test` on those 4 touched test files — 81/81 pass; full
  `bun test src/flow/` — 261/261 pass (was 257, +4 new tests), 0 fail; `keryx flow check`
  — all flows consistent. schema.ts/docpack untouched this round (no shape change).
