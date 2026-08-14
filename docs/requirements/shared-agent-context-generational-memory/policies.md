# Shared Agent Context — Generational Memory Policies
Version: 0.1.0

## Status

Future / planned policy contract. It does not change an existing owner's
acceptance, retrieval, or deletion policy.

## Admission and retrieval policy

An observation enters a workspace working set only through an explicit,
authorised request that identifies purpose, workspace scope, TTL, evidence and
applicability. Every session-derived observation must reference a currently
valid RP-05 sealed `MinimalEvidence` record. The admission policy re-checks its
origin/revision, sensitivity, scan decision, retention/deletion state, and
authorization, and rejects hidden, unverifiable, restricted-for-this-audience,
expired, deleted, over-broad, transcript-derived, or retention-incompatible content. A working
set may contain owner references, but it must not copy owner bodies as a cache.

Retrieval evaluates, in order: caller visibility, owner state/revision,
retention/deletion state, temporal validity, applicability, evidence diversity,
source trust, sensitivity/scan admission, contradiction state, then task relevance and budget. Relevance or
semantic similarity cannot override an earlier negative decision. Context
Operations decides bounded assembly and records the canonical trace.

## Promotion and durable-owner policy

Only an explicit proposal, authorised review, and guarded owner acceptance may
create durable knowledge. A working-set entry is never an implicit approval;
expiry never promotes it; a high score, repeated retrieval, or model assertion
never promotes it. SAC records a minimal reference and receipt after owner
acceptance and does not become an owner or an alternate write path.
All derived records preserve origin, scan, and retention/deletion state; trust
may only stay equal or decrease and sensitivity may only stay equal or rise.
Promotion is denied when a source is restricted, withdrawn, expired, deleted,
or no longer satisfies its original scan/policy binding.

## Temporal, contradiction and abstention policy

Authoritative temporal updates use explicit owner revisions and `supersedes`
links. A replacement is additive until the owner declares the relationship; no
resolver may overwrite a prior claim in its view. Contradiction sets preserve
competing visible claims and their scope. The resolver abstains with a typed
reason when no current applicable claim is proven, a contradiction is open, a
premise is unsupported, or relevant evidence is hidden/stale. It must not
invent a bridge from unrelated records or expose hidden members.

## Forgetting, privacy and tombstones policy

Expiry removes a working-set reference at TTL. Withdrawal states that a still
retained owner item is no longer usable. Privacy/policy deletion follows the
authorised owner deletion path, removes body and derived copies required by the
policy, invalidates indexes, and marks reverse references stale. A tombstone is
minimal: it proves non-use and lifecycle reason without retaining deleted text,
secrets, PII, prompt material, or a reconstructable semantic embedding. Its
retention and visibility follow deletion policy; it is not a memory fallback.

## Index and disclosure policy

No global vector database is enabled by default. If an owner elects an optional
index, it is local/owner-scoped, rebuildable, deletion-aware, access-filtered
before result disclosure, and evaluated as a retrieval candidate source only.
The index has no promotion, temporal, truth, or authorisation authority.
Discovery and errors reveal the minimum permitted metadata and never confirm
hidden observations, contradiction members, tombstones, or artifacts.
