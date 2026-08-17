# Shared Agent Context — Lifecycle Binding PRD
Version: 0.2.0

## Status

Future / planned. The current runtime requires an explicit workspace ID for
each SAC read and has no current-workspace/session-binding surface.

**Note (0.2.0):** FR6's "creation/selection requires explicit confirmation"
and FR7's "offer an explicit wrap-up/proposal path" describe a stance this
package no longer owns for the flow/topic-resolution case — [Keryx Slate v2](../slate/README.md)
(SLATE-16…19) implements automatic resolve-or-create and autonomous propose
dispatch via model judgment instead, by an explicit, documented product
decision. FR3–FR5 and FR8 (explicit `--workspace`/`--session current`
selection, discovery, link-back) are unaffected and remain this package's
scope.

## Problem

An agent or operator currently has to discover and pass a workspace ID on each
read. Session, workspace, Flow, and worktree context can describe the same
work but are not lifecycle-bound. An accepted owner artifact is not linked back
to the originating workspace. This makes resume and handoff unnecessarily
manual while encouraging unsafe prompt-based ID passing.

## Goal

Provide an explicit, optional and immutable binding that lets a trusted local
session resume its authorised workspace context, optionally relate it to a
Flow, and discover a bounded current/list view without making SAC a task
tracker or content-promotion mechanism.

## Users

- Agents resuming authorised work in a trusted local Harness/session.
- Operators using shell commands and worktrees.
- Reviewers who need provenance from an accepted owner artifact back to its
  workspace without exposing contents.

## Functional requirements

1. A trusted server boundary may create a binding only from a verified Session
   and an already authorised workspace; a Flow reference is optional.
2. Binding identity is immutable, opaque, revisioned, and stores only minimal
   metadata: subject hash, workspace ID/revision, Session ID/revision, optional
   Flow reference/revision, worktree derivation metadata, timestamps, status,
   and correlation ID.
3. `keryx shell --workspace <id>` must start a local shell with an explicit
   workspace selection. It must not expose workspace content through environment
   variables or preload it into a prompt.
4. `--session current` may resolve a workspace only for the authenticated
   current Session and only after normal authorisation. Absent, stale, revoked,
   ambiguous, or denied bindings fail with typed, non-disclosing results.
5. Planned agent-native surfaces must provide `current` and `list` discovery
   without requiring `shell_exec`; both return references and metadata only.
6. A Flow/worktree relationship may produce a preview of a derived workspace,
   but creation/selection requires explicit confirmation and an authorised
   workspace operation. Preview never mutates Flow, worktree, or SAC state.
7. Session completion may record a minimal completion association and offer an
   explicit wrap-up/proposal path. It must not change Flow completion, accept a
   proposal, or promote content.
8. After an owner artifact is accepted, a link-back must remain a separate,
   explicit, authorised action. It stores a reference and receipt only, never
   copies the accepted artifact; failure to link back cannot invalidate the
   owner acceptance.

## Non-functional requirements

- Least disclosure: discovery reveals only resources visible to the caller;
  cross-workspace IDs are not confirmed by errors.
- Authorisation and role revision are checked at use time, including resume and
  link-back.
- Context Operations remains the canonical assembly/trace owner. Binding
  lookup changes identity resolution, not selection or prompt assembly.
- The feature remains local-first and future/planned until verified.

## Success criteria

- A valid resumed Session can make an authorised overview/read using
  `--session current` without separately supplying its workspace ID.
- A revoked/foreign/ambiguous Session cannot discover a workspace or infer its
  existence.
- A Flow/worktree preview has zero side effects and no Flow mutation.
- An accepted target can be explicitly linked to its source workspace with an
  auditable receipt, and cannot be linked automatically.

## Risks

- Convenience can accidentally broaden discovery or hide an ambiguous target.
- Session archives may become a source of excess disclosure if treated as
  context instead of provenance.
- Coupling Session and Flow identities could incorrectly make SAC authoritative
  for work state.

## Recommendation

Ship discovery and immutable binding first behind an opt-in local feature gate;
then add completion and explicit link-back only after identity, disclosure, and
native Flow boundary tests pass.
