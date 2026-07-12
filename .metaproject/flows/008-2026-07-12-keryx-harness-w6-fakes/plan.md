# Implementation Plan — Flow 008 (W6 fakes)

Status: frozen scope (W6 only)

## Approach

Add an offline, deterministic fake provider and one registered read-only fake
tool over the W5 ports, test-first. The fake provider replays committed
transcripts into the expected NormalizedEvent snapshots; the fake tool returns a
hash-bound ToolResult. No real SDK, network, or filesystem mutation. Reuse the
W5 ports and the W4 validator; add nothing to `src/contracts`.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Rationale |
|---|---|---|---|---|
| T1 | context | orchestrator inline | Haiku-class | fixture/fake map (done) |
| T5 (F-01 fixtures) | test | tests-creator | **Haiku 4.5** | mechanical transcript JSON fixtures |
| T6 (F-01 RED) | test | tests-creator | **Sonnet** | replay → normalized snapshot tests |
| T7 (F-01) | implement | task-implementer | **Opus 4.8** | FakeProvider over ProviderPort |
| T8 (F-02 RED) | test | tests-creator | **Sonnet** | fake read-only tool + hash-bound tests |
| T9 (F-02) | implement | task-implementer | **Opus 4.8** | FakeReadOnlyTool over tool port |
| T10 | review | review-orchestrator | **Opus 4.8** | code-verifier + determinism/offline + no-net/mutation + no-dep + frozen untouched |
| T2/T3/T4 | umbrella | orchestrator | Opus | seed phases |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each
with the worktree-guard (cd + pwd).

## Steps

1. T1: fixture/fake map + raw→normalized mapping (context.md).
2. T5 (F-01 fixtures): `src/harness/provider/fixtures/transcripts/*.json` — 8
   scenarios, each valid against `fake-provider-transcript.schema.json`.
3. T6 (F-01 RED): tests replaying each transcript via a FakeProvider (not yet
   built) → expected NormalizedEvent snapshot; offline/deterministic; RED.
4. T7 (F-01 GREEN): `src/harness/provider/fake-provider.ts` implementing
   `ProviderPort` (raw transcript → normalized events; malformed→provider_error+
   partial trail; unknown→unknownExtensions; det. clock/ids). Make T6 green.
5. T8 (F-02 RED): tests for a registered read-only fake tool + hash-bound
   `outputHash` (same input→same hash); read-only; gated by validateToolCall. RED.
6. T9 (F-02 GREEN): `src/harness/tool/fake-tool.ts` (FakeReadOnlyTool +
   ToolExecutorPort). Make T8 green.
7. T10: `tsc --noEmit` + full `bun test` (≥677 + new green); determinism/offline
   checks (no Date.now/Math.random/network/fs-write in the fakes); `deps {}`;
   frozen pkg + src/eval + src/contracts + ADRs untouched.
8. `keryx health run`; confirm ACs; completion choice (ask user A/B/C).

## Verification (TDD, real code)

Each feature RED before impl, GREEN after. Gate: `tsc` clean; full `bun test`
≥677 + new green; the fakes contain no `Date.now`/`Math.random`/network/fs-write;
transcripts validate against the schema; tool outputHash stable across re-runs.

## Risks

- **Non-determinism leaking in** → fixed clock/ids in fixtures and fakes; T10
  greps for `Date.now`/`Math.random`/network in the fakes (must be none).
- **Real side effects (network/fs)** → fakes are pure replay/record; AC forbids
  network/mutation; read-only tool classification; T10 verifies.
- **Rewriting the ports/validator** → reuse-only; add fakes alongside; AC forbids
  new port/validator/dependency.
- **Wrong-worktree writes** (W4) → worktree-guard in every dispatch; verify after.
- **Scope creep into W7** → no session/completion-gate/CLI; fakes only.
