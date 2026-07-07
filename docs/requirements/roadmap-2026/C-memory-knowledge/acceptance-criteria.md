# Acceptance Criteria: Block C — Memory & Knowledge Precision

Version: 1.0.0
Date: 2026-07-07

Each `AC-C*` is **hard** (inviolable) and measured against a committed, deterministic
fixture or an in-process test — never asserted in prose [F-4]. Constraint tags reference
`tech-bestpractices.md`. The block is **DONE** only when all `AC-C*` pass.

---

## Package-wide floor (inherited)

### AC-C0 — Byte-identical with everything off [C0-7, XP1/XP2]
With no Block C capability enabled and no assets present, the full existing `memory` +
`gdwiki` test suite and every deterministic command behave **byte-identically to today**:
no embedding runtime imported, no socket opened, no asset touched.
- **Measured by**: full existing suite green; no-network sandbox run of `memory search` /
  `gdwiki collect` succeeds with no socket [T-4].

---

## C1 — Optional embedding index

### AC-C1 — Lexical default unchanged when embeddings OFF [C-2, C0-4, F-3]
With `index.enabled=false` (default), `memory search` produces **byte-identical**
`latest.md` / `latest.json` / ordering / scores vs today's `searchEntries` on a fixed
corpus. No embedding import occurs.
- **Measured by**: golden-file diff on a fixed corpus + import-spy asserting no
  `await import(runtime)` on the default path.

### AC-C2 — Embeddings improve recall on the paraphrase fixture when ON [C-1, C-3, F-1, F-4]
On the committed `fixtures/paraphrase/` corpus (query→expected-memory including
paraphrased/semantic queries), **recall@k with the embedding index is measurably higher**
than lexical-only.
- **Measured by**: `recall@k(index) > recall@k(lexical)` computed by the fixture harness;
  threshold recorded in the fixture manifest.

### AC-C3 — Index is derived, disposable, non-authoritative [C-1, NG-C2, XP4]
Deleting `.metaproject/data/memory/embeddings/` and re-running `memory index --embeddings`
rebuilds the index and yields identical rankings for the same model; the Markdown store is
never mutated by indexing or search.
- **Measured by**: delete→rebuild→re-query determinism test; store-mutation guard test.

### AC-C4 — Absent/failed backend degrades gracefully [C0-5, C0-11, A-3]
Capability enabled but runtime uninstalled / model asset missing / checksum mismatch ⇒
one stderr warning, lexical result returned, **exit 0**. Adapter runtime error is caught
and degrades to lexical.
- **Measured by**: availability-false fallback test [T-3]; checksum-mismatch test returns
  `null` from Asset Resolver.

---

## C2 — Bitemporal fact model

### AC-C5 — Superseded decision answerable by validity interval [C-4, NG-C3]
On the committed `fixtures/temporal/` corpus (supersession chains + as-of queries):
- default `current` query **excludes** any entry with past `Valid-To` or a `Superseded-By`;
- `memory search --as-of <date>` **returns** the entry whose validity interval contains
  `<date>`;
- resolution is **100% correct** on the fixture.
- **Measured by**: temporal fixture harness (current vs as-of assertions).

### AC-C6 — Supersede is non-destructive and git-diffable [C-4, XP4]
`memory supersede <old> --by <new>` sets the old entry's `Valid-To` + `Superseded-By` +
status `superseded` and the new entry's `Supersedes`; **both files remain on disk**; the
change is plain Markdown, reproducible, and introduces no database.
- **Measured by**: supersede unit test asserting both files present + expected fields; diff
  is Markdown-only.

---

## C3 — Typing + procedural injection

### AC-C7 — Every kind mapped; type-scoped retrieval is exact [C-5]
`MEMORY_CLASS_MAP` maps **all** `MEMORY_TYPES` kinds to exactly one of
`semantic|episodic|procedural`; `memory search --class procedural` returns **only**
procedural entries.
- **Measured by**: exhaustiveness test over `MEMORY_TYPE_VALUES`; type-scoped retrieval test.

### AC-C8 — Procedural memory injected into a flow task [C-5]
A flow / task-implementer prompt-assembly integration test shows that relevant **accepted,
current, procedural** memory for the task scope is rendered into the assembled prompt via
`proceduralMemoryForScope` + `renderProceduralBlock`; empty scope ⇒ prompt unchanged.
- **Measured by**: integration test asserting the procedural block is present in the
  assembled prompt (and absent when no procedural memory is in scope).

---

## C4 — gdwiki Q&A / MCP endpoint

### AC-C9 — Wiki question resolves over MCP (stdio) [C-6, M-2, M-3, T-2]
An MCP client completes `tools/list` → `tools/call wiki.ask` and `resources/list` →
`resources/read` against a fixture project **over stdio** in CI; `wiki.ask` is a thin
adapter over `GdWikiService.ask` (no business logic in `src/mcp/`); all output passes
through `redactRaw`.
- **Measured by**: stdio MCP round-trip test against a fixture project.

### AC-C10 — Deterministic collect unchanged when endpoint disabled [C-6, M-7]
With `modules.mcp.enabled=false` (or `wiki.ask.enabled=false`), `gdwiki collect` output is
byte-identical to today and no MCP surface is exposed.
- **Measured by**: golden-file diff of `gdwiki collect` with the endpoint off.

---

## Cross-cutting

### AC-C11 — git-diffable Markdown remains the source of truth [C-1, NG-C2, XP4]
Across C1–C4, all authoritative knowledge lives in committed Markdown; every derived layer
(embedding index, MCP responses, injected prompt blocks, wiki answers) is reproducible
from that Markdown, and none of them can mutate it outside the explicit
`create`/`ingest`/`supersede` write paths (each of which passes the security seam).
- **Measured by**: provenance/reproducibility test — regenerate all derived artifacts from
  Markdown and diff; store-mutation guard across search/index/ask paths.

### AC-C12 — Fixtures committed and deterministic [F-1, F-2]
`fixtures/paraphrase/` (C1) and `fixtures/temporal/` (C2) are git-committed, labeled, and
deterministic; the block PRD names them as acceptance gates.
- **Measured by**: fixture presence + deterministic re-run of the harness.
