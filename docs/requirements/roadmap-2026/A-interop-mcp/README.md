# Block A — Interop & Adoption (MCP)

**Status:** Draft / ready-for-implementation
**Version:** 1.0.0
**Date:** 2026-07-07
**Mode:** `task_in_project` — extends the existing gd-metapro; does NOT re-spec shipped modules.
**Language:** English (per DOC-4: the MCP/security/standard surface is EN).

---

## Purpose

Block A makes the gd-metapro workspace **consumable by the coding agents everyone
already uses** (Cursor, Claude Code, Copilot, Codex, Devin) by shipping a
cross-cutting `src/mcp/` package that speaks the **Model Context Protocol**:

- `gd-metapro mcp serve` — a **stdio-first** JSON-RPC MCP server (HTTP/SSE behind
  `--http`, a second opt-in) that exposes existing module services as MCP **Tools**
  (thin adapters over `createXService()` facades) and generated artifacts
  (`data/*/artifacts`, `wiki`, `memory`) as read-only MCP **Resources**.
- **E3 = `security scan-mcp`** — a deterministic detector over MCP tool manifests
  (tool-poisoning / line-jumping / rug-pull) plus routing all MCP tool output
  through the existing `redactRaw` seam. **E3 ships WITH A** (untrusted-from-day-one).
- **Portable-artifact emit** — `llms.txt`, a gdskills plugin/marketplace export,
  and repositioning the "Metaproject Standard" (doc-only) as a **generator** of the
  three LF-consolidated artifacts (AGENTS.md + Agent Skills + an MCP server).

This is a **thin protocol adapter** over existing in-process service contracts. It
adds no new logic to any module. With `modules.mcp.enabled=false` (the default),
nothing changes and no SDK loads.

## Scope at a glance

| In scope | Out of scope (see `prd.md` Non-Goals) |
|----------|----------------------------------------|
| `src/mcp/` package; stdio transport; Tools registry over `createXService()`; read-only Resources; manifest-driven discovery | Hosted/multi-tenant MCP service; default HTTP listener (NG-A1) |
| `security scan-mcp` detector + `redactRaw` routing of tool output (E3) | Auth / identity / multi-tenant layer (NG-A3) |
| `llms.txt` emit; gdskills plugin/marketplace export; Standard-as-generator docs | New public interop standard (NG-A2); mutating tools that bypass gates (NG-A4) |
| `mcp serve --http` as a **separate** opt-in behind its own flag | HTTP delivered by the base MCP goal |

## Dependency on Block 0 (hard)

Block A **cannot start** until **Block 0** (foundational, build-first) lands:

- **Capability Seam** — `resolveCapability(cwd, name) → Adapter | null` and the four
  coordinated parts (init flag + manifest entry + config toggle + fallback contract).
  A's `mcp` capability, the `--http` capability, and E3's detectors all instantiate it.
- **`optionalDependencies` policy** in `package.json` (empty `dependencies`) — the MCP
  SDK lands here as an `optionalDependency`, lazy-loaded only inside the server.
- **Asset Resolver + `assets.lock.json`** — not directly used by A's core, but the
  install-time contract A relies on for the SDK opt-in.
- **Fixture-corpus harness convention** — E3's `mcp-threat` corpus plugs into it.

**Sanctioned XP2 exception (restated):** every other opt-in feature must
gracefully no-op when its dep is absent. `mcp serve` MAY **hard-require** the MCP
SDK and exit with an actionable error when it is missing, because the user
*explicitly invoked a server*. This is the ONE opt-in command allowed to hard-fail
on a missing dep. The default path (server not invoked) still loads no SDK.

## How to run (via flow)

Block A is implemented as a managed gd-metapro flow. Task breakdown is in
[`tasks.md`](./tasks.md); acceptance gates are in
[`acceptance-criteria.md`](./acceptance-criteria.md).

```bash
# 1. Ensure Block 0 is complete (capability seam + optionalDeps policy present).
# 2. Open the managed flow for this block:
gd-metapro flow init --title "Block A — Interop & Adoption (MCP)" \
  --spec docs/requirements/roadmap-2026/A-interop-mcp

# 3. Work tasks T1..Tn (tasks.md); each maps to flow tasks with AC.
gd-metapro flow task add <id> --title "T1: src/mcp scaffold + capability wiring"
# ... implement, then confirm ACs, attach PR, pass health gate:
gd-metapro flow complete <id>

# 4. Demo the surface (opt-in SDK must be installed for these to run):
gd-metapro mcp serve            # stdio JSON-RPC MCP server
gd-metapro security scan-mcp    # E3 detector over MCP tool manifests
gd-metapro standard emit llms   # emit llms.txt
gd-metapro skills export <s> --runtime plugin   # marketplace/plugin package
```

## Links

- [`prd.md`](./prd.md) — problems, goals, metrics, non-goals, user stories.
- [`specification.md`](./specification.md) — Tool↔service registry table, Resource
  URI scheme, transports, `scan-mcp` detector spec, generators.
- [`acceptance-criteria.md`](./acceptance-criteria.md) — hard AC1..ACn.
- [`tasks.md`](./tasks.md) — atomic T1..Tn with kinds and dependencies (incl. Block 0).
- Upstream artifacts: `problem-statement.md` (Group A), `architecture.md`
  (§4 MCP surface, §4.3 E3 coupling), `tech-bestpractices.md` (§2 MCP constraints).
- Existing seams reused: `src/security/guard.ts:redactRaw`, `createSecurityService()`,
  `createMemoryService()`, `createCodeHealthService()`, `createFlowService()`,
  `createGdWikiService()`, `src/gdgraph/query.ts`, `src/standard/service.ts`,
  `.metaproject/metaproject.json`.
