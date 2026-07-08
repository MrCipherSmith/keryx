# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

These consolidate Block B's AC1..AC5 (docs/requirements/roadmap-2026/B-code-understanding/acceptance-criteria.md).

## Criteria

- AC1: With `gdgraph.treesitter` enabled and grammars resolved, `gdgraph build` writes `storage/symbols.jsonl` (function/class/method/interface nodes) and `storage/calls.jsonl` (calls/defines/unresolved-call edges) in addition to the unchanged file-level artifacts; emitted symbol + CALL/import edges match the hand-labeled `fixtures/symbol-graph/expected/` with precision ≥ 0.90 and recall ≥ 0.85; symbol ids are stable (`<path>#<Container>.<name>`, `@<startLine>` only on collision) and re-running `build` yields byte-identical `symbols.jsonl`/`calls.jsonl`. [Block B AC1]
- AC2: For every target and every N in 1..k, `gdgraph affected <target> --depth N` returns the exact transitive dependent closure to depth N (set-equal to the fixture, no missing/extra); traversal terminates on the cyclic fixture and output is sorted/deterministic; `--ranked`/`--json` emit each dependent with `hop` and `fanIn` ordered by hop asc → fanIn desc → path asc; the closure is pure (no network, no dep); `affected` with no flag and `--depth 1` produce stdout byte-for-byte identical to the pre-block implementation. [Block B AC2]
- AC3: `gdgraph repomap` writes `.metaproject/data/gdgraph/artifacts/repomap.md` via personalized PageRank (fixed damping/iterations/tolerance, import/CALL/defines edge weights); the emitted token estimate (chars/4) is ≤ the configured `tokenBudget` and any `--budget` override with a stable "… N entries omitted …" marker; top-ranked entries match the fixture's expected centrality ordering; re-running twice yields a byte-identical `repomap.md`; no runtime dependency, no network, no embeddings; `--seed <path...>`/`--changed` biases personalization and each run is independently reproducible. [Block B AC3]
- AC4: With the capability disabled (or `web-tree-sitter`/grammars absent), `gdgraph build` emits `storage/nodes.jsonl`, `storage/edges.jsonl`, `artifacts/module-map.json`, `artifacts/summary.md` byte-for-byte identical to the captured pre-block snapshot; no `symbols.jsonl`/`calls.jsonl` written, `web-tree-sitter` never imported, no grammar read; enabled-but-dep/grammar-missing ⇒ exactly one stderr warning, deterministic regex path runs, exit 0 (never hard-fail); a no-network sandbox run of build/affected/repomap opens no socket; the full pre-existing gdgraph suite passes unchanged. This is the package-wide golden-rule gate. [Block B AC4]
- AC5: B1 wires all four opt-in parts (`init --treesitter/--no-treesitter` flag, `metaproject.json` `capabilities` entry, `gdgraph.config.json` `treesitter` block deep-merged with malformed→defaults, `resolveCapability("gdgraph.treesitter") → Adapter|null`); each opt-in path has both an availability-true test (grammars stubbed) and an availability-false fallback test; `affected` and `repomap` each have a transport-independent in-process unit test; `web-tree-sitter` is imported only via `await import()` in `treesitter/adapter.ts` (static guard extended). [Block B AC5]
- AC6: `bun run check` (typecheck + full suite) passes with the 235 pre-existing tests unchanged; `package.json` `dependencies` stays empty; roadmap-2026 status updated and the `B-code-understanding/` link reconciled.
