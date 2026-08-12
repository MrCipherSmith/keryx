# Shared Agent Context (experimental)

Shared Agent Context (SAC) is a **local-first, off-by-default** layer that gives a
human or an agent a reproducible entry point into a piece of work: a small,
verifiable overview, addressed reads of the detail, and a safe way to propose new
knowledge back to the project when the work is done.

!!! warning "Experimental surface"
    SAC is a maturing layer. Its read path, proposal lifecycle and the phase-6
    runtime policy guard are implemented and tested, but the learned candidate
    policy is **disabled by default** and the real-data operator process is still
    planned. Treat the commands below as an experimental workflow, not a stable
    contract. Full requirements package:
    [`docs/requirements/shared-agent-context/`](https://github.com/MrCipherSmith/keryx/tree/main/docs/requirements/shared-agent-context).

## The FWK model

SAC organises context into three kinds, and never blurs them:

- **Facts** — evidence-linked, task-local, freshness-bound statements about the
  current work. A Fact never silently becomes long-term knowledge.
- **Work** — a read-only projection of an existing Flow: done, next, blocked, and
  verification evidence. SAC never creates a second tracker.
- **Know-how** — reviewed, reusable knowledge from memory, wiki and skills. Raw
  transcripts and hidden reasoning are not Know-how.

## Create a workspace and register resources

A workspace links to components, repositories, flows, evidence and approved
knowledge by **workspace-relative reference** — it never copies the source
artifacts.

```bash
keryx workspace create --title "Payments retry" --component ./src/payments
keryx workspace list
keryx workspace add-resource <workspace-id> --kind evidence --uri ./src/payments/retry.ts
keryx workspace add-resource <workspace-id> --kind flow --uri ./.metaproject/flows/<flow>/flow.json
keryx workspace show <workspace-id>
```

## Read a bounded overview, then the detail

The overview returns the smallest mandatory context that fits the budget, plus a
receipt of what was accessed. Detail is retrieved per item on request.

```bash
keryx workspace overview <workspace-id> --max-items 20 --max-tokens 2000
keryx workspace read <workspace-id> <item-id>
```

If a mandatory item cannot fit the budget the operation returns a typed
`context_overflow` rather than a partial success; optional omissions are reported
explicitly.

## Propose knowledge on wrap-up, and review it

An agent may propose an explicit summary, decision, contract change, risk or
follow-up — with evidence. Raw transcripts, prompts and hidden reasoning are
rejected. Only the target owner accepts a proposal, and acceptance is an
append-only transition guarded by freshness, reviewer authority, the security
policy and an idempotent target-write receipt.

```bash
keryx workspace propose <workspace-id> --kind decision \
  --summary "Retry uses capped exponential backoff" \
  --evidence ./src/payments/retry.ts
keryx workspace review <workspace-id> <proposal-id> --decision accepted \
  --idempotency-key <key>
keryx workspace collaboration <workspace-id>
```

## Advanced: phase-6 runtime opt-in policy (off by default)

By default SAC uses a **deterministic baseline** policy. An optional, experimental
learned candidate policy exists behind a strict runtime guard
(`resolvePolicySelection`). It is only activated when an explicit, pinned config
and a complete integrity chain succeed; any failure is **fail-closed** back to the
baseline.

Config path: `.metaproject/context-operations/policy-experiment/config.json`.

```json
{
  "enabled": false,
  "killSwitch": true,
  "candidateArtifactRef": "./fixtures/sac-policy-experiment/artifacts/candidate.json",
  "candidateArtifactDigest": "<sha256>",
  "candidateVersion": "<immutable-version>",
  "baselineArtifactRef": "./fixtures/sac-policy-experiment/artifacts/deterministic-baseline.json",
  "baselineArtifactDigest": "<sha256>",
  "baselineVersion": "<immutable-version>",
  "corpusRef": "./fixtures/sac-policy-experiment/corpus.json",
  "corpusDigest": "<sha256>",
  "corpusVersion": "<immutable-version>",
  "evaluationReportRef": "./fixtures/sac-policy-experiment/evaluation-report.json",
  "evaluationDigest": "<sha256>"
}
```

Rules the guard enforces:

- **Off by default.** The candidate is selected only when `enabled` is `true`
  **and** `killSwitch` is `false`; a missing config keeps the baseline.
- **Explicit pins.** Every artifact needs a workspace-relative ref, a matching
  `sha256` digest and an immutable version; `latest`/`main`/`head`-style versions
  are rejected.
- **Fixed-order integrity chain.** Baseline → candidate → corpus → evaluation
  report → deterministic activation. Any parse error, digest mismatch, schema
  failure or activation mismatch falls back to the baseline.
- **Rollback.** Rolling back forces `enabled: false` and `killSwitch: true`.

This path does not change any public CLI or MCP schema and never enables the
candidate implicitly. The operator readiness process for **real** (non-synthetic)
artifacts is still planned — see
[phase-6-real-opt-in-readiness.md](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/shared-agent-context/phase-6-real-opt-in-readiness.md).
