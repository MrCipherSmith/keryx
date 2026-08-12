# Shared Agent Context Phase 0 — Contract alignment

Status: ready to freeze
Source: user description

## Problem

SAC has a reviewed requirements package but no runtime contract boundary. The
future registry, read path and proposal lifecycle need a single, fail-closed
foundation for validating SAC payloads, resolving workspace-local references,
authorizing a trusted actor and gating production disclosure/egress/writes.

## Expected Outcome

The repository provides an isolated SAC contract module with pinned
Draft-2020-12 validation, semantic invariants, typed realpath-contained
references, server-created ActorContext authorization, and a strict production
guard. Its tests prove the required valid/invalid fixture and security cases.

## Out of Scope

- Workspace persistence/CRUD, Flow mutation, knowledge storage and proposal
  promotion.
- SAC CLI, MCP tool/resource exposure, UI, remote identity and remote egress.
- Changes to existing Flow, Wiki, Memory or Context Operations ownership.
