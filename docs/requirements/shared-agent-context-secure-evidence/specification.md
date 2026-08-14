# Shared Agent Context — Secure Minimal Evidence: Specification
Version: 0.1.0

## Identity and status

**Package id:** `shared-agent-context-secure-evidence` (RP-05).

This is a **future / planned requirements** contract. It introduces no current storage or
write path and does not make SAC the owner of sessions, security decisions, or
durable knowledge.

## Related normative contracts

- [Shared Agent Context agent protocol](../shared-agent-context/agent-protocol.md)
- [Shared Agent Context artifact lifecycle](../shared-agent-context/artifact-lifecycle.md)
- [Secure-evidence policies](policies.md)
- [Secure-evidence agent protocol](agent-protocol.md)
- [Secure-evidence artifact lifecycle](artifact-lifecycle.md)

## Ownership and storage structure

| Concern | Authoritative owner | SAC role |
|---|---|---|
| Session state/sealing | Harness/session | Requests a sealed wrap-up reference only. |
| Security classification/scan | Security | Enforces decision and minimisation before persistence. |
| Derived evidence/proposal metadata | SAC | Stores only authorised minimal records and deletion receipts. |
| Flow state | Flow | May supply a read-only wrap-up snapshot; never changed by SAC. |
| Accepted knowledge | Wiki, Memory, Skills | Receives only reviewed guarded write-intents; no auto-promotion. |

Future SAC-owned records are limited to the following structure; source
transcript content is excluded from the normal workspace tree.

```text
.metaproject/workspaces/<workspace-id>/
  secure-evidence/<evidence-id>.json       # minimised, scan-bound evidence
  secure-evidence/<evidence-id>.delete.json # deletion/inaccessibility receipt
  proposals/<proposal-id>.json             # immutable reference-bound candidate
  access-receipts.jsonl                    # minimised metadata only
```

Restricted archives, if approved, live in a Security/Harness-owned protected
zone outside this structure, with independent access and deletion controls.

## Manifest/config shape

Each future workspace policy MUST identify `minimalEvidencePolicyVersion`,
permitted wrap-up source kinds, retention classes, the Security policy/version,
and whether restricted archive is disabled (the default). An archive-enabled
configuration additionally requires an authorised purpose, archive owner,
access audience, encryption/key reference, expiry, deletion method, and an
incident/revocation owner. Client input cannot set these values.

## Data contracts

### Sealed session and WrapUpProvenance

The session owner alone transitions an eligible session to `sealed`. The sealed
result binds canonical session ID, immutable terminal revision/digest,
authenticated actor, close time/reason, workspace/Flow reference when bound,
and one-time nonce/issuance state. A session may not be unsealed; a correction
creates a new terminal revision. Open, abandoned, malformed, or previously
consumed session output cannot mint `WrapUpProvenance`.

### Schema-closed MinimalEvidence

`MinimalEvidence` permits only canonical IDs, source kind, sealed provenance,
explicit summary/decision/risk/follow-up text, typed EvidenceRefs/revisions,
trust, sensitivity, scan result, minimisation revision, retention class,
created/expiry timestamps, and content digest. It forbids `messages`,
`transcript`, `prompt`, `chainOfThought`, `reasoning`, credentials, arbitrary
attachments, unknown extension fields, and unbounded opaque blobs. All strings
are bounded and validated before scanning and persistence.

### Scan/minimisation result

Security returns `pass`, `redacted-pass`, `needs-approval`, `fail`, or
`indeterminate`, with policy/version, scanner/minimiser revisions, permitted
field set, sensitivity classification, and a minimised payload digest. Only
`pass` or an explicitly policy-approved `redacted-pass` may persist minimal
evidence. `needs-approval`, `fail`, and `indeterminate` persist no candidate
payload; they may emit minimised permitted audit metadata only.

The persistence request MUST be bound to the exact minimised payload digest,
Security policy version, scanner revision, and minimiser revision returned by
that decision. Immediately before commit, the server-owned writer MUST
recompute/compare that binding against the bytes to be persisted and the live
revisions. A missing or changed digest/revision, policy replacement, or any
TOCTOU mutation MUST deny the operation before a payload write; only permitted
minimal denial metadata may be emitted.

### Trust and sensitivity propagation

Every derived record carries `originRef`, `originRevision`, `trust`,
`sensitivity`, `scanDecision`, and `retentionClass`. Derivation may preserve or
downgrade trust and may preserve or raise sensitivity, but cannot upgrade trust
or lower sensitivity. Mixing inputs applies the least-trusted and most-sensitive
result unless the Security owner provides a stricter rule.

### Restricted archive

An archive is a distinct source class, not `MinimalEvidence`. It may not feed a
proposal/read/owner write unless a separate future Security policy expressly
authorises an extracted and re-scanned minimal record. Default mode is archive
disabled. Archive retrieval is deny-by-default, purpose-bound, audited, and
time-limited; its expiry triggers owner-controlled deletion or crypto-erasure.

## Future CLI and agent surface

All operations below are planned, not current commands.

```text
keryx workspace wrap-up seal --session <id>
keryx workspace wrap-up prepare --sealed-session <id>
keryx workspace evidence status <id>
keryx workspace evidence delete <id>
```

Agents may request preparation from a sealed session and receive a typed
ready/denied/expired/deleted result. They cannot upload a transcript, choose a
scan outcome, mint provenance, change retention, restore deleted evidence, or
invoke archive retrieval through the normal SAC surface.

## Integrations

- Harness/session: seals terminal output and issues one-time provenance.
- Security: validates schema, scans/minimises, assigns sensitivity, approves
  any restricted archive, and owns response to a scan/deletion incident.
- Context Operations: receives only allowed bounded evidence references/content
  and remains owner of assembly trace.
- Flow: can provide an immutable read-only wrap-up snapshot only.
- Wiki, Memory, Skills: receive reviewed, evidence-bound guarded write intents
  and return owner receipts; their accepted knowledge remains owner-owned.

## Acceptance criteria

- **AC-1:** Open/unsealed/replayed sessions cannot issue provenance or create
  minimal evidence; sealed session identifiers/revisions are immutable.
- **AC-2:** Schema tests reject every forbidden/unknown transcript, prompt,
  hidden-reasoning, credential, and oversized field before persistence.
- **AC-3:** Scan/minimisation runs before any minimal evidence write; denied,
  indeterminate, unapproved, missing-binding, revision-mismatch, and TOCTOU
  outcomes persist no candidate payload.
- **AC-4:** The normal path has archive disabled and no full transcript store;
  every archive fixture requires explicit policy, access, TTL, and deletion.
- **AC-5:** Trust/sensitivity propagation fixtures prove no derivation can
  upgrade trust or lower sensitivity, including through proposal and receipt.
- **AC-6:** Expiry/deletion tests prove evidence/archive bytes become removed or
  cryptographically inaccessible and references become `deleted`/`unresolved`.
- **AC-7:** Proposal tests prove no auto-promotion, no direct owner write, and
  no Flow mutation; only guarded owner receipts can support acceptance.
