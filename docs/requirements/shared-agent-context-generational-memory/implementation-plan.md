# Shared Agent Context — Generational Memory Implementation Plan
Version: 0.1.0

## Status

Future / planned delivery sequence. This document does not authorise a runtime
change, an owner migration, or a new shared datastore.

## Phases

1. **Contracts and policy** — Define typed observation, working-set reference,
   temporal, contradiction, tombstone and deletion contracts; establish owner
   interfaces and retention authority. Reject any body-bearing SAC durable
   schema.
2. **Ephemeral and working-set path** — Add trusted evidence-linked observation
   creation and explicit workspace admission/TTL handling. Prove bounds,
   ACL/revision checks, expiry and no prompt-wide injection.
3. **Owner-acceptance integration** — Reuse the guarded proposal/review/owner
   write path to record accepted references and receipts. Prove no direct SAC
   durable write, automatic promotion, or owner lifecycle bypass.
4. **Temporal/contradiction resolver** — Implement explicit supersession,
   contradiction sets, applicability, evidence diversity, source trust and
   typed abstention before relevance ranking.
5. **Forgetting/deletion propagation** — Integrate owner withdrawal/privacy/
   policy deletion with working-set/index invalidation, stale reverse links,
   minimal tombstones and idempotent recovery.
6. **Corpus and guarded optional index** — Build the required corpus and
   adversarial disclosure/deletion tests. Consider an owner-scoped disposable
   index only after deterministic baseline gates pass; never add a default
   global vector DB.

## Delivery gates

Each phase remains feature-gated and disabled by default until its negative
tests pass. A gate fails on automatic promotion, SAC durable body persistence,
unbounded context injection, hidden-data disclosure, stale-current answers,
silent contradiction resolution, deletion residue, or index bypass of policy.
Rollback disables the new surface and prevents re-use of derived entries; it
must not mutate or delete owner artifacts outside their approved lifecycle.

## Definition of done

Done requires complete lifecycle evidence for all three generations, owner-only
durability, explicit transitions, temporal and contradiction-safe abstention,
selective forgetting/privacy deletion, applicable/diverse evidence checks, and
a passing multidimensional corpus. The documentation and all future surfaces
must remain explicit that SAC is a reference/receipt layer, not a global memory
database.
