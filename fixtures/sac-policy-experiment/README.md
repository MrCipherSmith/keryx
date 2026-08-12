# SAC Policy Experiment Fixture Corpus

This directory is a synthetic, offline Phase 5 mechanism fixture. It contains
no real actor, workspace, prompt, transcript, reasoning, secret or retrieved
content.

- `receipts.jsonl` is an ordered AccessReceipt hash chain.
- `outcomes/*.json` are separate completion-gate artifacts. Corpus rows bind
  their canonical JSON SHA-256 digests; receipt self-report is ignored.
- `corpus.json` contains only allowlisted, bucketed features and corpus-scoped
  pseudonyms. Its `quarantine` array is empty for this positive fixture;
  negative quarantine cases are exercised in `policy-experiment.test.ts`.
- `manifest.json` publishes provenance, selection, redaction, quarantine,
  deterministic split and adversarial metadata.
- `evaluation-report.json` records the exact candidate/baseline/corpus/sandbox
  pins, the baseline's executed results, paired harness-owned containment
  controls and passing synthetic holdout/adversarial gates.

The corpus proves reproducibility and safety gates only. It does not authorize
or enable a learned policy, and it is not evidence of production improvement.
