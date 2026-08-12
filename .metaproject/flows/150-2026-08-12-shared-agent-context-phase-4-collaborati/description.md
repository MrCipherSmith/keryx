# Shared Agent Context — Phase 4: Collaboration ergonomics

Status: approved for implementation
Source: user description

## Problem

SAC Phase 3 records safe proposal lifecycle metadata but does not yet provide a
bounded collaboration view for a trusted local owner. Contributors need to
discover the workspace's worktree/session references, inspect safe activity,
and perform owner-managed collaboration operations without creating a parallel
UI, authorization, or source-of-truth path.

## Expected Outcome

The local SAC surface exposes worktree/session references and a redacted,
append-only activity feed through the same normalized service result used by
CLI and local-stdio MCP adapters. Owner operations remain guarded by trusted
ActorContext, strict policy, and point-of-use authorization. A recorded
usability evaluation demonstrates an unfamiliar-component onboarding and
handoff using only those contracts.

## Out of Scope

- Remote transport or any HTTP SAC endpoint.
- A TUI/IDE-specific data model, authorization bypass, or direct persistence.
- Raw transcripts, prompts, secrets, hidden reasoning, Flow mutations, or
  copied owner-module knowledge.
