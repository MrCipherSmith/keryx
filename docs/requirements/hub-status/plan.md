# Hub connection status — implementation plan

Hub Flow: `80dbcd31-1d6d-47ed-8a84-ad20bec31c6e`.
Frozen specification: `specs/hub-status.md`, version 1, digest `810c6aa02b407f817591c705e565e4be7961fd368be33ff70a294aadffd3665b`.
Baseline: `da19d65fbd34abe802532c650e2fdd55ec09e819`.

## Contract

`keryx hub status` reports this checkout's existing local binding. Connected output exposes only Hub URL, projectId and checkoutId. An unconnected checkout receives a clear message. No credentials are needed or exposed; no HTTP requests, filesystem writes or Git changes occur.

The trusted global connector binding is authoritative; the repository's .metaproject/hub.json copy cannot supply an alternate connection. Missing trusted binding means unconnected. Corrupt/unreadable binding is an explicit sanitized error, not a false unconnected result. Existing sibling worktrees/clones keep their distinct checkout identities.

## Tasks

1. T1: implement a read-only status projection using existing connector storage and register the command/help. Add focused tests before implementation: connected, unconnected, no credentials/network/writes, malformed binding and untrusted checkout mirror. Preserve existing commands.
2. T2: independent verification and correctness/security review; run focused connector/command tests, root TypeScript, changed-file lint and packaging smoke as appropriate.
3. T3: create an immutable review-only Code Revision descended from an initial plan revision, attach exact-candidate Evidence, submit the Hub Flow for owner review. Do not accept, publish Git, or modify integration line. Do not deploy/restart the running Hub for this local CLI-only feature.

## Completion policy

Continue the established Hub cycle. This is not a second legacy local Flow. Code Revision is the temporary Attempt representation. Full repository snapshots exceed the Hub quota; the review bundle contains the base Git SHA, changed files and patch, and is technically blocked from selection/delivery. Final acceptance belongs to the owner.

## Routing

graph_used: find/affected, graph predates untracked output artifacts only; wiki_used: index (no Hub page); memory_used: no matching entry; ctx_used: read/rg/run; raw_rg_used: no.
