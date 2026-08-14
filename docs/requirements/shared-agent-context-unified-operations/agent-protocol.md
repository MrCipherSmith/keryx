# Shared Agent Context — Unified Operations: Agent Protocol
Version: 0.1.0

## Status

**Future / planned protocol.** It applies after a registry-backed local surface
is delivered; it does not grant existing CLI/MCP/Harness tools new powers.

## Capability-first behavior

1. Query an authorised operation’s capability status before relying on it.
2. Treat `disabled`, `unavailable`, `degraded`, `unsupported-transport`, and
   `denied` as distinct typed outcomes; do not guess an alternate adapter.
3. Use the documented operation/defaults rather than constructing hidden CLI,
   MCP, or shell arguments.
4. Preserve `correlationId` in user-visible reports and follow deprecation
   notices toward the registry-declared replacement.

## Workspace behavior

An agent may request `workspace.current`, `workspace.list`, or
`workspace.doctor` only through the authorised future operation surface.
`current: none` and `not-found-or-denied` are not invitations to search paths,
ask another agent for IDs, enumerate Flow files, or infer hidden workspace
existence. The agent reports a safe diagnosis and requests an explicit authorised
binding when needed.

## Proposal-review behavior

An agent uses `proposal.inbox` only for its current reviewer scope, follows
opaque cursors unchanged, and uses `show`/`preview` to inspect immutable
proposal/transition data. It does not treat a mutable note, full transcript, or
unrelated knowledge target as review evidence. It cannot accept a proposal
without the target owner’s existing guarded workflow.

## Handoff behavior

An agent creates/reads handoff metadata only through the collaboration-owner
operation. It uses structured permitted references and states, not copied
secrets, raw activity logs, unbounded transcripts, or remote credentials. A
handoff does not transfer role authority or create a cross-worktree sharing
permission.

## Prohibited behavior

- Passing actor/role/owner claims to influence authorization.
- Treating help/docs output as proof an operation is currently enabled.
- Retrying via a different transport to bypass a disabled/denied result.
- Revealing or inferring hidden workspace/proposal identity from errors,
  pagination, timing, doctor output, or operation aliases.
- Calling owner internals or generic writers in place of a registry operation.
