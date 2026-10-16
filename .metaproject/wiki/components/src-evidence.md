---
Title: Module src/evidence
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/evidence` is the Evidence Retrieval Layer: opt-in lexical retrieval over configured files and session archives, with durable lifecycle, exact visible-context filtering and opt-in automatic recall. Hybrid is gated."
---
# Module src/evidence

## Summary

Separate lane for untrusted raw evidence, distinct from accepted memory, wiki and
Shared Agent Context. Disabled by default. Code for phases P0 to P4 is on the PR
#1022 branch; acceptance (T12 evaluation, T13 review) is open, so no benefit is
claimed. Requirements: `docs/requirements/keryx-evidence-retrieval/`. Operator
guide: `docs/docs/guides/evidence-retrieval.md`.

## How it works

- **Config:** `config.ts` parses `.metaproject/evidence.json` (`service.ts`
  `loadEvidenceConfig`, 64 KiB cap). Absent means disabled.
- **Sources:** `inventory.ts`, `sources.ts`, `source-owner.ts` read configured roots
  and, with `sessionArchives`, session archives, through the scanner before storage.
- **Index and storage:** `index.ts`, `search.ts`, `storage.ts` publish immutable
  generations under `.metaproject/evidence/`; `lifecycle.ts` holds the durable
  revocation ledger, writer lease, reader pins, drain and 30-day retention.
- **Runtime:** `runtime.ts` (`createEvidenceRuntime`, `loadEvidenceRuntime`) owns
  build, search, status, clear, maintenance and session revocation.
- **Surfaces:** `commands/evidence.ts` (CLI), `tool.ts` (read-only
  `evidence_search`), `automatic.ts` (one retrieval per user turn, wired in
  `commands/agent.ts` and `commands/shell.ts`).
- **Visibility:** `visibility.ts` and `projection.ts` remove hits already visible
  in the request; exact attribution needs the adapter's serialized request, which
  only the OpenAI adapter provides. Others report unknown.
- **Hybrid:** `hybrid.ts`, `embedding-builder.ts`, `vector-cache.ts` exist, but
  `createEvidenceRuntime` returns `hybrid-owner-unavailable` for `mode: "hybrid"`
  without an embedding owner, and no CLI, tool or automatic path supplies one.

## Known limits

- T12 paired evaluation open; only a smoke set and a lexical arm exist
  (`scripts/benchmark/*evidence-evaluation*`).
- T13 review is a reduced static assessment (`.metaproject/data/review/pr1022-t13/`).
- No TUI surface.
- Session revocation is a trusted API: no CLI, no archive deletion.
- Rollout decision: pending operator.
