# Shared Agent Context — Phase 5 Policy Experiment Report

Version: 1.0.0
Date: 2026-08-12
Status: synthetic mechanism evaluation passed; learned policy disabled

## Result

Phase 5 adds a constrained offline policy-advisor experiment. It does not add
online learning, policy authority, or default runtime exposure. The committed
fixture evaluation compares the exact candidate pin with the deterministic
Context Operations baseline using the read-only, network-off, fail-closed
sandbox contract. Train, holdout, adversarial and security non-regression gates
all pass for the synthetic corpus.

This report proves the corpus, gate, pin, kill-switch and rollback mechanisms.
It does **not** claim that a production learned policy improves task outcomes.
A real opt-in remains ineligible until an operator supplies a real candidate
artifact, real independently verified outcomes and paired sandbox control/deny
evidence whose exact digests match the activation pins.

## Published artifacts

| Artifact | Purpose |
| --- | --- |
| [`receipts.jsonl`](../../../fixtures/sac-policy-experiment/receipts.jsonl) | Three synthetic AccessReceipts with a verified SHA-256 predecessor chain. |
| [`fixture README`](../../../fixtures/sac-policy-experiment/README.md) | Index for the receipt chain, separate completion-gate outcomes, corpus, manifest and evaluation report. |
| [`corpus.json`](../../../fixtures/sac-policy-experiment/corpus.json) | Minimized, pseudonymized rows plus quarantine and manifest. |
| [`manifest.json`](../../../fixtures/sac-policy-experiment/manifest.json) | Published provenance, selection, redaction, quarantine, split and adversarial contract. |
| [`evaluation-report.json`](../../../fixtures/sac-policy-experiment/evaluation-report.json) | Deterministic candidate-versus-baseline result and exact activation evidence digest. |

## Corpus manifest

- Corpus version: `sac-policy-corpus-1.0.0`
- Corpus digest: `d4f29e44732f550f0174bb0263b31601b16f5d414ede9dbcf4b4eb0743f97a31`
- Receipt chain head: `18908e776a405d4678bfc02b912debcd6313da83bffb62e0742c00616d2b0b5a`
- Baseline pin: `deterministic-context-1.0.0`
- Baseline artifact digest: `cce515bd4936afca41767f10ad33d1dddc020d5b5edab3e871ae749091aba60e`
- Candidate version pin: `candidate-1.0.0`
- Verified receipt/outcome rows: 3
- Quarantined fixture rows: 0
- Splits: one train, one holdout, one adversarial

Selection requires a valid complete receipt chain, known Context Operations
configuration/policy revisions, a separately hash-bound verifier artifact and
a verifier subject different from the receipt producer. `AccessReceipt.outcome`
is omitted from rows and is never a label.

Rows are constructed from an explicit allowlist. Workspace, producer and
scenario identifiers are corpus-scoped HMAC-SHA-256 pseudonyms. Raw trace refs,
selected IDs, resource refs, prompts, transcripts, hidden reasoning, secrets,
PII and retrieved content are absent. For real corpora the pseudonym key is not
published. Invalid chains, missing/mismatched outcomes, producer conflicts,
unknown revisions and unsafe artifacts are quarantined and excluded from all
splits.

## Evaluation

| Gate | Result | Cases |
| --- | --- | ---: |
| Train | pass | 1 |
| Holdout | pass | 1 |
| Adversarial | pass | 1 |
| Security non-regression | pass | 3 |
| Allowed sandbox control | pass | 1 |
| Denied sandbox escape | pass | 1 |

- Candidate artifact digest: `f6de324efc35ac0602942f87d092aab6f8c01b6660f78607ee6572ed12f0c6f3`
- Sandbox profile digest: `2c3e94c87ff42064841fa788657219c5144d36282cc4bb4d73ff9aab987c8207`
- Evaluation report digest: `d485302b1e66d20e0f0aed01f4cf409da75fd78033d5cbc4176650ebcdfcd183`

The pinned deterministic baseline is executed twice for each canonical case;
nondeterministic or invalid baseline output fails closed. The candidate can
only return a subset of the baseline's actual authorized row IDs.
Closed-output validation rejects unknown IDs, duplicates and fields that could
express roles, ACLs, security gates, Flow state/acceptance criteria, policy or
candidate configuration. The deterministic baseline remains authoritative.

## Activation, kill switch and rollback

Default configuration is `enabled: false` with `killSwitch: true`. Activation
requires exact equality for candidate version/digest, corpus version/digest,
baseline version and evaluation-report digest, plus passing holdout,
adversarial and security gates. Missing or mismatched pins, sandbox/candidate
failure, a failed gate, or the kill switch returns the caller's byte-equivalent
deterministic baseline result.

Explicit rollback sets `enabled: false`, activates the kill switch and records
only a metadata reason. It never mutates candidate code, roles, security gates,
Flow acceptance criteria/state or accepted knowledge.

## Verification evidence

- Focused Phase 5, FWK and contract suite: 56 passed, 0 failed.
- TypeScript: `tsc --noEmit` passed.
- Fixture tests recompute the complete receipt chain and every referenced
  verifier artifact digest.
- Full repository verification, Code Health and full review are Flow 151
  completion gates and are recorded in its journal/change report.
