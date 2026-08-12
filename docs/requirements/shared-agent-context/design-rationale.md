# Keryx Shared Agent Context — Design Rationale
Version: 1.1.0

## Core decision

SAC separates short-lived verified state, current work and reusable knowledge
instead of treating all context as one memory store. The resulting model is
**FWK: Facts · Work · Know-how**.

- Facts are true only relative to visible evidence and time.
- Work is a projection, not a new authoring model.
- Know-how has a durable owner and a review lifecycle.

This separation prevents a finished task status becoming a permanent fact, or
an unreviewed model summary becoming team knowledge.

## Keryx-first boundaries

- Context Operations owns retrieval/assembly and its trace; SAC owns the
  collaboration entry point, role-aware links and receipts.
- Flow remains the sole writer of work state.
- Harness remains owner of session, execution, approval and worktree lifecycle.
- Wiki, memory and skills remain owners of durable knowledge.
- SAC composes existing security and MCP seams rather than creating a direct
  persistence or egress path.

## Why local-first and read-first

Local manifests permit an inspectable, portable and offline first slice. A
read-first surface exercises reference resolution, ACL and redaction without
making knowledge writes irreversible. Cross-project/network storage remains a
future decision because its identity, sharing and deletion semantics differ
materially from local project ownership.

In v1, local-first has a deliberately narrow meaning: each subject has a
canonical `SubjectId`, and every target reference is typed and
workspace-relative. Resolution performs `realpath` plus configured-root
containment in application code, rather than treating path text as authority.
This keeps path aliases, symlinks and remote URI semantics outside the initial
trust boundary.

## Why deterministic policy before learning

Access policy begins as a versioned pure function. Receipts and independent
verification form an evaluation corpus. Any later learning is useful only if it
improves against a fixed baseline while preserving security and quality gates.
It is therefore an experiment, never an authority over policy or knowledge.

A receipt's self-reported outcome is not ground truth. Learning remains blocked
until rows bind immutable/hash-linked receipts to policy versions and
independently verifiable outcomes, and until the corpus declares selection,
redaction and provenance. Holdout and adversarial cases test generalisation and
security non-regression; anomalous or unverifiable records go to quarantine,
not training or evaluation.

## Safety invariants

- No raw transcript or hidden reasoning is persisted as SAC knowledge.
- Every Fact and proposal is evidence-linked; every acceptance has a human or
  explicitly authorised reviewer recorded by the target's guarded path.
- Expired, withdrawn, changed or inaccessible sources produce explicit stale
  or denied states, not silent fallback content.
- Data minimisation applies to overview, receipts and audit logs.
- Required context never degrades into a misleading successful partial result:
  it returns typed `context_overflow`. Optional omission is explicit and
  enumerable so a caller can decide whether to request another bounded step.
- Timestamp strings are not trusted merely because they look formatted. A
  pinned validator and semantic parser enforce UTC, ordering and immutable
  lifecycle transition monotonicity.
- These are future contracts. Existing runtime behavior remains owned by the
  current modules until an implementation Flow delivers and verifies SAC.
