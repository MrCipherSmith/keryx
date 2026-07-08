# Consolidated Roadmap — gd-metapro Extension Package (Blocks 0 + A–E)

Version: 1.0.0 · Date: 2026-07-07
Consistency verdict: **PASS_WITH_WARNINGS** (0 CRITICAL — see `consistency-report.md`).
Source artifacts: `problem-statement.md`, `architecture.md`, `tech-bestpractices.md`.

This roadmap consolidates six discrete, independently `flow`-runnable blocks that layer an
opt-in model/precision/network **ceiling** onto — never replacing — the deterministic,
local, offline, zero-runtime-dependency **floor** of gd-metapro. With zero opt-in flags set
and no assets present, every deterministic command and the full existing test suite behave
**byte-identically** to today (the package-wide `C0-7` gate).

---

## 1. Block table

| # | Block | Directory | Status | Depends on | Independent or sequenced | One-line scope |
|---|-------|-----------|--------|------------|--------------------------|----------------|
| 0 | **Capability Seam (Foundation)** | [`00-capability-seam/`](00-capability-seam/) | spec ready | — | **Sequenced first** (gates all) | `resolveCapability→Adapter\|null`, `optionalDependencies`+lazy import, Asset Resolver (`assets.lock.json` + `assets pull/list/verify`), fixture-corpora harness + FN-rate gate. Ships no end-user feature. |
| A | **Interop / MCP** | [`A-interop-mcp/`](A-interop-mcp/) | ready-for-impl | Block 0 | Sequenced (unblocks C4, E3) | `gd-metapro mcp` stdio-first server; Tools = thin adapters over `createXService()`; read-only Resources; **owns E3** (`security scan-mcp` + `redactRaw` routing); `llms.txt`, gdskills export, Standard-as-generator. |
| B | **Code Understanding (`gdgraph`)** | [`B-code-understanding/`](B-code-understanding/) | spec ready | Block 0 | **Independent** (parallel after 0) | Opt-in tree-sitter symbol graph (regex fallback); pure N-hop transitive `affected`; pure PageRank token-budgeted `repomap.md`. |
| C | **Memory / Knowledge** | [`C-memory-knowledge/`](C-memory-knowledge/) | spec (flow-runnable) | Block 0; **A (C4 only)** | Partly independent (C1/C2/C3); C4 sequenced after A | Opt-in local embedding index; bitemporal Markdown fact model; procedural memory typing + injection; `wiki ask` / MCP endpoint (C4). |
| D | **Quality Signals (`health`+`testing`)** | [`D-quality-signals/`](D-quality-signals/) | ready-for-impl | Block 0 | **Independent** (parallel after 0) | Git-churn × complexity hotspot (D1, dep-free early win); coverage-map TIA with static fallback (D2); always-on smoke tier (D3). No runtime dep. |
| E | **Security Hardening (`security`)** | [`E-security-hardening/`](E-security-hardening/) | ✅ landed | Block 0; **A (E3 only)** | Mostly independent; E3 ships with A | Semantic injection (Prompt Guard 2 on `backends` seam); modern exfil coverage; checksum PII + optional NER; multi-runtime hooks; red-team FN-rate eval harness. E3 = cross-reference to A. |

> **E numbering note:** Block E's local item labels **E4** (checksum PII) and **E5**
> (multi-runtime hooks) are transposed relative to the problem-statement's **G-E5**/**G-E4**;
> this is disclosed in E's README and every functional reference uses the unambiguous
> `G-E*`/`E-*` IDs (see `consistency-report.md` I-001).

---

## 2. Dependency graph

```
                        ┌────────────────────────────────┐
                        │  BLOCK 0 — Capability Seam       │   build FIRST, once, centrally
                        │  seam · optionalDeps · assets ·  │   (no deps)
                        │  fixture-corpora harness         │
                        └───────────────┬─────────────────┘
        ┌───────────────┬───────────────┼───────────────┬─────────────────────┐
        ▼               ▼               ▼               ▼                     ▼
  ┌──────────┐   ┌────────────┐   ┌────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │  A: MCP  │   │ B: gdgraph │   │ D: health  │  │ E (deterministic): │  │ C (dep-free):    │
  │ (stdio)  │   │  ts+PR+    │   │  +testing  │  │ E2 exfil · E4-chk  │  │ C1 idx · C2 temp │
  │ owns E3  │   │ transitive │   │ (no dep)   │  │ PII · E5 hooks ·   │  │ · C3 typing/inj  │
  └────┬─────┘   └────────────┘   └────────────┘  │ E6 eval harness    │  └──────────────────┘
       │           INDEPENDENT      INDEPENDENT   │ + E1/E4-NER models │     INDEPENDENT
       │                                          └──────────────────┘   (C1 uses asset seam)
       ├──────────────► C4  (wiki ask + MCP Resources/Tools — needs A)
       └──────────────► E3  (scan-mcp + redactRaw routing — ships WITH A;
                              Block E cross-references, adds no code)
```

**Rules (from architecture §7), preserved by the specs:**
1. **Block 0 first** — the seam, Asset Resolver, `optionalDependencies` policy, and fixture
   harness are decided once, centrally. No block below may land until Block 0's golden-rule
   gate (`AC0-22`) is green.
2. **A before E3 and C4** — both couple to the MCP surface; **E3 ships *with* A1** (tool
   output is untrusted from the first commit).
3. **B, D, and E's non-model items are independent of A** and may proceed in parallel once
   Block 0 exists.
4. Within B: PageRank + transitive `affected` (dep-free) land before the tree-sitter asset path.
5. Within E: the deterministic items land before the opt-in models (both need only Block 0).

**No circular dependencies** — the graph is a DAG (A reuses the *already-shipped* `redactRaw`
seam, so A does not depend on Block E).

---

## 3. Suggested sequencing (with low-risk early wins called out)

### Wave 0 — Foundation (sequential, gates everything)
- **Block 0 — Capability Seam.** One-time central substrate. Exit gate: `AC0-22`
  (byte-identical golden rule) + `AC0-24` (no-network sandbox) green.

### Wave 1 — Deterministic early wins (launch in parallel the moment Block 0 lands)
These add value with **no optional dependency and no asset path** — lowest integration risk:
- **B2 + B3** — transitive `affected` (`--depth N`) and PageRank `repomap.md`. Pure
  algorithms; ship before any grammar-asset work (`B-9`).
- **D1** — git-churn × complexity hotspot signal. Pure reuse of `getChurn` + complexity;
  **D1 does not even require Block 0** (no capability, no asset) and can start immediately.
- **E2 / E4-checksum / E5 / E6** — modern exfil coverage, checksum PII validators,
  multi-runtime hooks, and the red-team FN-rate eval harness. All deterministic and
  network-free; need only Block 0's fixture-harness convention. **E6 generalizes the harness
  that Block 0 already ships**, so it is a fast follow.
- **A (MCP core)** — the biggest unlock-per-effort (review Tier 1). Sequenced early because
  it unblocks C4 and E3. Ships **with E3** from the first commit (`M-5`).

### Wave 2 — Opt-in models & asset-backed capabilities (after Block 0's Asset Resolver)
- **B1** — tree-sitter symbol graph (`web-tree-sitter` optionalDependency + WASM grammars).
- **C1** — local embedding index for memory (embedding runtime + model asset).
- **E1 / E4-NER** — Prompt Guard 2 injection model + optional NER, both on the *pre-existing*
  `backends` seam (lowest model-integration risk).
- **C2 / C3** — bitemporal fact model + procedural typing/injection (dep-free; may also land in Wave 1).

### Wave 3 — MCP-dependent capabilities (after A)
- **C4** — `wiki ask` + wiki/memory MCP Resources/Tools, riding A's stdio surface.
- **A HTTP opt-in (US-A104/T13)** — the second, separately-flagged `--http` transport.

### Wave 4 — Close-out
- Standard-as-generator repositioning (A, doc-only), per-block roadmap cross-links, and the
  package-wide no-network + golden-rule acceptance runs.

**Critical path:** `Block 0 → A (core + E3) → C4`. B, D, and E's deterministic items run
fully in parallel off Block 0 and are not on the critical path.

---

## 4. Every block is a discrete, `flow`-runnable unit

Each block is executed as a normal gd-metapro managed flow driven by the deterministic gates
in `src/commands/flow.ts` — a self-contained scope, its own committed acceptance criteria
(`acceptance-criteria.md`), and its own atomic task decomposition (`tasks.md`):

```bash
gd-metapro flow init     roadmap-2026/<block-dir>
gd-metapro flow freeze   <flow-id>          # pins the AC set
gd-metapro flow start    <flow-id>
gd-metapro flow task     <flow-id> <task-id>
gd-metapro flow ac       <flow-id> <ac-id>  # tick an AC as it passes
gd-metapro flow check    <flow-id>          # deterministic gate (ACs + PR + health)
gd-metapro flow complete <flow-id>          # only succeeds when all gates pass
```

`flow complete` is gated on the AC set, a PR link, and the health gate — the deterministic
gate contract is preserved for every block. Each block additionally names its **labeled
fixture corpus** as its capability-acceptance gate (Block 0 ships the harness; Blocks A–E each
add their corpus): `mcp-threat` (A/E3), `symbol-graph`/`transitive-closure`/`repomap` (B),
`paraphrase`/`temporal` (C), `churn-complexity`/`change-impacted-test` (D),
`injection`/`exfil`/`structured-pii`/`secret` + `thresholds.json` (E).

---

## 5. Package-wide golden rule (the acceptance floor for every block)

With zero opt-in flags set and no assets present, the full existing test suite and every
deterministic command behave **byte-identically** to today: no new dependency loaded, no
socket opened (`C0-7` / `AC0-22`). This is the non-negotiable gate that binds all six blocks.
