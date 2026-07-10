# Plan — Activate the gdgraph symbol layer (`symbol` / `path` / symbol-aware queries)

Status: implemented · Completed: 2026-07-10 · Historical plan retained for release audit

## Implementation outcome

The activation and query surfaces described by this plan are implemented on
`main`: explicit `symbols enable|disable|status`, deterministic grammar pins,
package-side symbol enrichment, `symbol`, `path`, symbol-aware `find` and
`affected`, transitive caller impact, disambiguation, cross-file call resolution,
wiki backlinks, and graceful file-graph fallback. The plan is no longer an active
work queue and can be archived or removed after the next release if the changelog
and current-behavior documentation remain the canonical record.

## Goal

Give keryx's graph the symbol-level queries agents actually reach for — "where is
X defined / who calls X", "how are A and B connected" — so it stops being a
file-level import map only. This closes the class of agent failures we observed
(mis-reaching for `gdgraph query "<natural language>"`) and brings keryx to rough
parity with graphify's `explain` / `path` for code.

## Current state (already built, just dormant)

The symbol layer is **fully implemented and tested** but gated OFF:

- Types exist: `SymbolNode`, `CallEdge`, `SymbolLayer`, and `GraphData.symbols?/calls?`
  (`src/gdgraph/types.ts`).
- Extraction exists: `src/gdgraph/treesitter/extract.ts` (+ `extract.test.ts`),
  `adapter.ts` (+ `adapter.test.ts`), `grammars.ts`.
- Enrichment exists: `src/gdgraph/enrich.ts` writes
  `.metaproject/data/gdgraph/storage/{symbols,calls}.jsonl` when the capability
  resolves; no-op otherwise (golden rule: file-level artifacts stay byte-identical).
- Consumption exists: `src/gdgraph/repomap.ts` already ranks with call edges and
  renders per-file top symbols **when symbols are present**.

It is dormant because of three gates + one delivery blocker:

1. **Capability disabled by default.** `gdgraph.treesitter` (`adapter.ts:59`) is a
   capability-seam entry; `keryx init` writes no enabled capability (see
   `src/capability/golden-rule.test.ts`). `resolveCapability` returns `null` ⇒ no
   symbols written.
2. **Optional dep.** `web-tree-sitter@^0.22` is a package dep (`package.json:47`),
   present for the package CLI but not for the copied local runner.
3. **Grammar assets.** `*.wasm` grammars resolve via `config.treesitter.grammarsPath`
   (`null` ⇒ resolver cache/pull) — delivered as assets via
   `keryx gdgraph assets pull <id>` (`src/assets/`).
4. **Delivery blocker — `build` delegates to the local runner.**
   `delegateToLocalRunner` routes `gdgraph build` to `.metaproject/core/gdgraph/cli.ts`,
   which "lacks the seam" (`enrich.ts` header) and always produces file-level output.
   **Even with the capability on, symbols will not appear until build runs through
   the seam-aware package path.**

## Phase 0.0 — Real grammar assets (the true blocker, discovered)

Above every gate below sits a hard prerequisite: **the grammar `.wasm` assets do
not exist.** In `.metaproject/assets.lock.json` every asset is placeholder-pinned:

- `tree-sitter-typescript`/`-tsx`/`-javascript` sha256 = `1111…`/`2222…`/`3333…`,
  the `treesitter-grammars` bundle sha256 = the empty-string hash (`e3b0c442…`).
- URL host `https://assets.keryx.dev/…` is unreachable ("Unable to connect").
- `gdgraph assets list` reports all grammars `[missing]`; `assets pull` fails.

The tree-sitter capability's fallback is **empty** (`{symbols:[], calls:[]}`), unlike
security (regex) or memory (hash-embed), so with no grammar there are simply no
symbols. Network to npm/CDN *is* available in the dev env — the grammars themselves
are fetchable — it's the keryx asset host + pinned checksums that don't exist yet.

**Unblock options:**
- **A. Publish assets:** host real `tree-sitter-*.wasm` at the pinned URL and set real
  sha256 in the lock. Correct long-term; needs infra (a real `assets.keryx.dev`).
- **B. Vendor + re-pin (offline-friendly, recommended for first light):** fetch the
  real wasm from npm/CDN, recompute sha256, update `assets.lock.json`, and either
  vendor the wasm under the repo or point `config.treesitter.grammarsPath` at a local
  dir. Note: `resolveAsset` sha-verifies on every load, so the lock sha MUST match the
  real file even for a `grammarsPath` override — re-pinning is mandatory, not optional.
- **C. Plumbing-only now:** ship Phase 0.1 + 0.3 (below) with injected-adapter tests
  so the write path is proven and ready, and defer live grammars to A or B.

Until A or B lands, `symbols.jsonl` cannot populate on any machine.

## Phase 0 — Activation path (make it turn on)

The machinery exists; this phase is UX + wiring, not new extraction.

0.1 **Enable command.** Add `keryx gdgraph symbols enable` / `disable` that flips the
   `gdgraph.treesitter` capability entry in `metaproject.json` (via the capability
   manifest API, not hand-editing) and prints the next step (`gdgraph build`).

0.2 **Grammar asset resolution.** Confirm the grammar asset ids and make
   `symbols enable` (or a `--pull` flag) fetch+verify them via the existing
   `assets pull` path. If assets are unavailable offline, degrade with a clear
   message (no crash) — same discipline as the security model assets.

0.3 **Fix the build delivery blocker.** Pick one:
   - **(preferred) Run enrichment package-side regardless of delegation:** after the
     (possibly delegated) file-level build returns, call `enrichBuildWithSymbols`
     from the package process when the capability is enabled. Keeps the legacy
     runner untouched.
   - Or make `build` non-delegatable when `gdgraph.treesitter` is enabled.
   - Or teach the local runner the seam (heaviest; duplicates the dep).

0.4 **Status surfacing.** `gdgraph` status / `wiki context` / orient freshness note:
   show `symbols: present (N) | absent`. `ctx`/`orient` already have the pattern.

Acceptance: on a repo with the capability enabled + grammars present,
`gdgraph build` writes non-empty `symbols.jsonl` / `calls.jsonl`; on any repo
without them, output is byte-identical to today (golden rule holds).

## Phase 1 — Query surface (the actual value)

All read `storage/{symbols,calls}.jsonl` via `loadGraph` (which already loads them
when present). Each command degrades to a helpful message when symbols are absent
(Phase 2).

1.1 **`keryx gdgraph symbol <name>`** — the "where is X / who calls X" primitive.
   - Resolve `<name>` against `SymbolNode.name` / `id` (exact, then case-insensitive,
     then substring); on multiple hits list them for disambiguation.
   - For each resolved symbol print: definition (`path:startLine`), signature,
     container; **callers** (CallEdge `to == symbol`, `from` resolved to symbol/file);
     **callees** (CallEdge `from == symbol`); `defines` owner file.
   - `--json` for machine use; cap lists with a "+N more".

1.2 **`keryx gdgraph path <A> <B>`** — how two symbols/files are connected.
   - BFS shortest path over combined import + call edges; accept symbol names or
     file paths as endpoints (resolve names via 1.1). Print the node chain.
   - Mirrors graphify `path`; the edges already exist.

1.3 **Symbol-aware `find`.** Extend `src/gdgraph/find.ts` to also rank `SymbolNode`
   by name match (not just file paths), so `gdgraph find "clonePipeline"` returns the
   symbol + its file, not just path matches. Keep file-level behaviour when symbols
   absent.

1.4 **Symbol-aware `affected`.** Let `affected` accept a symbol name (resolve → file,
   optionally symbol-level blast radius via call edges at higher `--depth`). Today
   `affected` is file/import only; call edges make it precise.

## Phase 2 — Degradation & guidance

- When `symbols.jsonl` is absent, `symbol`/`path`/symbol-`find` print:
  `symbol layer not active — enable with 'keryx gdgraph symbols enable' then 'gdgraph build'`
  and, where sensible, fall back to `find` / `ctx rg`.
- Never hard-fail; never network implicitly (assets are explicit pulls).

## Testing

- Extraction/adapter already covered. Add:
  - `symbol` resolution + callers/callees over a fixture `SymbolLayer` (pure, like
    `find.test.ts`; no tree-sitter needed — inject the layer).
  - `path` BFS over a small combined-edge graph.
  - symbol-aware `find`/`affected` ranking with and without a symbol layer.
  - degradation: commands with no `symbols.jsonl` print guidance, exit cleanly.
- Golden rule: a build without the capability leaves the four legacy artifacts
  byte-identical (existing invariant — assert it stays).

## Risks / tradeoffs

- **Offline / asset availability:** grammars are `.wasm` assets; if the pull is
  unavailable the feature must degrade silently (established pattern). Deterministic
  file-level graph remains the floor.
- **Local-runner divergence:** Phase 0.3 must not regress the copied runner's
  file-level guarantee. The package-side enrichment option is the least invasive.
- **Call-edge precision:** `unresolved-call` edges exist (`CallEdge.resolved`);
  `symbol`/`path` should mark unresolved callees rather than dropping them, and
  rank resolved edges first.
- **Cost:** tree-sitter parse on build is bounded to changed files via the existing
  incremental build; keep enrichment on the same changed-file set.

## Rollout order

1. Phase 0.3 (build delivery) + 0.1 (enable) — smallest change that makes symbols
   real. Validate `symbols.jsonl` populates on this repo.
2. Phase 1.1 `symbol` + Phase 2 degradation — the highest-value query, self-contained.
3. Phase 1.2 `path`, 1.3 symbol-`find`, 1.4 symbol-`affected` — incremental.
4. Docs: gdgraph SKILL "always-on orientation" + enforcement sections gain a
   `symbol`/`path` note; regenerate `.metaproject`.

Each step is independently shippable and keeps the golden-rule floor intact.
