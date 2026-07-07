# Acceptance Criteria: Block B — Code Understanding (`gdgraph` upgrades)

Version: 1.0.0
Every ACn is **hard** and **fixture-backed** (`F-1`,`F-4`): measured against a
committed corpus, never asserted in prose. All fixtures live beside the block
(`fixtures/<corpus>/`) and are deterministic + git-committed (`F-2`).

---

## AC1 — Symbol + call graph when tree-sitter is present (G-B1 / P-B1)

**Corpus:** `fixtures/symbol-graph/` — a small multi-file source tree with a
hand-labeled `expected/{symbols.jsonl,calls.jsonl}`.

- **AC1.1** With `gdgraph.treesitter` enabled and grammars resolved, `gdgraph build`
  writes `storage/symbols.jsonl` (function/class/method/interface nodes) and
  `storage/calls.jsonl` (`calls` / `defines` / `unresolved-call` edges) in addition
  to the unchanged file-level artifacts.
- **AC1.2** Emitted symbol nodes and CALL/import edges match the labeled expected set
  with **precision ≥ 0.90** on symbol and CALL edges.
- **AC1.3** **Recall ≥ 0.85** on the labeled symbol/CALL edges (floor fixed here; open
  question resolved to 0.85).
- **AC1.4** Symbol ids are stable and content-independent (`<path>#<Container>.<name>`
  with `@<startLine>` disambiguation only on name collision); running `build` twice
  yields **byte-identical** `symbols.jsonl` and `calls.jsonl`.
- **AC1.5** `web-tree-sitter` is imported **only** via `await import()` inside
  `src/gdgraph/treesitter/adapter.ts`; a static check confirms no other `import`
  of it exists in `src/` (`C0-2`).
- **AC1.6** Grammars are resolved solely through Block 0's Asset Resolver (user path,
  `assets pull`, or cache), sha256-verified on every load; a tampered/missing grammar
  ⇒ capability unavailable ⇒ fallback (`A-2`,`A-3`).

## AC2 — Transitive `affected` returns the N-hop closure (G-B2 / P-B2)

**Corpus:** `fixtures/transitive-closure/` — a graph with documented dependent
closures at depths 1..k (including a cycle).

- **AC2.1** For every target and every N in 1..k, `gdgraph affected <target> --depth N`
  returns the **exact** transitive dependent closure to depth N (set-equal to the
  fixture's expected set — no missing, no extra).
- **AC2.2** `gdgraph affected <target>` (no flag) and `--depth 1` both produce stdout
  **byte-for-byte identical** to the pre-block implementation on the same graph
  (Dependencies + Dependents sections, sorted) (`B-3`).
- **AC2.3** The traversal terminates on the cyclic fixture (visited-set) and output is
  deterministic and sorted across repeated runs.
- **AC2.4** `--ranked` / `--json` emit each dependent with `hop` and `fanIn`, ordered
  by `hop` asc → `fanIn` desc → `path` asc; the order is reproducible and the default
  text output is unchanged when the flags are absent.
- **AC2.5** The closure algorithm performs no network I/O and loads no dependency
  (pure over the in-memory graph).

## AC3 — Ranked repo map fits a token budget (G-B3 / P-B3)

**Corpus:** `fixtures/repomap/` — a graph with an expected centrality ordering and a
declared `tokenBudget`.

- **AC3.1** `gdgraph repomap` writes `.metaproject/data/gdgraph/artifacts/repomap.md`
  via personalized PageRank (fixed damping/iterations/tolerance) with import/CALL/defines
  edge weights.
- **AC3.2** The emitted `repomap.md` token estimate (documented estimator, default
  `chars-div-4`) is **≤ the configured `tokenBudget`** (and ≤ any `--budget` override);
  overflow entries are dropped in rank order with a stable "… N entries omitted …"
  marker.
- **AC3.3** Top-ranked entries match the fixture's expected centrality ordering.
- **AC3.4** Re-running `repomap` twice yields a **byte-identical** `repomap.md`
  (empty diff) — deterministic and reproducible (`B-4`,`B-5`).
- **AC3.5** `repomap` uses **no** runtime dependency and **no** network, and no
  vector/embedding retrieval is involved (`B-4`,`B-7`, NG-B2).
- **AC3.6** `repomap --seed <path...>` / `--changed` biases the personalization vector
  to the given nodes; seeded and unseeded runs are each independently reproducible.

## AC4 — Regex fallback is byte-identical when tree-sitter is absent (XP1/XP2, G-B1 preservation)

**Corpus:** any fixture repo + a captured pre-block snapshot of the four legacy
artifacts.

- **AC4.1** With the capability **disabled** (or `web-tree-sitter`/grammars absent),
  `gdgraph build` emits `storage/nodes.jsonl`, `storage/edges.jsonl`,
  `artifacts/module-map.json`, `artifacts/summary.md` **byte-for-byte identical** to
  the pre-block output (`B-1`,`C0-7`,`F-3`).
- **AC4.2** No `symbols.jsonl` / `calls.jsonl` are written, `web-tree-sitter` is never
  imported, and no grammar file is read when the capability is inactive (`C0-4`).
- **AC4.3** Capability **enabled but** dep/grammar missing or checksum-failing ⇒
  **exactly one** stderr warning, the deterministic regex/scan path runs, and the
  process exits **0** — never hard-fail (`C0-5`,`C0-11`).
- **AC4.4** A no-network sandbox run of `build`, `affected`, and `repomap` succeeds
  with **no socket opened** (`T-4`).
- **AC4.5** The full pre-existing `gdgraph` test suite passes unchanged (`C0-7`).

## AC5 — Opt-in wiring & tests (cross-cutting)

- **AC5.1** B1 wires all four opt-in parts (`C0-3`): `init --treesitter` / `--no-treesitter`
  flag, `metaproject.json` `capabilities` entry, `gdgraph.config.json` `treesitter` block
  (deep-merged, malformed ⇒ defaults, `C0-8`), and `resolveCapability("gdgraph.treesitter")
  → Adapter | null`.
- **AC5.2** Each opt-in path has both an availability-true test (grammars stubbed/present)
  and an availability-false fallback test (`T-3`).
- **AC5.3** Every service method later exposed as an MCP Tool (`affected`, `repomap`) has
  an in-process unit test independent of any transport (`T-1`).

---

## Acceptance gate summary

| AC | Item | Gate | Fixture |
|----|------|------|---------|
| AC1 | B1 | symbol/CALL graph, precision ≥ 0.9 / recall ≥ 0.85 | `symbol-graph/` |
| AC2 | B2 | exact N-hop closure; `--depth 1` byte-identical | `transitive-closure/` |
| AC3 | B3 | fits token budget; matches centrality; re-run diff empty | `repomap/` |
| AC4 | fallback | four legacy artifacts byte-identical; no dep/socket; warn-once exit 0 | any repo + snapshot |
| AC5 | opt-in | four-part wiring + availability-true/false tests | — |
