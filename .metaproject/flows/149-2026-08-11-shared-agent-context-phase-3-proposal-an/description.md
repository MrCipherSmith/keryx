# Shared Agent Context — Phase 3: Proposal and review lifecycle

Status: formalized
Source: user description

## Problem

SAC can register workspaces and provide bounded FWK reads, but it has no
reviewable, causally auditable way to turn an explicit session or Flow wrap-up
into candidate knowledge.  The missing lifecycle must never let SAC directly
write source knowledge or Flow state, nor permit an acceptance if a current
authority, evidence/ACL, security decision, or guarded target write fails.

## Expected Outcome

An offline SAC proposal service creates immutable `proposed` records from
explicit wrap-up output and appends only causally ordered terminal transitions.
Acceptance delegates to the target owner's guarded writer and succeeds only
after a trusted reviewer, fresh authority/evidence, strict security policy
revision, and target-write receipt agree under one correlation ID.  Local CLI
and MCP adapters expose normalized lifecycle results without copying source
knowledge or mutation authority.

## Out of Scope

- Remote transport, UI, cloud sync, copied source knowledge, and a parallel
  Flow tracker.
- SAC mutation of Flow state or direct writes to Wiki, Memory, or Skills.
- Raw prompts, transcripts, hidden reasoning, credentials, PII, or secrets in
  proposal records, receipts, or ledgers.
