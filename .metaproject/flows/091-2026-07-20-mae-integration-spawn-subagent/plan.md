# Implementation Plan

Status: ready to freeze

## Approach

A thin, pure orchestration facade over the Phase 1–3 primitives — no new
subsystem, no new behavior, just composition. The facade owns the wiring order
and fail-closed propagation; each primitive keeps its own tested semantics.

## Steps

1. New `src/harness/child/orchestrate.ts`:
   - `buildSubagentPolicy(config)` / allowlist+credential derivation: from an
     injected provider-detection source (mirroring `detectProviders`/env), build
     `allowedProviders` (only credentialed) + a scoped `credentials` map.
   - `SubagentContext` = { parentModel, parentPolicy, parentProvenance,
     parentRemaining (or a shared `RemainingBudgetLedger`), config }.
   - `spawnSubagent(request, ctx, deps)`:
     1. derive caps/tiers/allowlist/envOverride from `config.subagents`;
     2. call `spawnChild` (budget→policy→model + caps) — threading the ledger's
        `remaining` and `childCount`;
     3. on success, `ledger.admit(reservation)` (single authority) and
        `childRunModel(extension)` → `{ provider, model }` for the child run input;
     4. return `{ ok:true, extension, runModel, provenance }` or a fail-closed
        `{ ok:false, reason }` (no partial state).
   - `foldChildSummary(summary)` — apply `quarantineChildSummary` and return the
     quarantined text for the orchestrator to fold.
2. New `src/harness/child/orchestrate.test.ts`: assembly happy-path (inherit +
   explicit + tier), allowlist/credential derivation, shared-ledger aggregate cap
   across N calls, caps denial, quarantine seam, determinism.
3. Optionally surface a typed config block `HarnessRunConfig.subagents`
   (maxTreeDepth/maxChildren/providerAllowlist/tiers) if not already present.

## Risks

- Keep the facade PURE (inject provider detection + clock/idSeq); no ambient
  `process.env` read inside the composition (credentials come via the grant).
- The ledger is the single authority — the facade must admit through it, never
  measure against a static remaining.
- Don't broaden any primitive's contract; compose only.
