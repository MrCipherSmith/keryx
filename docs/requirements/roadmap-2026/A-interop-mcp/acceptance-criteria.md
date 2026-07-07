# Acceptance Criteria: Block A — Interop & Adoption (MCP)

Version: 1.0.0 · Date: 2026-07-07

Each ACn is a hard, testable gate. "Measured, not asserted in prose" (F-4) applies
to every capability metric. Gate corpus for E3: `fixtures/mcp-threat/`.
Package-wide gate: C0-7 (byte-identical deterministic core when MCP is off).

---

## AC1 — An external MCP client can list + invoke ≥N Tools over stdio
**Given** a fixture metaproject with `modules.mcp.enabled=true` and the MCP SDK
installed, **when** a generic MCP client (e.g. MCP inspector / test client)
completes the initialize handshake over **stdio** and calls `tools/list` then
`tools/call`, **then**:
- [ ] `tools/list` returns **N ≥ 10** Tools including all review-named actions:
  `gdgraph.affected`, `gdgraph.cycles`, `gdgraph.orphans`, `security.check`,
  `security.scan`, `flow.status`, `memory.search`, `health.gate`, `wiki.query`,
  `standard.validate`.
- [ ] `tools/call` on each returns a result **equal to** the corresponding
  `createXService()` method's in-process result (JSON-serialized), verified by a
  paired in-process unit test (T-1).
- [ ] The round-trip runs in CI over stdio against the fixture project (T-2).
- [ ] No `src/mcp/` file imports a module's internals — only service facades +
  `lib` + `guard` (M-3, enforced by an import-boundary test/lint).

## AC2 — Resources are listable, readable, and read-only
- [ ] `resources/list` enumerates **≥3** classes: `artifacts` (`data/*/artifacts`),
  `wiki`, `memory`, using the `metaproject://<class>/<relpath>` scheme.
- [ ] `resources/read` returns the raw file contents for a listed URI.
- [ ] No MCP call mutates any file (a test asserts the tree hash is unchanged after a
  full `resources/read` sweep) (M-4).
- [ ] URIs resolving outside a configured root are rejected.

## AC3 — Manifest-driven discovery
- [ ] A module with `modules.<m>.enabled=false` does not appear in `tools/list` or
  `resources/list` (M-11, US-A103).
- [ ] With `modules.mcp.enabled=false`, no Tool/Resource is exposed and no SDK is
  loaded on any non-`serve` path (M-7).

## AC4 — All MCP tool output passes through `redactRaw` (E3, hard)
- [ ] Every Tool handler routes its serialized output through
  `redactRaw({ cwd, content, source:"tool-output" })` before returning it (M-5).
- [ ] With a seeded secret in a tool's result and `security` enabled, the transported
  output has the secret **masked** (test-verified).
- [ ] With `security` disabled, `redactRaw` returns **byte-identical** content and the
  tool still returns exit 0 (existing seam contract; never throws, C0-11).

## AC5 — `security scan-mcp` catches a poisoned-tool fixture (E3, hard)
- [ ] `gd-metapro security scan-mcp fixtures/mcp-threat/` flags **100%** of the
  enumerated vectors across `poisoning/`, `line-jumping/`, and `rug-pull/`
  subcorpora (measured against the committed corpus, F-1/F-4).
- [ ] The detector (`src/security/detect/mcp.ts`) is pure & network-free, returns
  `DetectorMatch[]`, and slots into `runDetectors` (E-3).
- [ ] A benign control manifest produces **no** finding (no false positive on the
  labeled benign set).
- [ ] `scan-mcp` findings contain no raw manifest secret (leak-safe, E-9).
- [ ] Rug-pull: a manifest whose pinned tool-definition hash diverges from the
  committed baseline is flagged; an unchanged manifest is not.

## AC6 — `llms.txt` emitted, deterministic, valid
- [ ] The generator emits `llms.txt`.
- [ ] Re-running the generator twice yields a byte-identical file (deterministic, F-2).
- [ ] The output passes an `llms.txt` format validator in CI.
- [ ] The generator loads no runtime dependency (C0-10).

## AC7 — gdskills plugin/marketplace export round-trips
- [ ] `gd-metapro skills export <skill> --runtime plugin` produces a
  plugin/marketplace package.
- [ ] An export→import round-trip reproduces an equivalent skill (test-verified).
- [ ] `AGENTS.md` and `SKILL.md` remain schema-valid after export (G-A2 validators).

## AC8 — HTTP/SSE is a separate, removable opt-in
- [ ] Default `mcp serve` opens **no** listening socket (asserted by the no-network
  sandbox test, T-4).
- [ ] `mcp serve --http` requires `capabilities.http.enabled=true`; absent that, no
  HTTP path is reachable (M-8).
- [ ] stdio and HTTP transports are isolated in `transport/`; deleting `http-sse.ts`
  leaves stdio fully functional (M-12).

## AC9 — Deterministic core unaffected when MCP not installed (package-wide gate)
- [ ] With `modules.mcp.enabled=false` **and** the MCP SDK not installed
  (`bun install --omit=optional`), the full existing test suite passes **byte-identically**
  and every default command succeeds (C0-7).
- [ ] The no-network sandbox test confirms every default command opens **no socket** (T-4).
- [ ] The `dependencies` block in `package.json` remains **empty**; the MCP SDK is only
  under `optionalDependencies` (C0-1, M-6).
- [ ] `src/mcp/` contains no top-level import of the SDK — only lazy `await import()`
  inside `server.ts` (C0-2, verified by grep/lint in CI).

## AC10 — Sanctioned exception behaves as specified
- [ ] `mcp serve` invoked **without** the SDK installed exits non-zero with an
  **actionable** message (how to install / `assets`), rather than silently degrading —
  the single opt-in command allowed to hard-fail (specification §9).
- [ ] This hard-fail occurs **only** for the explicit `serve` invocation; no other
  command is affected (re-checks AC9).

## AC11 — Standard repositioned (doc-only, G-A3)
- [ ] `standard` module README/spec + `metaproject-standard/` docs state the
  3-emitted-artifacts (AGENTS.md + Agent Skills + MCP server) generator framing.
- [ ] The framing is cross-linked to A1 (MCP) and A2 (`llms.txt`, skills export).
- [ ] `roadmap.md` updated. **No code change** in this item (architecture §5).

---

## Test-pyramid alignment (T-1..T-4, §8 BP)
- Unit (per-service-method, detector, generator, fallback): ~70% — AC1(method parity),
  AC4(disabled byte-identical), AC5(detector), AC6(generator).
- Integration (stdio round-trip, manifest wiring, resource sweep): ~25% — AC1..AC3, AC8.
- E2E/CI (mcp-threat corpus eval, no-network sandbox): ~5% — AC5, AC9.
