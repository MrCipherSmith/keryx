# Tasks: Block A — Interop & Adoption (MCP)

Version: 1.0.0 · Date: 2026-07-07

Atomic tasks T1..T14. `kind` ∈ {scaffold, feature, adapter, detector, generator,
test, docs}. Dependencies are explicit and include **Block 0**. E3 sub-block =
{T7, T8, T9} — it **ships WITH A** (untrusted-from-day-one), not after.

Legend: **B0** = Block 0 (capability seam + `optionalDependencies` policy + asset
resolver + fixture-corpus harness convention) — a hard prerequisite for A.

---

| ID | Task | Kind | Depends on | AC / traces |
|----|------|------|-----------|-------------|
| **T0** | (external) Block 0 complete: `resolveCapability`, `optionalDependencies` policy (empty `dependencies`), asset resolver, fixture-corpus harness convention | prereq | — | C0-1..C0-9 |
| **T1** | Scaffold `src/mcp/` package (`server.ts`, `tools.ts`, `resources.ts`, `config.ts`, `discovery.ts`, `redact-seam.ts`, `transport/stdio.ts`); add `commands/mcp.ts`; register `mcp` route in `cli.ts`. Declare MCP SDK under `optionalDependencies`; lazy `await import()` only in `server.ts` | scaffold | T0 | AC1, AC9; M-3, M-6, C0-2 |
| **T2** | Manifest + config wiring: add `modules.mcp` (default `enabled:false`) via `init` (`--mcp`/`--no-mcp`); `loadMcpConfig` deep-merge over defaults, fallback on bad JSON; `discovery.ts` filters disabled modules | feature | T1 | AC3; C0-3, C0-8, C0-9, M-7, M-11 |
| **T3** | Tool registry (`tools.ts`): thin adapters mapping each MCP Tool → one `createXService()` method per specification §6 (`gdgraph.affected/cycles/orphans`, `security.check/scan`, `flow.status`(read-only), `memory.search`, `health.gate/status`, `wiki.query`, `standard.validate`). No new module logic | adapter | T1, T2 | AC1; M-2, M-3, M-10, NG-A4 |
| **T4** | Resource registry (`resources.ts`): `metaproject://<class>/<relpath>` scheme over `data/*/artifacts`, `wiki`, `memory`; read-only; path-confinement | adapter | T1, T2 | AC2; M-4 |
| **T5** | stdio JSON-RPC server loop (`server.ts` + `transport/stdio.ts`): initialize handshake, `tools/list`/`tools/call`, `resources/list`/`resources/read`; no listening socket; sanctioned hard-fail on missing SDK | feature | T3, T4 | AC1, AC2, AC8, AC10; M-1 |
| **T6** | Round-trip test (T-2) + per-method in-process unit tests (T-1) + import-boundary lint (M-3) + no-network sandbox test (T-4) | test | T5 | AC1, AC2, AC9; T-1, T-2, T-4 |
| **T7** *(E3)* | `redact-seam.ts`: route **every** Tool result through `security/guard.ts:redactRaw({source:"tool-output"})`; wire into `server.ts` from first commit; never throws | feature | T5 | AC4; M-5, C0-11 |
| **T8** *(E3)* | `security/detect/mcp.ts`: pure `scanMcpManifest(manifest) → DetectorMatch[]` (tool-poisoning / line-jumping / rug-pull incl. pinned-hash baseline); slot into `runDetectors`; add `security scan-mcp` command + `cli.ts` route; leak-safe findings | detector | T0 | AC5; E-3, E-9 |
| **T9** *(E3)* | Ship `fixtures/mcp-threat/` corpus (poisoning/line-jumping/rug-pull + benign controls); test asserting 100% flagged, no false positives, and tool output redaction-routed | test | T7, T8 | AC4, AC5; F-1..F-4 |
| **T10** | `llms.txt` generator (`standard/emit-llms.ts`) + `standard emit llms` command: pure text, deterministic, zero-dep; CI format validator | generator | T2 | AC6; C0-10, F-2 |
| **T11** | gdskills plugin/marketplace export: extend `gdskills/export` + `commands/skills.ts` with `--runtime plugin`; round-trip export→import test; AGENTS.md/SKILL.md schema-valid post-export | generator | T0 | AC7; DOC-1 |
| **T12** | `metaproject-standard/` cross-module package doc for the MCP surface (DOC-2), mirroring `security/` layout | docs | T5 | AC11; DOC-2 |
| **T13** | HTTP/SSE second opt-in: `transport/http-sse.ts` behind `mcp serve --http` + `capabilities.http.enabled`; isolated/removable; localhost only, no auth | feature | T5 | AC8; M-8, M-12, NG-A3 |
| **T14** | Standard-as-generator repositioning (doc-only): update `src/standard` README/spec + `metaproject-standard/` docs + `roadmap.md`; cross-link A1/A2; **no code** | docs | T10, T11 | AC11; NG-A2, DOC-1 |

---

## Execution order & parallelism

```
T0 (Block 0) ──► T1 ──► T2 ──► T3 ─┐
                          └► T4 ─┴► T5 ──► T6
                                     │
                        E3 sub-block │
                         T7 ─────────┤
              T8 (needs T0) ─────────┤
                         T9 (T7+T8) ─┘
   parallel after T2/T0:  T10, T11
   after T5:              T12, T13
   last:                  T14 (needs T10, T11)
```

- **E3 = {T7, T8, T9} ships WITH A** — T7 (redact routing) must land in the same
  cycle as T5; the MCP surface must never exist without redaction routing (M-5,
  architecture §4.3 "untrusted from day one").
- **T8** depends only on Block 0 (not on the server), so `scan-mcp` can be developed
  in parallel with the server; **T9** joins them.
- **T10/T11** (generators) are independent of the server and can run in parallel.
- **T13** (HTTP) is a *separate* opt-in and can be deferred without blocking A's core.
- **T14** is doc-only and lands last.

## Definition of Done (block)
- AC1..AC11 all green; `fixtures/mcp-threat/` corpus passes (F-1).
- C0-7 package-wide gate holds: `bun install --omit=optional` + `modules.mcp.enabled=false`
  ⇒ full existing suite byte-identical, no socket opened (AC9).
- `dependencies` empty; SDK only under `optionalDependencies`; no top-level SDK import.
- Flow completed via `gd-metapro flow complete` with health gate passed.
