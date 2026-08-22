# MCPSLATE-01 to MCPSLATE-05 — full real MCP protocol test

**Area:** 9. Slate v3 — external MCP surface · **Date:** 2026-08-22 · **Status:** PASS
(01-04) / FAIL — real finding, filed (05)

Executed directly by the parent session: a real Bun script using `@modelcontextprotocol/sdk`
(`Client` + `StdioClientTransport`) spawned a fresh `keryx mcp serve --cwd
/Users/tsaitler.aleksandr/goodea/keryx` process and drove real tool calls — not the (unreliable,
timed-out) subagent attempt at this same test that preceded this run.

## What was actually run

Script: connects, then drives, in order: `slate.open` → `slate.writeSeed` → a second `slate.open`
with the SAME id (different anchors) → `slate.writeSeed` with an invalid `kind` → `slate.writeSeed`
with 4500-char text → `slate.close` → a second slate opened+seeded+closed with NO `workspaceId`
ever bound.

## MCPSLATE-01 — full lifecycle

```json
OPEN1: {"externalSessionId":"mcpslate-full-12345","anchors":{"root":"/repo/test"},"seeds":[],"lastWriteAt":"..."}
SEED1_OK: true — real seed appended, id "seed-c9615dee-...", origin.harness:"mcp-external", trust:"external-unverified"
CLOSE1: {"externalSessionId":"mcpslate-full-12345","closed":true}
```

**PASS** — matches `slate.md` exactly: server-set `origin`/`trust`, real seed id, real close.

## MCPSLATE-02 — second `open` for the same id is a no-op

Second `slate.open` call passed `anchors: { root: "/repo/test-DIFFERENT-should-be-ignored" }` —
the real response still shows `"root": "/repo/test"` (the ORIGINAL anchors) and the seed from
the first call still present, confirming the second call returned the existing slate unmodified
and silently ignored the new (differing) anchors argument.

**PASS** — exactly as documented ("a second open... is a no-op: it returns the existing slate
unmodified").

## MCPSLATE-03 — invalid `kind` throws

```text
Tool slate.writeSeed failed: slate.writeSeed: unrecognized 'kind' "not-a-real-kind"
```

**PASS** — matches the doc's own quoted example almost verbatim.

## MCPSLATE-04 — text over 4000 chars is refused

```text
Tool slate.writeSeed failed: slate.writeSeed: 'text' exceeds the 4000-character limit (got 4500)
```

**PASS.** (The 200-Seed-per-slate cap was not separately exhausted — sending 200+ real calls
was judged not worth the wall-clock/token cost for a boundary already this clearly enforced
elsewhere in the same validation function; noted as a real, deliberate scope reduction, not a
silent skip.)

## MCPSLATE-05 — a slate closed with NO workspaceId ever bound surfaces as `unbound-candidate`

### What was actually run

Opened, seeded, and closed a second slate (`mcpslate-unbound-67890`) with no `workspaceId` at
any point. Confirmed on disk:

```bash
cat .keryx/external-slates/mcpslate-unbound-67890.json
```
```json
{
  "externalSessionId": "mcpslate-unbound-67890",
  "anchors": { "root": "" },
  "seeds": [{ "id": "seed-b5753e61-...", "text": "unbound candidate test seed", ... }],
  "lastWriteAt": "...",
  "closedAt": "..."
}
```

Real artifact, genuinely no `workspaceId` field, genuinely closed. Then:

```bash
keryx workspace catch-up
```

### Captured output

```text
== Unbound candidates (wrap-up ran, no workspace bound) ==
(none)
```

**The closed, unbound external slate does NOT appear anywhere in `catch-up`'s output** — not
under "Unbound candidates" (empty), not under "Unknown" (that section only lists real
keryx-native session UUIDs, never the MCP `externalSessionId` string used here).

### Summary

**FAIL relative to `slate.md`'s explicit documented promise**: *"If nothing was ever bound,
nothing is lost: Anchors and Seeds are written to a local artifact and surface at the next
`keryx workspace catch-up` as `unbound-candidate`, never silently discarded."* The artifact is
genuinely never discarded (it's real, on disk) — but it also never surfaces, which for an
operator relying on `catch-up` as the pull-based discovery surface the doc describes is
functionally indistinguishable from being discarded.

### Analysis (root cause, read from source)

`src/sac/catch-up.ts`'s own comment (line 24) states unbound-candidate detection works by
checking whether `slate-archive/*-unbound-candidate.json` exists — that path is under a
keryx-native session's own store (`~/.local/share/keryx/sessions/<project>/<sessionId>/
slate-archive/`). The external MCP slate store lives entirely separately, at
`.keryx/external-slates/<externalSessionId>.json` (per `slate.md`'s own "On-disk layout"
section). `catch-up`'s unbound-candidate scan has no code path that reads the external-slates
directory at all — the two surfaces (internal session slates and external MCP slates) use
different storage layouts, and only one of the two is wired into the discovery command the
documentation says covers both.

### Improvement / fix suggestion

Either have `keryx workspace catch-up` additionally scan `.keryx/external-slates/*.json` for
closed, unbound entries (matching the same `unbound-candidate` shape it already reports for
internal sessions), or correct `slate.md` to state plainly that external-hand slates left
unbound are NOT currently discoverable via `catch-up` — silently promising a discovery path that
doesn't exist is worse than documenting the gap.

Filed as GitHub issue — see below.
