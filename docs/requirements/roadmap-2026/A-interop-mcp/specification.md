# Specification: Block A — Interop & Adoption (MCP)

Version: 1.0.0 · Date: 2026-07-07 · Language: EN
Follows the observed `specification.md` section order (DOC-3), adapted for a
cross-cutting protocol package.

---

## 1. Purpose

Specify the `src/mcp/` package (stdio-first MCP server), its Tool↔service-method
registry, its read-only Resource URI scheme, its transports, the `security
scan-mcp` detector (E3), and the `llms.txt` / skills-export / Standard-generator
emits. This is a **thin protocol adapter**; it defines no new module logic.

## 2. Module Identity

| Field | Value |
|-------|-------|
| Package | `src/mcp/` (cross-cutting; peer of `src/standard/`, `src/security/`) |
| Command | `gd-metapro mcp serve` (alias `gd-metapro mcp`); `--http` for HTTP/SSE |
| E3 command | `gd-metapro security scan-mcp <manifest\|dir>` |
| Manifest key | `modules.mcp` in `.metaproject/metaproject.json` |
| Config file | `.metaproject/core/mcp/mcp.config.json` (deep-merged over defaults, C0-8) |
| Runtime dep | MCP TypeScript SDK — `optionalDependency`, lazy `await import()` only inside `server.ts` (M-6, C0-2) |
| Default | `enabled: false` — disabled ⇒ byte-identical to today, no SDK (M-7, C0-7) |

## 3. Structure

```
src/mcp/
  server.ts        # JSON-RPC loop; lazy-loads the SDK; wires transport + registries
  tools.ts         # Tool registry: MCP Tool name → createXService() method (§6)
  resources.ts     # Resource registry: URI scheme → read-only on-disk artifacts (§7)
  config.ts        # loadMcpConfig(cwd): deep-merge over defaults, fallback on bad JSON
  discovery.ts     # manifest-driven filtering (disabled module ⇒ hidden) (M-11)
  redact-seam.ts   # wraps every tool result via security/guard.ts:redactRaw (M-5)
  transport/
    stdio.ts       # default transport; no listening socket (M-1)
    http-sse.ts     # SECOND opt-in behind --http; fully removable (M-8, M-12)
  mcp.test.ts      # round-trip tests (T-2)

src/commands/
  mcp.ts           # thin handler: parses `serve`/`--http`, calls src/mcp/server.ts

src/security/
  detect/mcp.ts    # E3 detector: MCP manifest → DetectorMatch[] (pure) (E-3)

src/standard/
  emit-llms.ts     # llms.txt generator (pure text) (A2)
src/gdskills/
  export-plugin.ts # plugin/marketplace export (extends existing export) (A2)

fixtures/
  mcp-threat/      # E3 acceptance corpus (poisoning/line-jumping/rug-pull) (F-1)
```

**Dependency rule (M-3):** `src/mcp/` imports ONLY `createXService()` facades +
`src/lib/*` + `security/guard.ts` (the `redactRaw` seam). It MUST NOT import any
module's internals. This keeps it acyclic and thin (mirrors `security/guard.ts`).

## 4. Manifest Entry

`modules.mcp` added to `.metaproject/metaproject.json` by `gd-metapro init`
(Block-0 capability seam, four parts — C0-3):

```jsonc
"mcp": {
  "enabled": false,                 // (b) manifest entry; default OFF (M-7)
  "core": ".metaproject/core/mcp",
  "manifest": ".metaproject/modules/mcp.md",
  "commands": ["serve"],
  "capabilities": {
    "http": { "enabled": false }    // (c) HTTP is a SEPARATE opt-in (M-8, US-A104)
  },
  "expose": {                        // manifest-driven discovery (M-11, US-A103)
    "tools": true,
    "resources": true,
    "modules": ["gdgraph","security","flow","memory","health","wiki","standard"]
  }
}
```

- (a) init flag: `gd-metapro init --mcp` / `--no-mcp` (default OFF for the ceiling).
- (d) fallback contract: `resolveCapability(cwd,"mcp")` from Block 0 gates exposure;
  the server itself may hard-require the SDK (sanctioned exception, §9).

## 5. Config

`mcp.config.json` (deep-merged over defaults; malformed JSON ⇒ defaults, C0-8):

```jsonc
{
  "transport": "stdio",            // "stdio" (default) | "http" (only if capability on)
  "http": { "host": "127.0.0.1", "port": 0, "enabled": false },
  "tools":  { "include": ["*"], "exclude": [] },   // filter over the §6 registry
  "resources": { "roots": ["data", "wiki", "memory"] },
  "redactToolOutput": true          // MUST stay true; routes output via redactRaw (M-5)
}
```

## 6. Tool Registry — MCP Tool ↔ `createXService()` method (M-2)

Each Tool is a thin adapter: it (de)serializes JSON-RPC params ↔ the typed service
input/output and calls **exactly one** service method. No new logic (M-2, M-3). All
non-mutating unless the `Mutating` column says otherwise, and no mutating tool may
bypass a deterministic gate (M-10, NG-A4). **Every** result is routed through
`redactRaw` before transport (M-5).

| MCP Tool name | Service facade (file) | Method | Input → Output (typed) | Mutating | Notes |
|---------------|-----------------------|--------|------------------------|----------|-------|
| `gdgraph.affected` | `src/gdgraph/query.ts` | `getAffected(graph, file[, depth])` over `loadGraph(root)` | `{ file, depth? }` → affected file list | no | pure fn, not a `createXService`; adapter loads graph then calls fn |
| `gdgraph.cycles` | `src/gdgraph/query.ts` | `getCycles(graph)` | `{}` → `string[][]` | no | |
| `gdgraph.orphans` | `src/gdgraph/query.ts` | `getOrphans(graph)` | `{}` → `string[]` | no | |
| `security.check` | `createSecurityService(cwd)` | `check(input: SecurityCheck)` | `{ content, source? }` → `SecurityDecision` | no | never throws; returns pass on error |
| `security.scan` | `createSecurityService(cwd)` | `scan`/`runScan` | `{ path? }` → `{ decision, report }` | writes artifacts | writes committable report only; not a flow-gate bypass |
| `security.scan-mcp` | `src/security/detect/mcp.ts` (E3) | `scanMcpManifest(manifest)` | `{ manifest\|dir }` → `DetectorMatch[]` | no | E3 detector (§8) |
| `flow.status` | `createFlowService(deps)` | `list({cwd})` / `get({cwd,id})` | `{ id? }` → `FlowSummary[]` \| `FlowState` | no | read-only; see Open Q #2 (no literal `status` method) |
| `memory.search` | `createMemoryService()` | `search(input: MemorySearchInput)` | `{ query, cwd, k? }` → `MemorySearchResult` | no | deterministic search (Block C adds opt-in index) |
| `health.gate` | `createCodeHealthService()` | `gate(input: HealthGateInput)` | `{ cwd }` → `HealthGateResult` | no | reads latest health artifact |
| `health.status` | `createCodeHealthService()` | `status(input: HealthStatusInput)` | `{ cwd }` → `HealthStatusResult` | no | optional extra read tool |
| `wiki.query` | `createGdWikiService()` | `collect`/`validate`/`checkLinks` | `{ cwd, query? }` → wiki result | no | deterministic wiki over its own data; Block C4 layers Q&A on this |
| `standard.validate` | `src/standard/service.ts` | `runValidate(cwd)` | `{ cwd }` → `ValidationResult` | no | LF-standard validity |

**Registry entry shape** (`tools.ts`):
```ts
interface ToolEntry {
  name: string;                 // "gdgraph.affected"
  module: string;               // "gdgraph" — filtered by manifest (M-11)
  invoke(cwd: string, params: unknown): Promise<unknown>; // calls ONE service method
  inputSchema: JsonSchema;      // advertised in tools/list
  mutating: boolean;            // if true, MUST call a gate-preserving method (M-10)
}
```

**Non-exposure rule:** any module with `modules.<m>.enabled=false` in the manifest
is filtered out of `tools/list` (US-A103). Write/mutating flow transitions
(`complete`, `implemented`, …) are NOT exposed as tools in Block A (NG-A4);
`flow.status` exposes only read methods.

## 7. Resource URI Scheme (read-only, M-4)

`resources/list` enumerates on-disk generated artifacts; `resources/read` returns
raw file contents. No computation, no mutation.

```
Scheme:   metaproject://<class>/<relpath>
Classes:  artifacts | wiki | memory
Roots:    artifacts → .metaproject/data/<module>/artifacts/**
          wiki      → .metaproject/data/wiki/**   (or wiki module data root)
          memory    → .metaproject/data/memory/**
```

| Resource class | URI example | Backed by | Read-only |
|----------------|-------------|-----------|-----------|
| `artifacts` | `metaproject://artifacts/gdgraph/graph.json` | `data/*/artifacts` | yes |
| `wiki` | `metaproject://wiki/modules/gdgraph.md` | wiki module data | yes |
| `memory` | `metaproject://memory/lessons/2026-07.md` | memory store | yes |

- `resources.roots` in config bounds which classes are exposed (default all three).
- Path traversal outside a root is rejected (URIs are resolved and confined).
- ≥3 Resource classes satisfy G-A1's "≥3 artifact classes" target.

## 8. `security scan-mcp` Detector Spec (E3)

**Command:** `gd-metapro security scan-mcp <manifest.json | dir>`
**Implementation:** `src/security/detect/mcp.ts`, pure & network-free (E-3),
returning `DetectorMatch[]`, slotted into `runDetectors`. Findings are leak-safe
(masked; no raw manifest content in artifacts) (E-9).

**Detector signatures (over MCP tool manifests — tool descriptions + JSON schemas):**

| Threat | Signature (deterministic) | Fixture class |
|--------|---------------------------|---------------|
| **Tool-poisoning** | tool `description`/param docs contain hidden instruction-injection to the agent (imperative directives, "ignore previous", exfil verbs, embedded credentials/URLs, invisible/steganographic unicode, HTML/markdown comment payloads) | `fixtures/mcp-threat/poisoning/*` |
| **Line-jumping** | description content that attempts to alter the agent's handling of *other* tools/context before invocation (cross-tool instruction, priority-override phrasing, tool-shadowing names) | `fixtures/mcp-threat/line-jumping/*` |
| **Rug-pull** | manifest whose tool definition/schema/hash differs from a previously pinned baseline (definition drift after trust), or version/name reuse with changed behavior surface | `fixtures/mcp-threat/rug-pull/*` |

- **Rug-pull mechanism:** `scan-mcp` records a sha256 of each tool definition into a
  committed baseline (reusing the `assets.lock.json`/checksum convention from Block 0);
  a later scan whose hash diverges from the pinned baseline is flagged. Deterministic,
  git-diffable, network-free.
- **Redaction routing (M-5):** independently of `scan-mcp`, the *server* routes all
  tool **output** through `redactRaw` (`src/mcp/redact-seam.ts`). `scan-mcp` guards
  the manifest surface; `redactRaw` guards the runtime output surface. Both required.
- **Acceptance:** the `fixtures/mcp-threat/` corpus is the gate (F-1); every
  enumerated vector must be flagged; a test asserts tool output is redaction-routed.

## 9. Transports

| Transport | Flag | Default | Socket | Constraint |
|-----------|------|---------|--------|------------|
| **stdio** | (default) | yes | none | M-1: no listening socket on the default path |
| **HTTP/SSE** | `mcp serve --http` + `capabilities.http.enabled` | no | localhost listener | M-8: separate opt-in; M-12: isolated in `transport/http-sse.ts`, fully removable; NG-A3: no auth |

**Sanctioned XP2 exception (restated):** when `mcp serve` is invoked and the MCP SDK
is not installed, the command MAY **hard-fail** with an actionable error
(`install the MCP SDK / run assets`) rather than degrade — because the user
explicitly asked to run a server. This is the ONLY opt-in command permitted to
hard-require its dep. All *other* paths (server not invoked) still load no SDK and
behave byte-identically (M-7, C0-7). Documented in `README.md` and `prd.md`.

## 10. Generators (A2 / A3)

### 10.1 `llms.txt` (US-A301)
- `src/standard/emit-llms.ts`, invoked by `gd-metapro standard emit llms` (or folded
  into an existing standard emit path). Pure text over `metaproject.json` + artifact
  index. Zero dep (C0-10). Deterministic (re-run diff empty, F-2). CI format validator.

### 10.2 gdskills plugin/marketplace export (US-A302)
- Extends `src/gdskills/export` + `src/commands/skills.ts` (existing
  `skills export --runtime codex|claude`) with `--runtime plugin`, producing a
  plugin/marketplace package. Pure zip/text emit (C0-10). Round-trip export→import test.
- `AGENTS.md` + `SKILL.md` remain schema-valid post-export (G-A2 validators).

### 10.3 Standard-as-generator repositioning (US-A401, doc-only)
- Update `src/standard/` README/spec + `docs/requirements/metaproject-standard/`
  package + `roadmap.md` to frame gd-metapro as a **generator of the 3 LF-standard
  artifacts (AGENTS.md + Agent Skills + MCP server) + a value-add data layer** — NOT a
  rival standard (NG-A2). Cross-link to A1/A2. No code change (architecture §5).

## 11. Integration

- **CLI (`cli.ts`)**: register `mcp` route and `security scan-mcp` route.
- **`redactRaw` seam**: `src/mcp/redact-seam.ts` calls
  `security/guard.ts:redactRaw({ cwd, content, source: "tool-output" })`; no-ops when
  security is disabled (existing contract), never throws (C0-11).
- **Manifest**: discovery reads `metaproject.json` (`isSecurityEnabled`-style)
  (C0-9, M-11).
- **flow gate**: mutating tools (not shipped in A) would call the same guarded
  service methods the CLI uses; A exposes read-only `flow.status` only (M-10).

## 12. Hooks

No new git hooks required by A. E3 (`scan-mcp`) MAY be wired into the security hook
family later (out of scope for A's minimum; broadened hooks are Group E's E4).

## 13. Standard Profile

Block A **is** the mechanism that emits the LF-standard artifacts (AGENTS.md + Agent
Skills + MCP server). The `metaproject-standard/` package (DOC-2) documents this
cross-module surface, mirroring the `security/` package layout.

## 14. Acceptance

See [`acceptance-criteria.md`](./acceptance-criteria.md). Gate corpus:
`fixtures/mcp-threat/` (E3). Package-wide gate: byte-identical deterministic core
with `modules.mcp.enabled=false` and no SDK (C0-7).

## 15. Phases

See [`tasks.md`](./tasks.md) (T1..Tn). Ordering: Block 0 → A-core (T1..T6) → E3
(T7..T9, ships with A) → generators (T10..T12) → HTTP opt-in (T13) → docs (T14).

## 16. Open Questions

1. MCP SDK package id/version — pinned in Block 0's `optionalDependencies`.
2. `flow.status` has no literal service method; maps to `list`/`get`. Confirm whether
   a dedicated read-only `status` facade is preferred (prd Open Q #2).
3. Should `scan-mcp` self-scan the server's own emitted manifest in addition to
   third-party manifests? (proposed: yes.)
