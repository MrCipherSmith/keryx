# Consistency Report: gd-metapro Extension Package (Blocks 0 + A–E)

Version: 1.0.0 · Date: 2026-07-07
Checker: gproject-consistency-checker (package-wide, cross-block)
Scope: the 6-block documentation package under `docs/requirements/roadmap-2026/`
validated against the pipeline artifacts `problem-statement.md`, `architecture.md`,
`tech-bestpractices.md`.

## Verdict: PASS_WITH_WARNINGS

- **CRITICAL violations: 0** (no blocking contradiction; the package is internally coherent and safe to launch).
- **WARNING: 4**
- **INFO: 7**

The deterministic-core opt-in policy (XP1–XP5 / C0-1..C0-14) is preserved by every
block; the cross-block dependency graph is a coherent DAG (all blocks depend on Block 0;
A owns E3; C4 depends on A; no cycles); every block is a self-contained, `flow`-runnable
unit with its own ACs and task decomposition. The warnings are cleanliness / uniformity
issues (a leaked generation artifact in two blocks, a not-yet-unified capability-manifest
representation, two self-flagged convention deviations), none of which block implementation.

---

## Summary of checks executed

| Check category | Items checked | Passed | Flagged |
|----------------|--------------:|-------:|--------:|
| XP1–XP5 opt-in policy per block (empty `dependencies`, lazy optionalDeps, graceful no-op, assets never bundled/auto-fetched, stdio-first) | 6 blocks × 5 policies | 30 | 0 |
| Cross-block dependency coherence (all→Block 0; A owns E3; C4→A; E3 ref→A; no cycles) | 6 | 6 | 0 |
| Package completeness (README+prd+specification+acceptance-criteria+tasks per block) | 30 files | 30 | 0 |
| Independent `flow`-runnability (self-contained scope + own ACs + task decomposition) | 6 | 6 | 2 (INFO/WARN) |
| Cross-block contradiction scan (E numbering, `flow.status` mapping, directory naming, duplicated/conflicting ACs, resource ownership) | — | — | 3 (INFO) + 1 (WARN) |
| Package cleanliness (stray markup, doc-language convention) | 30 files | 20 | 2 (WARN) |

---

## XP1–XP5 opt-in policy — preserved by every block (PASS)

| Block | `dependencies` empty / new libs `optionalDependencies` + lazy import (XP1/C0-1/C0-2) | Opt-in graceful no-op / deterministic fallback (XP2/C0-4/C0-5) | Assets never bundled / auto-downloaded (XP3/A-5/A-7/C0-12) | Byte-identical floor (C0-7) | stdio-first (XP5) |
|-------|---|---|---|---|---|
| **0** | Delivers the mechanism: empty `dependencies`, `optionalDependencies` policy, lint against top-level optional imports (AC0-1/AC0-2) | Delivers `resolveCapability→Adapter\|null`, warn-once/exit-0, adapters-never-throw (AC0-4..AC0-9) | Delivers Asset Resolver + `assets pull` sole network path + committed `assets.lock.json`; no `postinstall` (AC0-13..AC0-18) | AC0-22 golden-rule gate | Defines the seam MCP plugs into; notes XP5 owned by A |
| **A** | MCP SDK `optionalDependency`, lazy `await import()` in `server.ts` only (AC9) | Manifest-off ⇒ unchanged; **sanctioned exception**: `mcp serve` MAY hard-require SDK (documented in arch §4.1, Block-0 §7, A README/prd/spec §9) | SDK opt-in; no bundling | AC9 | **stdio default, no listening socket**; HTTP a separate `--http` opt-in (AC8) |
| **B** | `web-tree-sitter` `optionalDependency`, lazy in adapter (AC1.5) | Grammars absent ⇒ **byte-identical regex fallback** (AC4.*); PageRank/affected dep-free | Grammars XP3 via Asset Resolver; no `postinstall` (AC1.6, US-B103) | AC4.1/AC4.5 | n/a (no transport) |
| **C** | Embedding runtime `optionalDependency`, lazy in `embedding/adapter.ts` (US-C102) | Index off ⇒ byte-identical lexical (AC-C1); warn-once fallback (AC-C4) | Model XP3 via Asset Resolver; index derived/disposable, Markdown authoritative (AC-C3/AC-C11) | AC-C0 | C4 rides A's **stdio-first** surface (US-C401) |
| **D** | **No optional dependency** (pure git + coverage parse); Asset Resolver not used (spec §2) | Coverage-map absent ⇒ byte-identical static selection (AC11); empty smoke ⇒ no-op (AC14) | Coverage map is a local derived artifact, never downloaded | AC15 | n/a (no transport) |
| **E** | Prompt Guard 2 / NER `optionalDependency` on the shipped `backends` seam, lazy in adapter (AC0.2) | Backends off ⇒ byte-identical regex/checksum (AC0.1/AC1.1); warn-once fallback (AC1.3) | Models XP3, never bundled (AC0.2, E-11); no `postinstall` | AC0.1 | E3 rides A's surface; no transport of its own |

All six blocks correctly treat the deterministic path as the tested floor and the
model/embedding/network layer as an opt-in ceiling. **No violation.**

---

## Cross-block dependency graph — coherent DAG (PASS)

```
                 ┌───────────────────────────┐
                 │ Block 0 — Capability Seam  │  (no deps; build FIRST)
                 └──────────────┬────────────┘
        ┌───────────────┬───────┴───────┬───────────────┬───────────────┐
        ▼               ▼               ▼               ▼               ▼
   ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ A (MCP) │    │ B (graph)│    │ D (health│    │ E: E1/E2/│    │ C: C1/C2/│
   │ owns E3 │    │  0 only  │    │ +testing)│    │ E4/E5/E6 │    │ C3 (0)   │
   └────┬────┘    └──────────┘    │  0 only  │    │  0 only  │    └──────────┘
        │                          └──────────┘    └──────────┘
        ├────────────► C4 (needs A)
        └────────────► E3 (ships WITH A; E cross-references only)
```

- **Every block depends on Block 0** — verified in each README + tasks (B0/T0 prerequisite). Block 0 depends on nothing. ✓
- **A owns E3** — `security scan-mcp` + `redactRaw` tool-output routing are specified and gated in **Block A** (A tasks T7/T8/T9 = E3 sub-block; A spec §8; A AC4/AC5). Block E cross-references E3 and **adds no code** (E README item E3 "specified in Block A — referenced only", E prd US-E9 REFERENCE, E spec §11, E AC3.1 REFERENCE, E tasks T25 docs-only). No duplication of the acceptance gate. ✓
- **C4 depends on A** — C README/prd/spec/tasks put C4 (`wiki ask` + MCP Resources/Tools) in Phase 3, dependent on Block A's `src/mcp/` surface. ✓
- **B, D, and E's non-model items are independent of A** and need only Block 0 (matches architecture §7 ordering rule 3). ✓
- **No circular dependencies.** A reuses the *already-shipped* `security/guard.ts:redactRaw` seam (not Block E's new code), so A does not depend on E; E depends on A only for the E3 reference. DAG confirmed. ✓

---

## WARNINGS

### W-001: Capability-manifest representation is not yet unified across blocks
- **Check**: Architecture ↔ block internal consistency (Block 0 §4 `capability-entry.schema.json`).
- **Found in**: Block 0 spec §4 defines the enriched entry as an **array of objects** with a
  required `id` matching `^[a-z0-9-]+\.[a-z0-9-]+$` (dotted, e.g. `gdgraph.treesitter`), plus a
  documented bare-string back-compat form. The blocks instantiate it four different ways:
  - **B** manifest uses `capabilities: [{ "name": "treesitter", "enabled": false }]` — field is `name` (not `id`) and value is the short `treesitter` (not dotted). Under Block 0's `additionalProperties:false` schema requiring `id`, this object form would not validate as-is.
  - **A** manifest uses an **object map** `capabilities: { "http": { "enabled": false } }` — neither the array-of-objects nor the bare-string form. A also calls `resolveCapability(cwd, "mcp")` with a non-dotted id.
  - **C / D / E** use **bare-string arrays** (`["embedding"]`, `["coverageMap"]`, `["injectionModel","piiNer"]`) — allowed by Block 0's back-compat clause, but short (non-dotted) names.
  - **B / C / E** call `resolveCapability` with **dotted** ids (`gdgraph.treesitter`, `memory.embedding`, `security.injectionModel`), while **A** uses the bare `mcp`.
- **Details**: The intent is consistent (a `metaproject.json` capability toggle, mirroring `isSecurityEnabled`), but the *field name* (`id` vs `name`), the *value form* (dotted `module.cap` vs short `cap`), and A's *container shape* (map vs array) diverge from Block 0's declared schema. Block 0's own OQ-2 leaves the shape "open," which is why this is not a blocking contradiction — but if implemented literally the blocks would parse differently.
- **Suggested fix**: In Block 0's T12 (`extractCapabilities`), make the reader accept all observed forms — bare string, `{name}`, `{id}`, and A's key→object map — OR pin one canonical shape and have A/B conform. Recommend Block 0 own the reconciliation so A–E stay uniform.
- **Fix target**: Block 0 (spec §4 + tasks T12); light touch to A/B manifests if a single shape is chosen.

### W-002: Leaked generation markup (`</content>` / `</invoke>`) in all files of Blocks A and D
- **Check**: Package completeness / cleanliness.
- **Found in**: All 5 files of `A-interop-mcp/` and all 5 files of `D-quality-signals/` end with stray `</content>` (and A's/D's READMEs also `</invoke>`) closing tags — a leaked tool-call artifact from generation. Blocks 0, B, C, E are clean.
- **Details**: Cosmetic only; content is complete and correct. But committed docs should not carry stray XML.
- **Suggested fix**: Delete the trailing `</content>` / `</invoke>` lines from the 10 affected files.
- **Fix target**: Blocks A and D (docs pass; can be folded into A-T14 / D-T16 docs tasks).

### W-003: DOC-4 doc-language convention deviated by B (gdgraph) and D (health) — self-flagged
- **Check**: Best Practices ↔ block docs (DOC-4 `[conv]`).
- **Found in**: `tech-bestpractices.md` DOC-4 says new docs SHOULD follow the extended module's language (**RU for gdgraph/health**, EN for security/standard). Block **B** (extends `gdgraph`) and Block **D** (extends `health`) are written in **EN**. Both blocks explicitly flag this (B README "Concern (naming)"/Identity note; D README language note).
- **Details**: DOC-4 is a SHOULD/`[conv]`, not a hard MUST, so this is non-blocking; the deviation is deliberate and disclosed (the 2026 roadmap package is uniformly EN).
- **Suggested fix**: Either accept EN package-wide (recommended — uniformity across the 6 blocks) and note the DOC-4 exception in the top-level README, or translate B/D. Decide once, centrally.
- **Fix target**: Roadmap owner (a one-line policy note), or B/D docs.

### W-004: Minor MCP resource/tool registration overlap between A and C4
- **Check**: Internal consistency (duplicated ownership).
- **Found in**: Block A already exposes `memory` + `wiki` as read-only Resources (A US-A102, spec §7) and lists `memory.search` + `wiki.query` Tools (spec §6). Block C4 also states it "Register[s] `memory` + `wiki` as MCP Resources" and "register `wiki.ask` (and `memory.search`) as thin MCP Tools" (C spec §3, tasks T21/T22).
- **Details**: Intent is coherent — C4 is meant to **ride A's** `src/mcp/resources.ts`/`tools.ts` (C US-C401 says "through Block A's `src/mcp/resources.ts`"). But the task wording risks double-registration of the wiki/memory Resources and `memory.search` Tool.
- **Suggested fix**: Treat A as the **owner** of the Resource registry and the `memory.search`/`wiki.query` Tools; C4's net-new contribution is only the `wiki.ask` Tool (and any wiki/memory rerank). Reword C-T21/T22 to "consume/extend A's registry," not "register."
- **Fix target**: Block C (tasks T21/T22 wording); no architectural change.

---

## INFO

- **I-001 — E4/E5 item labels are transposed vs the problem-statement E-numbering (documented, self-consistent).** Block E's local item **E4** = checksum PII (= problem-statement **G-E5/P-E5**) and item **E5** = multi-runtime hooks (= problem-statement **G-E4/P-E4**). Block E's README carries an explicit "Numbering note (for the consistency-checker)" disclosing the swap, and **all functional references throughout E cite the unambiguous goal (`G-E*`) and constraint (`E-*`) IDs**, which are consistent (E prd traceability matrix maps US-E5→G-E5, US-E7→G-E4 correctly). No contradiction — the transposition is confined to the block-local item labels and is fully reconciled.
- **I-002 — `flow.status` maps to `list`/`get` (documented open question).** There is no literal `createFlowService().status` method; A maps the `flow.status` Tool to the read-only `list`/`get` methods, flagged consistently in A prd Open Q#2, spec §6 table note, and spec Open Q#2. Read-only, gate-preserving (NG-A4/M-10 honored). A design decision for review, not an inconsistency.
- **I-003 — Directory-naming open questions in B, C, D are STALE and already resolved.** B/C/D docs flag that the roadmap listed `B-gdgraph/`, `C-memory-wiki/`, `D-health-testing/`. The **current top-level `README.md` already uses the correct descriptive names** (`B-code-understanding/`, `C-memory-knowledge/`, `D-quality-signals/`) and **all six links resolve to existing directories** (verified). **No README fix is required.** The three blocks' directory-naming open questions can simply be closed.
- **I-004 — "five blocks A–E" (problem-statement) vs "six blocks 0 + A–E" (package).** The problem-statement predates the architecture phase, which introduced **Block 0 — Capability Seam** (architecture §7) as the central "decide the dep policy once" foundation. The roadmap README correctly reflects all six. Consistent evolution, not a contradiction.
- **I-005 — Package file set (README/prd/specification/acceptance-criteria/tasks) deviates from DOC-1's example list (…/brainstorm/implementation-plan).** DOC-1 is `[conv]`; all six blocks adopt the same five-file layout uniformly and each updates the roadmap, satisfying the substance. Uniform, non-blocking.
- **I-006 — D's OQ-2 (additive-schema bump vs C0-7) is compatible.** C0-7 requires byte-identical *behavior* (score/gate/selection values, no new dep, no socket). D keeps numeric score/gate/selection values unchanged at default config and adds only nullable fields behind a `schemaVersion` bump, with `hotspot-findings` emission default-off (D AC5/AC15). This satisfies C0-7 provided existing golden-JSON tests are updated **only for the additive fields, not for values**. Confirmed compatible.
- **I-007 — Block-runnability snippet missing from B and C READMEs.** Blocks 0, A, D, E include an explicit `gd-metapro flow init/freeze/start/…/complete` command block; B and C READMEs omit the snippet but still satisfy the substance of a `flow`-runnable unit (self-contained scope + own `acceptance-criteria.md` + `tasks.md`). Cosmetic uniformity gap; adding the snippet to B/C would make the six READMEs symmetric.

---

## Audit trail — what was checked, per block

| Block | XP1–XP5 | Deps coherent | 5-file package | flow-runnable (scope+ACs+tasks) | Result |
|-------|:---:|:---:|:---:|:---:|--------|
| 0 Capability Seam | ✓ (delivers mechanism) | ✓ (no deps) | ✓ | ✓ (explicit snippet) | PASS |
| A Interop/MCP | ✓ (stdio-first; sanctioned SDK exception) | ✓ (→0; owns E3) | ✓ | ✓ (explicit snippet) | PASS (W-002, W-004) |
| B Code Understanding | ✓ (regex fallback byte-identical) | ✓ (→0) | ✓ | ✓ (scope+ACs+tasks) | PASS (W-003, I-007) |
| C Memory/Knowledge | ✓ (Markdown authoritative; index disposable) | ✓ (→0; C4→A) | ✓ | ✓ (scope+ACs+tasks) | PASS (W-004, I-007) |
| D Quality Signals | ✓ (no optional dep; static fallback) | ✓ (→0) | ✓ | ✓ (explicit snippet) | PASS (W-002, W-003) |
| E Security Hardening | ✓ (backends seam; regex/checksum floor) | ✓ (→0; E3 ref→A) | ✓ | ✓ (explicit snippet) | PASS (I-001) |

## Rollback recommendations

None. Zero CRITICAL violations — no phase rollback is warranted. The four WARNINGS are
localized documentation/implementation-hygiene fixes (W-001 in Block 0's capability reader;
W-002 a mechanical tag cleanup in A and D; W-003 a one-line language-policy note; W-004 a
task-wording clarification in C). They can be resolved in-place during each block's own docs
task without re-running any upstream pipeline phase.
