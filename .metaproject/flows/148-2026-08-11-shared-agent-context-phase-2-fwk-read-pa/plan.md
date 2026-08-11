# Implementation Plan

Status: ready to freeze

## Approach

Add a SAC-owned read facade that consumes only workspace-relative references and
owner-module snapshots. Keep resolvers pure/read-only; model canonical Context
Operations assembly as an injected facade that produces one trace reference,
then derive the AccessReceipt from that result rather than recording a second
trace. The CLI and MCP adapters call the same facade and serialize the same
normalized response object.

## Steps

1. Define FWK resolver and normalized response types plus typed errors.
2. Implement source facades: visible/revisioned evidence, one read-only Flow
   snapshot, and accepted/reviewed Wiki/Memory/Skill entries.
3. Assemble bounded overview/progressive reads through the canonical assembly
   facade; distinguish mandatory overflow from optional omission.
4. Produce schema-valid metadata-only AccessReceipts with selected/omitted IDs,
   policy/config revisions and canonical trace reference.
5. Add read-only CLI and MCP thin adapters with shared fixtures and parity tests.
6. Verify focused tests, typecheck and health; run full review and fix loop.

## Risks

- Existing Context Operations has no dedicated exported assembly facade; use an
  explicit injected adapter and do not couple SAC to transport internals.
- Access receipt schema requires an integrity hash; derive it only from allowed
  metadata and never raw retrieved values.
- ACL/freshness must be checked immediately before selection so stale or hidden
  source entries are not exposed through direct reads.
