# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

These consolidate Block C's AC-C0..AC-C12 (docs/requirements/roadmap-2026/C-memory-knowledge/acceptance-criteria.md).

## Criteria

- AC1: With no Block C capability enabled and no assets present, the full existing memory+gdwiki suite and every deterministic command behave byte-identically to today — no embedding runtime imported, no socket opened, no asset touched; a no-network sandbox run of `memory search`/`gdwiki collect` succeeds with no socket. This is the package-wide golden-rule floor. [AC-C0]
- AC2: With `index.enabled=false` (default), `memory search` produces byte-identical `latest.md`/`latest.json`/ordering/scores vs today's `searchEntries` on a fixed corpus, and an import-spy asserts no `await import(runtime)` occurs on the default path. [AC-C1]
- AC3: On the committed `fixtures/paraphrase/` corpus, `recall@k` with the embedding index is measurably higher than lexical-only (`recall@k(index) > recall@k(lexical)`, threshold in the fixture manifest); deleting `.metaproject/data/memory/embeddings/` and re-running `memory index --embeddings` rebuilds an identical-ranking index; the Markdown store is never mutated by indexing or search. [AC-C2, AC-C3]
- AC4: The `memory.embedding` capability enabled but with runtime uninstalled / model asset missing / checksum mismatch ⇒ exactly one stderr warning, lexical result returned, exit 0; an adapter runtime error is caught and degrades to lexical; both an availability-true rerank test and an availability-false fallback test exist; `@xenova/transformers` is imported only via lazy `await import()` in `src/memory/embedding/adapter.ts` (static guard extended). [AC-C4]
- AC5: On the committed `fixtures/temporal/` corpus, the default `current` query excludes any entry with a past `Valid-To` or a `Superseded-By`; `memory search --as-of <date>` returns the entry whose validity interval contains `<date>`; resolution is 100% correct on the fixture. [AC-C5]
- AC6: `memory supersede <old> --by <new>` sets the old entry's `Valid-To`+`Superseded-By`+status `superseded` and the new entry's `Supersedes`; both files remain on disk; the change is plain Markdown (no database) written through the security seam. [AC-C6]
- AC7: `MEMORY_CLASS_MAP` maps every `MEMORY_TYPE_VALUES` kind to exactly one of `semantic|episodic|procedural` (exhaustiveness test); `memory search --class procedural` returns only procedural entries. [AC-C7]
- AC8: A flow / task-implementer prompt-assembly integration test shows relevant accepted, current, procedural memory for the task scope is rendered into the assembled prompt via `proceduralMemoryForScope` + `renderProceduralBlock`; empty scope ⇒ prompt unchanged. [AC-C8]
- AC9: An MCP client completes `tools/list` → `tools/call wiki.ask` and `resources/list` → `resources/read` against a fixture project over stdio; `wiki.ask` is a thin adapter over `GdWikiService.ask` (no business logic in `src/mcp/`); all output passes through `redactRaw`. With `modules.mcp.enabled=false` (or `wiki.ask` disabled), `gdwiki collect` output is byte-identical to today and no MCP surface is exposed. [AC-C9, AC-C10]
- AC10: Across C1–C4 all authoritative knowledge lives in committed Markdown; every derived layer (embedding index, MCP responses, injected prompt blocks, wiki answers) is reproducible from Markdown and cannot mutate it outside the explicit create/ingest/supersede write paths (each through the security seam) — proven by a provenance/reproducibility test and a store-mutation guard across search/index/ask. `fixtures/paraphrase/` and `fixtures/temporal/` are git-committed, labeled, and deterministic. [AC-C11, AC-C12]
- AC11: `bun run check` (typecheck + full suite) passes with the 268 pre-existing tests unchanged; `package.json` `dependencies` stays empty; roadmap-2026 status updated.
