# Shared Agent Context — Lifecycle Binding Implementation Plan
Version: 0.1.0

## Status

Future / planned implementation sequence. This plan authorises no runtime
change by itself.

## Preconditions

1. Preserve SAC's existing trusted ActorContext, workspace ACL, receipt, and
   owner-write boundaries.
2. Establish an authoritative Session identity/completion interface and a
   read-only native Flow projection; do not use filesystem heuristics as
   authority.
3. Define retention and audit policy for minimal binding metadata before
   persisting it.
4. Treat accepted RP-02 owner-port contracts and RP-04 proposal intent,
   preview/binding digest, receipt, and link-back contracts as hard
   prerequisites. Pin their versions and pass IC-2 compatibility fixtures
   before resolver or link-back implementation starts.

## Phased plan

1. **Binding model and resolver** — Add immutable binding/event schemas,
   fresh/revoked/ambiguous outcomes, repository-local storage protection,
   explicit feature gate, and unit tests for identity/ACL/revision checks.
2. **Explicit shell and resolver integration** — Implement planned
   `shell --workspace <id>` and `--session current` resolution behind the gate.
   Retain ordinary workspace read/overview authorisation and Context Operations
   assembly unchanged.
3. **Agent-native discovery** — Add metadata-only `current`/`list` surfaces,
   pagination and least-disclosure tests. Do not expose a current-workspace
   environment variable or content preload.
4. **Flow/worktree preview** — Build a native read-only derivation preview,
   digest its validated inputs, and verify zero persistent writes in Flow,
   worktree, and workspace stores.
5. **Completion association** — Append minimal Session completion metadata;
   prove it cannot update Flow or create/promote a proposal.
6. **Explicit link-back** — Add receipt-bound, idempotent intent/recovery flow
   that attaches only a reference after `owner-accepted` owner output and moves
   the proposal to `accepted` only when the target and SAC link-back receipts
   match the same RP-04 intent/proposal revision.
7. **Operational verification** — Run the full validation matrix, privacy
   review, adversarial authorization tests, migration/rollback rehearsal, and
   documentation/CLI smoke checks before broad enablement.

## Gates and rollout

Each phase stays disabled by default until its negative tests pass. Start with
one trusted local user and explicit workspace selection. Do not enable a later
phase if earlier evidence shows disclosure widening, Flow mutation, automatic
promotion/linking, lost idempotency, or Context Operations bypass. Rollback
disables resolution/use of the new surfaces while preserving append-only audit
records under retention policy; it must not delete or alter owner artifacts.

## Definition of done

The implementation is done only when the planned CLI and agent discovery
surfaces pass the validation matrix, every resolved read remains bounded and
authorised, previews are side-effect free, completion is non-mutating, and
accepted-target link-back is explicit, receipt-bound, idempotent, and separate
from owner acceptance.
