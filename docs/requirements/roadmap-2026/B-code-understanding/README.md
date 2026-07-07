# Block B — Code Understanding (`gdgraph` upgrades)

Version: 1.0.0
Status: spec ready for implementation
Depends on: **Block 0 — Capability Seam** (`00-capability-seam/`)
Language: English (module extended is `gdgraph`; this package documents the 2026 upgrade in EN per roadmap convention — see concern note at bottom)

## What this block does

Lifts `gdgraph` from a **file-level regex/scan import graph** to a **symbol-level
code-understanding layer**, without ever losing the deterministic, zero-dependency
floor. Three work items:

| Item | Goal | Purpose | Runtime dep? |
|------|------|---------|--------------|
| **B1 — Tree-sitter symbol graph** | G-B1 | Replace the regex/`Bun.Transpiler` file-level import extraction with a `web-tree-sitter` (WASM) parser that emits **function / class / method** symbol nodes plus **import** and **CALL** edges. | `web-tree-sitter` — **optionalDependency**, lazy-loaded, WASM grammars are XP3 assets. Regex fallback stays the deterministic default. |
| **B2 — Transitive `affected`** | G-B2 | Extend `affected` from one-hop to an **N-hop BFS/DFS closure** over dependents, with a `--depth` control and a ranked blast-radius. | **None** — pure algorithm. |
| **B3 — Ranked repo map** | G-B3 | Emit a context-injectable `repomap.md` via **personalized PageRank** with edge weights, **token-budgeted** by reusing gdctx budget-awareness. | **None** — pure algorithm. |

## The golden rule for this block

With **no `web-tree-sitter` installed and no grammars present**, `gdgraph build`
produces **byte-identical** `storage/nodes.jsonl`, `storage/edges.jsonl`,
`artifacts/module-map.json`, and `artifacts/summary.md` to today (constraints
`B-1`, `C0-7`, `F-3`). The symbol layer is written to **new, additive** storage
files that only exist when the tree-sitter capability is active — the legacy
file-level artifacts never change bytes.

B2 and B3 are **pure early wins**: they operate on whatever graph is present
(file-level in fallback, symbol-level once B1 is active) and ship independently of
the grammar-asset path (`B-9`).

## Files in this package

- [`prd.md`](prd.md) — user stories (US-B*) traced to goals G-B1..G-B3 and problems P-B1..P-B3, with acceptance criteria and priorities.
- [`specification.md`](specification.md) — the new node/edge/symbol schema, the tree-sitter adapter behind the Block 0 capability seam, the transitive-`affected` algorithm (depth + ranking), the PageRank `repomap` spec + token budget, and the regex-fallback byte-identity contract. Follows the `DOC-3` section order.
- [`acceptance-criteria.md`](acceptance-criteria.md) — hard, fixture-backed ACn statements.
- [`tasks.md`](tasks.md) — atomic tasks T-B1..T-Bn with kinds, dependencies (incl. Block 0), and the B2/B3-early / B1-opt-in sequencing.

## Fixture corpora (acceptance artifacts, per `F-1`/`F-2`)

| Corpus | Item | Asserts |
|--------|------|---------|
| `fixtures/symbol-graph/` | B1 | hand-labeled expected symbol nodes + CALL/import edges; regex fallback exits 0 and is byte-identical |
| `fixtures/transitive-closure/` | B2 | graph with known depth-1..k dependent closures; `--depth 1` == today's output |
| `fixtures/repomap/` | B3 | expected centrality ranking + a token-budget bound the output must not exceed |

## Constraint index (from `tech-bestpractices.md` §3 + §0)

Binding: `B-1`..`B-9`, `C0-1`..`C0-14`, `A-1`..`A-7` (grammar assets), `F-1`..`F-4`, `T-3`, `T-4`, `DOC-1`, `DOC-3`, `DOC-4`.

## Concern (naming)

`roadmap-2026/README.md` lists this block's directory as `B-gdgraph/`; the spec
task placed it at `B-code-understanding/`. One of the two must be reconciled so the
roadmap link is not dangling. This package uses `B-code-understanding/` as directed.
