# Shared Agent Context Phase 2: FWK read path

Status: ready to freeze
Source: user description

## Problem

Phase 1 provides an offline workspace manifest but no safe, bounded read path
for task-local Facts, Flow-derived Work, or reviewed Know-how. Agents and MCP
clients therefore cannot retrieve workspace context while preserving source
ownership, freshness, visibility, budgets and auditability.

## Expected Outcome

Provide a read-only SAC FWK service. It resolves visible evidence-backed Facts,
one Flow snapshot projection, and accepted Wiki/Memory/Skill references; builds
bounded overviews and progressive reads through a canonical assembly/trace;
and returns normalized CLI and MCP contracts with metadata-only AccessReceipts.

## Out of Scope

- Flow mutation, a parallel task tracker, or writes to Flow/source knowledge.
- Proposals/review lifecycle, UI, remote transport, copied knowledge, prompts,
  transcripts, hidden reasoning, or secret persistence.
- Any production disclosure when the strict SAC guard does not pass.
