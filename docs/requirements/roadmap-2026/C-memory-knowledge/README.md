# Block C — Memory & Knowledge Precision (`memory` + `gdwiki`)

Version: 1.0.0
Date: 2026-07-07
Status: spec (flow-runnable)
Language: English
Depends on: **Block 0 — Capability Seam** (all of C); **Block A — Interop / MCP** (C4 only)

---

## What this block is

Block C lifts the **recall and precision ceiling** of gd-metapro's knowledge layer
(`memory` + `gdwiki`) **without ever displacing the git-diffable Markdown as the
authoritative source of truth**. Every capability here is an **opt-in ceiling** on top
of the deterministic floor: with nothing enabled and no assets present, `memory` and
`gdwiki` behave **byte-identically to today** (the package-wide `C0-7` gate).

It contains four work items, each an independent capability instantiated through the
Block 0 seam:

| Item | Name | One-liner | Backend? |
|------|------|-----------|----------|
| **C1** | Optional embedding index for `memory` search | Opt-in local embedding adapter that improves paraphrase/semantic recall; deterministic weighted lexical search stays the default. Index is a **derived, disposable** artifact. | local embedding runtime (asset via Asset Resolver) |
| **C2** | Bitemporal fact model | Add validity-interval header fields to Markdown memory entries (`Valid-From` / `Valid-To` / `Superseded-By`) so a decision can be **superseded** — event-time vs ingestion-time — instead of dedup-overwrite. Answers "what did we believe when." | none (pure Markdown fields) |
| **C3** | Procedural memory typing + injection | Map/extend `lessons`/`decisions`/`constraints` to a `semantic` / `episodic` / **`procedural`** class; the procedural class is **actively injected** into task-implementer prompts, not just searched. | none (pure metadata) |
| **C4** | gdwiki Q&A / MCP endpoint | Expose wiki + memory as MCP **Resources** and a `wiki ask` action (deterministic retrieval; optional embedding rerank reusing C1). Rides Block A's stdio-first surface. | none new (reuses A + C1) |

## Design invariants (inherited, non-negotiable)

- **Markdown is authoritative.** The embedding index (C1), the bitemporal fields (C2),
  the type metadata (C3), and the wiki answers (C4) are all **derived from or expressed
  in** the git-diffable Markdown store. The index is disposable and rebuildable; the
  Markdown is never a cache of a database. [C-1, C-2, NG-C2]
- **Deterministic default.** Weighted lexical search (`src/memory/search.ts`) remains the
  default and the fallback. No embedding backend configured ⇒ retrieval is byte-identical
  to today. [C-2, XP2]
- **Local only.** Embeddings are a local runtime + local model asset (user-provided or
  explicit `assets pull`); **no hosted embedding API, no external vector DB, no graph DB.**
  [C-3, C-7, NG-C1, NG-C3]
- **File-native temporal model.** Validity intervals live in Markdown header fields, not a
  database; "current" and "as-of" queries are deterministic filters over those fields.
  [C-4, NG-C3]
- **Scoped.** Not a general RAG assistant — scope is the metaproject's own `memory` and
  `wiki` data only. [C-8, NG-C4]

## Files in this package

| File | Purpose |
|------|---------|
| `README.md` | This overview. |
| `prd.md` | User stories (US-C*), goals→stories traceability, non-goals, priorities. |
| `specification.md` | Technical spec: embedding-adapter interface, bitemporal frontmatter schema + supersede semantics, procedural type + injection contract, `wiki ask` / MCP resource. Follows the `DOC-3` section order. |
| `acceptance-criteria.md` | Hard `AC-C*` acceptance criteria, each measured against a committed fixture. |
| `tasks.md` | Atomic tasks `T1..Tn` with kind, dependencies (incl. Block 0 and, for C4, Block A). |

## Existing code this block extends (do not re-spec)

- `src/memory/` — `service.ts` (`createMemoryService`), `search.ts` (weighted lexical),
  `store.ts` (`collectEntries` / `parseEntry`), `config.ts` (`loadMemoryConfig`,
  deep-merge), `types.ts` (`MemoryEntry`, `MEMORY_TYPES`), `ingest.ts` (Mem0-style
  reconcile), `relevant.ts` (`relevantAcceptedMemory` — the existing injection seam).
- `src/wiki/` — `service.ts` (`createGdWikiService`), `types.ts`, `templates.ts`.
- `docs/requirements/documentation-memory/` and `docs/requirements/wiki/` — the shipped
  module specs. Block C is **additive** to these.

## Acceptance gate (summary)

1. Lexical default **unchanged** when embeddings off (byte-identical). [AC-C1]
2. Embeddings **improve recall@k** on the paraphrase fixture corpus when on. [AC-C2]
3. A superseded decision is **answerable by validity interval** (excluded from "current",
   retrievable "as-of"). [AC-C4]
4. Procedural memory is **injected into a flow task** (task-implementer prompt). [AC-C6]
5. **git-diffable Markdown remains the source of truth** across every capability. [AC-C8]

See `acceptance-criteria.md` for the complete, testable list.
