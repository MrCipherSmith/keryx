# Shared Agent Context — Generational Memory PRD
Version: 0.1.0

## Status

Future / planned. Existing owner memory implementations remain authoritative
until a separately approved implementation delivers these contracts.

## Problem

Agent observations change over time, may conflict, may be relevant only to one
workspace, and may need deletion. Treating all retrieved text as permanent
memory causes stale answers, silent overwrites, repeated false premises,
over-retention, and unreviewed model summaries becoming durable knowledge.
Retrieval quality also cannot be represented by one score: multi-session recall,
temporal updates, contradiction handling, forgetting, privacy, and abstention
are independent abilities.

## Goal

Provide a future, owner-respecting lifecycle with three distinct generations:

```text
ephemeral Session observation
  → explicit admitted TTL workspace working set
  → explicit reviewed owner acceptance as durable knowledge
```

Each arrow is a new, auditable action, not an implicit conversion. The system
must know when to retrieve a valid item, surface a contradiction, or abstain.

## Users

- Agents reasoning within one authorised Session/workspace.
- Operators and reviewers deciding whether reusable knowledge is trustworthy.
- Owners of Memory, Wiki, and Skills who control durable artifacts and deletion.

## Requirements

1. Session observations are ephemeral, evidence-linked, visibility-bound and
   excluded from durable retrieval by default.
2. A workspace working set is an explicit, minimal reference collection with a
   TTL, purpose, applicability, source trust, evidence diversity and freshness
   state; it is not global memory.
3. Durable knowledge enters only through the existing explicit proposal/review/
   owner-acceptance lifecycle. SAC must store only its owner reference/receipt.
4. Each candidate supports `validFrom`, optional `validTo`, and explicit
   `supersedes`/`supersededBy` relationships. A newer claim must not silently
   overwrite an older one.
5. Potentially incompatible claims belong to a visible contradiction set. A
   resolver returns a proven current item, competing visible items, or typed
   abstention when currency/compatibility is not established.
6. Withdrawal, expiry, privacy deletion and legal/policy deletion are distinct
   outcomes. Selective forgetting removes/minimises permitted data while
   retaining only a policy-allowed tombstone and stale reverse links.
7. Retrieval considers authorisation, temporal validity, applicability, source
   trust, evidence diversity, owner state and budget before relevance ranking.
8. A release corpus evaluates single/multi-session retrieval, temporal update,
   contradiction, false-premise, forgetting, privacy deletion and abstention.

## Success criteria

- No expired, withdrawn, superseded, deleted, inaccessible, or inapplicable item
  is silently presented as current durable knowledge.
- Conflicting visible claims are surfaced as a set or yield abstention; neither
  disappears through a silent overwrite.
- A privacy deletion demonstrably removes body/derived copies where policy
  requires, leaves only an allowed tombstone, and makes reverse references stale.
- The evaluation corpus reports outcomes per dimension and blocks a release
  that improves recall by regressing privacy, temporal correctness or abstention.

## Risks

- Extra metadata can turn an optional working set into another hidden store.
- Aggressive deletion may break auditability; excess tombstone detail may leak
  the deleted content.
- Vector similarity can overrule evidence, time, ownership, or visibility if
  treated as authority.

## Recommendation

Start with typed lifecycle metadata and deterministic owner-scoped retrieval.
Introduce an optional retrieval index only after the multidimensional corpus
proves a gain without weakening abstention, deletion, or access controls.
