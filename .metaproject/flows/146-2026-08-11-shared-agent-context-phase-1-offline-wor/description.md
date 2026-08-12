# Shared Agent Context Phase 1: Offline workspace registry

Status: active implementation
Source: user description

## Problem

SAC Phase 0 provides normative manifest validation, trusted ActorContext issuance,
reference containment, and a strict production guard, but provides no offline
workspace registry. Local users therefore cannot create or maintain a
schema-valid workspace without building their own persistence path.

## Expected Outcome

An offline-only WorkspaceService owns one atomic, schema-validated
`.metaproject/workspaces/<id>/workspace.json` manifest per workspace and
exposes local CLI commands to create, list, show, and add typed resources.
Every mutation uses a trusted ActorContext, current role revalidation, a strict
write guard, root containment, and the established file lock discipline.

## Out of Scope

MCP mutation/resource surfaces, UI, remote transport/sync, copied knowledge,
FWK read assembly, receipts/proposals, a second Flow tracker, and changes to
Flow, Harness, MCP, Context Operations, Wiki, Memory, or Skills ownership.
