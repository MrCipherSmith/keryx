# Flow 008 — W6 fake provider & fake tools (F-01, F-02)

Status: formalized
Source: user description (harness implementation runbook, Phase 6)

## Problem

The W5 ports (ProviderPort, ToolExecutorPort) exist but have no offline
implementation, so no harness loop can run without a real provider/tools. W6 adds
a deterministic **fake provider** (replays committed transcripts into normalized
events) and one registered **read-only fake tool** (hash-bound recorded results),
all offline — no real SDK, network, or mutation. This is the substrate W7 uses
for the Release 0 read-only vertical slice.

## Expected Outcome

- **F-01 (fake provider)** — deterministic transcript fixtures
  (`fake-provider-transcript.schema.json`) covering deltas, malformed/unknown
  events, errors, cancellation, usage, and retry; a `FakeProvider` implementing
  `ProviderPort` that replays a transcript into the expected `NormalizedEvent`
  snapshots offline and deterministically.
- **F-02 (fake tool)** — one registered read-only fake tool over the W5 tool
  port whose `invoke` returns a `ToolResult` with a hash-bound `outputHash`
  (same input → same hash); no network, mutation, or filesystem access.

## Out of Scope (do NOT touch)

- Any wave other than W6. No real/SDK provider (W14), no session/persistence or
  completion gate (W7), no CLI wiring (W7).
- The frozen requirements package (schemas/protocols) — read/cite, never edit.
- The W5 ports (`src/harness/provider`, `src/harness/tool`) — reuse their public
  surface; add the fakes alongside; do not rewrite the ports. `src/contracts`
  reused, not modified.
- No new production dependency; no provider SDK; no network; no filesystem
  mutation.
- Deferred OPEN values (real provider, budgets) — fakes only.
