# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every included corpus row is produced only after full AccessReceipt schema, record-hash and predecessor-chain verification and links the receipt hash/reference, Context Operations configuration revision, policy revision and a hash/revision-bound independent verifier outcome.
- AC2: AccessReceipt self-reported outcome is never used as a label or sufficient evidence; missing, producer-conflicted, malformed, digest-mismatched, unknown-revision or otherwise suspicious evidence is quarantined and excluded from every corpus/evaluation split.
- AC3: The published offline corpus contains only allowlisted minimized features and corpus-scoped pseudonyms, while its versioned manifest records provenance, selection, redaction, quarantine, deterministic disjoint train/holdout splits and adversarial cases without raw prompt, transcript, hidden reasoning, secret, PII or retrieved content.
- AC4: A deterministic report compares the exact pinned candidate with the pinned deterministic baseline through a fail-closed read-only/network-off sandbox contract, and both holdout and adversarial/security non-regression gates pass before any opt-in activation is eligible.
- AC5: Candidate input/output contracts expose selection features and bounded recommendations only; runtime validation rejects any attempt to modify or express roles, ACLs, security gates, Flow acceptance criteria/state, policy configuration/version or the candidate itself.
- AC6: Activation requires exact candidate artifact, corpus manifest, baseline and evaluation-report pins plus explicit opt-in; kill-switch precedence, pin/gate/sandbox/candidate failure and explicit rollback all select the pinned deterministic baseline.
- AC7: Absent/default configuration never loads or enables a learned candidate, existing SAC authorization/security/Flow/MCP behavior remains unchanged, and no learned-policy mutation surface is exposed through CLI or MCP.
- AC8: Focused and full tests, typecheck, build, documentation-link checks, Code Health and full review pass after remediation; the published Phase 5 report clearly distinguishes synthetic mechanism evidence from production policy-effectiveness claims.
