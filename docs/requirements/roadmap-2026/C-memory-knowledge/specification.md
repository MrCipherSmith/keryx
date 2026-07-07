# Specification: Block C — Memory & Knowledge Precision

Version: 1.0.0
Date: 2026-07-07
Language: English
Section order per `DOC-3`: Purpose → Module Identity → Structure → Manifest Entry →
Config → CLI → Service Contract → Actions → Schema → Integration → Hooks → Standard
Profile → Acceptance → Phases → Open Questions.

> Every requirement below references a `tech-bestpractices.md` constraint. This spec adds
> **no** new architectural decision — it instantiates the Block 0 Capability Seam / Asset
> Resolver and the Block A MCP surface for the `memory` + `gdwiki` modules.

---

## 1. Purpose

Raise the recall/precision of the knowledge layer while keeping **git-diffable Markdown
authoritative**. Four capabilities: (C1) opt-in local embedding index, (C2) bitemporal
fact model in Markdown, (C3) procedural memory typing + prompt injection, (C4) `wiki ask`
/ MCP endpoint. With all opt-ins off and no assets present, behavior is byte-identical to
today (`C0-7`).

## 2. Module Identity

| | |
|---|---|
| Modules extended | `memory` (`src/memory/`), `gdwiki` (`src/wiki/`) |
| Cross-cutting reused | `src/mcp/` (Block A) for C4; Capability Seam + Asset Resolver (Block 0) for C1 |
| New runtime deps | one embedding runtime as an `optionalDependency` (C1 only) — lazy, adapter-scoped [C0-1, C0-2] |
| Authoritative store | `.metaproject/memory/<folder>/*.md`, `.metaproject/wiki/**/*.md` — **unchanged as source of truth** [C-1] |
| Derived/disposable | `.metaproject/data/memory/embeddings/` (C1 index) [C-1, NG-C2] |

## 3. Structure (files to add/extend)

```
src/memory/
  types.ts                 # + MemoryClass, bitemporal fields on MemoryEntry, MEMORY_CLASS_MAP
  store.ts                 # parseEntry(): parse class + validity fields (back-compatible)
  search.ts                # unchanged lexical scoring (DEFAULT); + temporal/class prefilter
  config.ts                # + `index` (embedding) + `temporal` + `typing` config blocks
  service.ts               # search() extended; + supersede(); wires embedding adapter
  supersede.ts             # NEW: bitemporal supersede write (non-destructive) [C-4]
  relevant.ts              # generalize → proceduralMemoryForScope() [C-5]
  embedding/
    adapter.ts             # NEW: CapabilityAdapter; lazy await import(runtime) [C0-2]
    index.ts               # NEW: build/load derived index (disposable) [C-1]
    lexical-fallback.ts    # NEW: explicit deterministic path selector [C0-6]
  inject.ts                # NEW: render procedural memory block for prompts [C-5]
src/wiki/
  service.ts               # + ask(): deterministic retrieval (+ optional C1 rerank) [C-6]
  ask.ts                   # NEW: retrieval + citation assembly
src/mcp/                   # Block A — C4 registers here (no business logic) [M-2, M-3]
  resources.ts             # expose wiki + memory read-only [M-4]
  tools.ts                 # register wiki.ask, memory.search thin adapters [M-2]
fixtures/
  paraphrase/              # C1 acceptance corpus [F-1]
  temporal/                # C2 acceptance corpus [F-1]
```

Adapters live beside their service (`src/memory/embedding/adapter.ts`); the service imports
the **interface**, never the runtime. [C0-14]

## 4. Manifest Entry (`.metaproject/metaproject.json`)

Enable/disable read from the manifest (missing manifest ⇒ capability off) [C0-9]:

```jsonc
{
  "modules": {
    "memory": {
      "enabled": true,
      "capabilities": ["embedding"]      // absent ⇒ lexical-only (default)  [C0-3b]
    },
    "gdwiki": { "enabled": true, "capabilities": ["ask"] },
    "mcp":    { "enabled": true }        // required for C4 (Block A)         [M-7]
  }
}
```

Bitemporal (C2) and typing (C3) are **not** gated capabilities — they are additive Markdown
fields active whenever `memory` is enabled, and are byte-compatible with entries that omit
them. Only C1 (dep + asset) and C4 (MCP) are gated ceilings.

## 5. Config (`memory.config.json`, deep-merged over defaults) [C0-8]

New blocks, deep-merged over `DEFAULT_MEMORY_CONFIG` (malformed JSON ⇒ defaults):

```jsonc
{
  "index": {                       // C1 — embedding capability
    "enabled": false,              // default OFF ⇒ lexical only                [C-2]
    "runtime": "<reference-local-embedding-runtime>",   // named reference; loaded lazily
    "modelAssetId": "memory-embed-default",             // resolved via Asset Resolver [A-1]
    "k": 20,                       // candidate pool reranked
    "minScore": 0.0
  },
  "temporal": {                    // C2 — bitemporal
    "enabled": true,
    "defaultQuery": "current"      // "current" | "as-of"; --as-of overrides
  },
  "typing": {                      // C3 — classes
    "injectClasses": ["procedural"],   // classes eligible for prompt injection
    "injectLimit": 10
  }
}
```

`wiki` config gains `{ "ask": { "enabled": false, "k": 8, "rerank": false } }`.

## 6. CLI

| Command | Behavior | Constraint |
|---------|----------|------------|
| `memory search "<q>"` | Default weighted lexical (unchanged). Temporal prefilter = `current`. | C-2 |
| `memory search "<q>" --as-of <YYYY-MM-DD>` | Validity-interval filter; returns facts valid at that date. | C-4 |
| `memory search "<q>" --class <c>` | Restrict to `semantic|episodic|procedural`. | C-5 |
| `memory search "<q>" --semantic` | Force embedding path (errors→warn→lexical if unavailable). | C0-5 |
| `memory index --embeddings` | Build/refresh the derived, disposable embedding index. | C-1 |
| `memory supersede <old-path> --by <new-path>` | Non-destructive supersede write. | C-4 |
| `memory assets pull <id>` | Explicit model download + sha256 verify (Block 0). | A-1, A-2 |
| `wiki ask "<question>"` | Deterministic retrieval + citations; optional C1 rerank. | C-6, C-8 |

## 7. Service Contract

### 7.1 Embedding-adapter interface (C1) — Markdown-authoritative rule

Instantiates the Block 0 `CapabilityAdapter` shape. **The adapter never becomes the source
of truth**: it only ranks entries `collectEntries()` already returned from Markdown. [C-1]

```ts
// src/memory/embedding/adapter.ts
export interface EmbeddingAdapter {
  readonly name: "memory.embedding";
  isAvailable(): Promise<boolean>;               // runtime import OK AND model asset resolved
  embed(texts: string[]): Promise<Float32Array[]>;
}

// resolveCapability(cwd, "memory.embedding") → EmbeddingAdapter | null   (Block 0)
//   null  ⇒ lexical-only path runs (deterministic default)               [C0-4]
//   error ⇒ caught, warn once (stderr), lexical fallback, exit 0         [C0-5, C0-11]

// The service ALWAYS computes the deterministic lexical candidate set first
// (search.ts:searchEntries). When the adapter is available it RERANKS that set
// using cosine similarity; it never introduces entries absent from Markdown and
// never mutates Markdown. Index is stored under data/memory/embeddings/ and is
// disposable/rebuildable.                                                [C-1, NG-C2]
```

**Markdown-authoritative rule (binding):**
1. Ranking source is always `collectEntries()` → Markdown. [C-1]
2. The index stores vectors keyed by `entryPath` + `contentHash`; a stale hash ⇒ the
   entry is re-embedded on next `index`, or ignored (lexical score used) — never trusted
   over Markdown. [XP4]
3. Deleting `data/memory/embeddings/` and re-running MUST reproduce identical rankings for
   the same model. [XP4]
4. With `index.enabled=false`, `searchEntries` output is byte-identical to today. [C-2]

### 7.2 `MemoryService` (extended)

```ts
interface MemoryService {
  // existing: create, index, ingest, check
  search(input: MemorySearchInput): Promise<MemorySearchResult>;   // + temporal/class/semantic
  index(input: MemoryIndexInput & { embeddings?: boolean }): Promise<MemoryIndexResult>;
  supersede(input: MemorySupersedeInput): Promise<MemorySupersedeResult>;   // NEW  [C-4]
}

type MemorySearchInput = {
  cwd: string; query: string;
  filters?: SearchFilters & {
    asOf?: string;            // YYYY-MM-DD → validity-interval query          [C-4]
    class?: MemoryClass;      // semantic|episodic|procedural                  [C-5]
    semantic?: boolean;       // opt into embedding rerank                     [C-1]
  };
};

type MemorySupersedeInput = { cwd: string; oldPath: string; newPath: string; date?: string };
type MemorySupersedeResult = { superseded: string; supersededBy: string; changed: boolean };
```

### 7.3 Procedural injection (C3)

```ts
// src/memory/relevant.ts (generalized) / src/memory/inject.ts
export async function proceduralMemoryForScope(
  cwd: string,
  scope: { module?: string | null; target?: string | null; files?: string[] },
  limit?: number,
): Promise<MemoryEntry[]>;                 // accepted, class=procedural, current, in scope [C-5]

export function renderProceduralBlock(entries: MemoryEntry[]): string;  // "" when empty
```

### 7.4 `GdWikiService.ask` (C4)

```ts
interface GdWikiService {                    // + ask(); existing methods unchanged
  ask(input: { cwd: string; question: string; k?: number }): Promise<WikiAskResult>;
}
type WikiAskResult = {
  question: string;
  citations: Array<{ path: string; title: string; excerpt: string; score: number; source: "wiki" | "memory" }>;
  answerMarkdown: string;      // assembled from citations; deterministic       [C-6, C-8]
};
```

## 8. Actions (behavior detail)

### 8.1 Bitemporal supersede semantics (C2) [C-4, NG-C3]
- **Event-time** = `Valid-From` / `Valid-To` (when the fact was true in the world).
- **Ingestion-time** = `Recorded-At` (when gd-metapro learned it).
- `memory supersede <old> --by <new>` (non-destructive):
  1. Old entry: set `Valid-To = <date>`, `Superseded-By = <new relativePath>`, status
     `superseded`; append a `## Changelog` note. **File stays on disk.**
  2. New entry: set `Supersedes = <old relativePath>`, `Valid-From = <date>` (if unset),
     `Recorded-At = today`.
  3. Both writes pass the existing `guardOutput` security seam before landing. [XP4]
- This **replaces dedup-overwrite** for decisions/constraints where supersession is
  intended: ingest's Mem0-style reconcile (`ingest.ts`) is preserved for near-duplicates,
  but a superseding relationship is explicit and additive, never destructive.
- **Query semantics:**
  - `current` (default): exclude entries with `Valid-To < today` OR `Superseded-By` set.
  - `--as-of <d>`: include entry iff `Valid-From ≤ d` AND (`Valid-To` unset OR `Valid-To > d`).
  - Deterministic string/date comparison — no runtime, no network. [C-4]

### 8.2 Typing + injection (C3) [C-5]
- `MEMORY_CLASS_MAP` maps every `MEMORY_TYPES` kind to one class (see §9).
- `--class` prefilters before scoring; a `procedural` query returns only procedural.
- Injection: flow / task-implementer prompt assembly calls `proceduralMemoryForScope` and
  splices `renderProceduralBlock(...)` into the prompt (generalizes the existing
  `relevantAcceptedMemory` seam used by `src/gdskills/verify.ts`). Empty scope ⇒ no-op.

### 8.3 `wiki ask` (C4) [C-6, C-8]
- Deterministic lexical retrieval over `collect`ed wiki pages + memory entries → top-k
  citations with source paths → assembled `answerMarkdown`. When `memory.embedding` is on,
  an optional rerank reorders citations (never changes the candidate set's provenance).
- Exposed as an MCP **Tool** (`wiki.ask`, thin adapter over `GdWikiService.ask`) and wiki +
  memory as read-only MCP **Resources**; all output routed via `redactRaw`. [M-2, M-4, M-5]
- Scope is strictly the metaproject's own wiki/memory — not arbitrary corpora. [C-8, NG-C4]

## 9. Schema

### 9.1 Memory class type
```ts
export type MemoryClass = "semantic" | "episodic" | "procedural";

export const MEMORY_CLASS_MAP: Record<string, MemoryClass> = {
  decision:            "semantic",
  constraint:          "semantic",
  "historical-context":"semantic",
  "domain"/*pattern*/: "semantic",   // pattern
  pattern:             "procedural",
  "known-mistake":     "procedural",
  "migration-note":    "procedural",
  "integration-note":  "procedural",
  lesson:              "episodic",
  "task-note":         "episodic",
  "review-note":       "episodic",
  incident:            "episodic",
};   // every kind in MEMORY_TYPES maps to exactly one class            [C-5]
```
(Exact per-kind assignment is committed as the acceptance table; the constraint is total
coverage + single class, not the specific mapping above.)

### 9.2 Bitemporal + class Markdown fields (frontmatter grammar)

Fields use the existing header `Key: value` style already parsed by `store.ts`
(alongside `Version:`, `Type:`, `Status:`, `Confidence:`) — **not** YAML frontmatter, to
stay consistent with the shipped parser. All optional; absence = today's behavior.

```markdown
# <title>

Version: 1.0.0
Type: decision
Class: semantic            # C3 — optional; defaults via MEMORY_CLASS_MAP
Status: accepted
Confidence: high
Valid-From: 2026-07-01     # C2 event-time start (optional)
Valid-To:                  # C2 event-time end (empty ⇒ open/current)
Recorded-At: 2026-07-07    # C2 ingestion-time (optional; defaults to Provenance.Created)
Supersedes:                # relativePath of the entry this replaces (optional)
Superseded-By:             # set when this entry is superseded (optional)

## Summary
...
```

`MemoryEntry` gains: `class: MemoryClass`, `validFrom: string | null`,
`validTo: string | null`, `recordedAt: string | null`, `supersedes: string | null`,
`supersededBy: string | null`. Parsing is back-compatible (missing ⇒ null / mapped class).

### 9.3 Derived embedding index (disposable) [C-1, NG-C2]
```
.metaproject/data/memory/embeddings/
  index.meta.json    # { model, dims, generatedAt, entryCount }
  vectors.jsonl      # { entryPath, contentHash, vector:number[] }
```
Never committed as authoritative; safe to delete; rebuilt from Markdown.

## 10. Integration

- **Block 0**: `resolveCapability(cwd, "memory.embedding")`, `resolveAsset(cfg,
  "memory-embed-default")`, `assets.lock.json` pin + `memory assets pull`, fixture-corpora
  harness. [C0-3, A-1..A-4]
- **Block A**: C4 registers Resources/Tool in `src/mcp/` — thin adapters only. [M-2, M-3]
- **flow / task-implementer**: C3 injection extends the prompt-assembly path that already
  consumes `relevantAcceptedMemory`.
- **security**: supersede + wiki-ask writes/outputs pass `guardOutput` / `redactRaw`
  (existing seams). [M-5, XP4]

## 11. Hooks

None new. C4 relies on Block A's MCP registration being manifest-driven [M-11]. C3 injection
is invoked at flow prompt-assembly time, not via a settings hook.

## 12. Standard Profile

`wiki` + `memory` remain generated, git-diffable Markdown emitting the LF-standard
artifacts (Block A framing). C4 exposes them as MCP Resources without adding a rival
standard. No change to the emitted `AGENTS.md` / `SKILL.md` schema. [A3-inherited]

## 13. Acceptance

Gated by the committed fixtures and the `AC-C*` list in `acceptance-criteria.md`:
**paraphrase** (C1 recall@k), **temporal** (C2 current/as-of), type-scoped retrieval (C3),
flow-injection integration test (C3), MCP round-trip (C4), and the XP2 byte-identical
fallback test (C1). Metrics measured against fixtures, not prose. [F-1..F-4]

## 14. Phases

1. **C2 + C3 (dep-free)** — bitemporal fields + parser + supersede + typing + injection.
   No asset, no backend; lands first (lowest risk, no Block-0 asset path needed beyond seam).
2. **C1** — embedding adapter + derived index + Asset Resolver wiring + paraphrase fixture.
3. **C4** — `wiki ask` + MCP Resources/Tool (requires Block A).

## 15. Open Questions

1. Reference embedding runtime + model id/sha for `assets.lock.json` (see prd Open Q2).
2. Confirm header-field grammar vs a `## Validity` section for bitemporal (prd Open Q3).
3. Exact per-kind class assignments in `MEMORY_CLASS_MAP` (acceptance table).
4. Directory naming `C-memory-knowledge/` vs roadmap's `C-memory-wiki/` (prd Open Q1).
