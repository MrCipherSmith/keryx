# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A `spawnSubagent(request, ctx, deps)` facade in `src/harness/child/orchestrate.ts` composes `spawnChild` (budget→policy→model + depth/count caps) with `childRunModel`, returning `{ok:true, extension, runModel:{provider,model}|undefined, provenance}` on success or a fail-closed `{ok:false, reason}` with no partial state.
- AC2: The credentialed provider allowlist and scoped credential map are derived from an injected provider-detection source (not an ambient `process.env` read inside the facade); a provider without a detected credential is not admissible (denied at resolution).
- AC3: A single run-scoped `RemainingBudgetLedger` is threaded so that N sequential `spawnSubagent` calls share one budget/count authority; a test proves the aggregate across calls never exceeds the parent budget and the `maxChildren` cap is honored.
- AC4: `spawnSubagent` honors `config.subagents` (maxTreeDepth / maxChildren / providerAllowlist / tiers / env override) — mapping them onto the `spawnChild` caps/model inputs; omitted config yields fail-closed sensible defaults.
- AC5: A `foldChildSummary` (or equivalent) seam runs `quarantineChildSummary` on a child summary before it is returned for folding; instruction-shaped summaries are flagged (marker prepended, text preserved).
- AC6: The facade is pure/deterministic (injected provider-detection + clock/idSeq; no `Date.now`/`Math.random`); `orchestrate.test.ts` covers inherit/explicit/tier assembly, allowlist derivation, shared-ledger aggregate, caps denial, and the quarantine seam; the full suite (incl. the zero-`dependencies` guard) passes and `tsc --noEmit` is clean.
