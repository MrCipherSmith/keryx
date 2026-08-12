# Shared Agent Context — Phase 6b Operator Playbook

Version: 1.0.0
Status: implemented (readiness tooling + playbook) · real-data ingestion ongoing

This is the owner-run runbook for enabling the opt-in learned candidate policy on
**real** (non-synthetic) artifacts. It complements the runtime guard delivered in
6a ([phase-6-real-opt-in-readiness.md](phase-6-real-opt-in-readiness.md)). The
default posture is candidate **off**; nothing here changes that until an owner
completes every step and explicitly flips the config.

## Preconditions

- The runtime guard (6a) is present: candidate is selected only through
  `resolvePolicySelection`, fail-closed to the deterministic baseline.
- You are the workspace owner on a trusted local host (the guard and this tool are
  local-only and do not change any public CLI/MCP schema).

## Artifact set

Assemble the complete, immutable artifact set under the workspace and record each
sha256 digest:

- `deterministic-baseline.json` — baseline artifact bytes
- `candidate.json` — candidate artifact bytes
- `corpus.json` — corpus rows + quarantine + manifest
- `evaluation-report.json` — digest-bound report with holdout/adversarial/pass
  status and `securityNonRegression`
- (real-data) `receipts.jsonl` — hash-chain ordered AccessReceipts
- (real-data) independent verifier outcome artifacts for every accepted row
- (real-data) sandbox control artifacts referenced in the evidence process

## Config

Write `.metaproject/context-operations/policy-experiment/config.json` with explicit
pins (ref + sha256 digest + immutable version) for candidate, baseline, corpus and
evaluation report. Keep `enabled: false` and `killSwitch: true` **until the
readiness check passes**. See the config example in the
[Shared Agent Context guide](../../../docs/docs/guides/shared-agent-context.md).

## Step 1 — Verify readiness (before enabling)

Run the read-only readiness check from the workspace root:

```bash
keryx workspace policy-readiness
```

It validates the full integrity chain **even while the experiment is disabled** and
prints a per-gate report:

- `config`, `config-pins`, `reference-paths`, `digest-format`, `immutable-versions`,
  `policy-refs` — config shape and pin format.
- `baseline-artifact`, `candidate-artifact`, `corpus`, `evaluation-report` —
  artifact readability, digest match and structural validity.
- `activation-gate` — the evidence gates (security non-regression, holdout,
  adversarial, pin equality, candidate subset), evaluated **as if the flags were
  on**, so you see whether the evidence would pass independently of the config
  flags.
- `activation-flags` — informational: reports whether `enabled`/`killSwitch` are set
  to activate. It does **not** affect `integrityReady`.

Fields:

- `integrityReady: true` — every gate except `activation-flags` passed; the
  artifacts are ready.
- `candidateWouldActivate: true` — `integrityReady` **and** `enabled === true` **and**
  `killSwitch === false`.

The command exits non-zero when `integrityReady` is false, so it can gate a rollout
script. Do not proceed while any gate is `fail`.

## Step 2 — Approve and record rollback

- Document the rollback plan and get it reviewed **before** enabling the non-default
  path.
- Rollback forces `enabled: false, killSwitch: true` (`rollbackPolicyExperiment`);
  keep the exact baseline version pinned so rollback is unambiguous.

## Step 3 — Enable

Only after Step 1 reports `integrityReady: true` and Step 2 is approved, set
`enabled: true` and `killSwitch: false` in the config and restart the service. The
runtime guard re-validates the whole chain on every read and fails closed to the
baseline on any mismatch.

## Step 4 — Roll back

To disable at any time, set `killSwitch: true` (and `enabled: false`). The guard
returns the deterministic baseline immediately. Rolling back never mutates accepted
knowledge, roles, security policy objects or Flow state.

## Exit criteria

- No operator step is skipped.
- Every required gate is evidenced by a `pass` in `keryx workspace policy-readiness`.
- The default deny posture is preserved whenever evidence is incomplete or a pin
  mismatches.

## Still out of scope

- Runtime re-ingestion of the raw `receipts.jsonl` hash-chain and independent
  verifier outcome artifacts at activation time (today these are verified at
  corpus-build time and bound transitively through the evaluation report digest).
- Online learning or candidate self-modification.
