# Roadmap 2026 — gd-metapro Extension Package (Blocks 0 + A–E)

Version: 1.0.0
Status: spec in progress

This roadmap formalizes the 2026 functional-review recommendations into **six discrete
blocks** layered on top of — never replacing — the deterministic, local, offline,
git-diffable, zero-runtime-dependency core of gd-metapro. Every model / embedding /
network / precision feature is an **opt-in ceiling**; the deterministic core is the
**floor** and stays byte-identical when nothing is opted in.

Source artifacts (job): `problem-statement.md`, `architecture.md`, `tech-bestpractices.md`.

## Blocks & Dependency Order

| Order | Block | Directory | Depends on | Summary |
|-------|-------|-----------|------------|---------|
| 1 | **00 — Capability Seam** | [`00-capability-seam/`](00-capability-seam/) | — | The uniform opt-in substrate: `resolveCapability(id) → Adapter \| null`, `optionalDependencies` + lazy import, deterministic fallback as a tested path, the Asset Resolver (`assets.lock.json` + `assets pull/list/verify`), and the fixture-corpora acceptance harness + FN-rate gate. Ships **no** end-user feature — every block below instantiates it. |
| 2 | **A — Interop / MCP** | [`A-interop-mcp/`](A-interop-mcp/) | Block 0 | `gd-metapro mcp` stdio-first server; Tools = thin adapters over `createXService()`; Resources = read-only artifacts; `llms.txt` + gdskills plugin export; reposition the Standard as a generator. |
| 3 | **B — Code Understanding (`gdgraph`)** | [`B-code-understanding/`](B-code-understanding/) | Block 0 | Opt-in tree-sitter symbol graph (regex fallback), N-hop transitive `affected`, pure PageRank token-budgeted `repomap.md`. |
| 4 | **C — Memory / Knowledge** | [`C-memory-knowledge/`](C-memory-knowledge/) | Block 0, A (for C4) | Opt-in local embedding index, bitemporal Markdown fact model, memory typing, gdwiki Q&A over the MCP surface. |
| 5 | **D — Quality Signals** | [`D-quality-signals/`](D-quality-signals/) | Block 0 | Git-churn × complexity hotspot signal, dynamic coverage-map TIA (static fallback), always-on smoke tier. Dep-free. |
| 6 | **E — Security Hardening** | [`E-security-hardening/`](E-security-hardening/) | Block 0, A (for E3) | Semantic injection detection (Prompt Guard 2 on `backends` seam), modern exfil coverage, `security scan-mcp`, broadened hooks, checksum PII + optional NER, red-team eval harness. |

## Ordering Rules (from architecture §7)

1. **Block 0 first.** The seam + Asset Resolver + `optionalDependencies` policy + fixture
   harness are decided once, centrally. B, C, D, E all instantiate this seam; none may
   land before it.
2. **A before E3 and C4** — both couple to the MCP surface; E3 ships *with* A1
   (tool output is untrusted from day one).
3. **B, D, and E's non-model items** are independent of A and may proceed in parallel
   once Block 0 exists.

## Cross-Cutting Golden Rule

With zero opt-in flags set and no assets present, the full existing test suite and every
deterministic command behave **byte-identically** to today: no new dependency loaded, no
socket opened. This is the package-wide acceptance gate (`C0-7`).
