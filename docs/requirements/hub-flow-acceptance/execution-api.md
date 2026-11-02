# Legacy commented review execution API
Version: 0.1.0

Implementation companion to the approved frozen specification; this document records additive transport details, not a rewrite of the frozen input.

- POST `/hub/v1/projects/{projectId}/flows/{flowId}/request-changes` uses the existing `Idempotency-Key` header and the approved closed request schema. A human operator/reviewer returns the exact implemented candidate, with expected version, trimmed comment and optional pinned criterion references.
- GET `/hub/v1/projects/{projectId}/flows/{flowId}/review-operations/{operationId}` returns the original actor-scoped committed receipt. Encode the entire opaque operation ID with `encodeURIComponent`; encoded separators are accepted only in this final segment. Other project/Flow/path segments retain their traversal guard.
- URL parsers normalize dot-only path segments even when percent-encoded. For such keys, use the equivalent GET `/hub/v1/projects/{projectId}/flows/{flowId}/review-operations?operationId=<encoded key>`. This is a closed query: exactly one `operationId`, no other parameters. It has identical current human, actor, project and Flow authorization, returns the same immutable receipt or `operation-not-found`, and performs no mutation. The alias can also represent any other valid operation key unambiguously.
- A 404 lookup after response loss does not prove failure. Retry the exact original key and payload; never generate a replacement operation or silently retarget a result.
- Existing first `submit-for-review` bodies remain compatible. After a return, the body additionally requires the exact `afterReturnDecisionId` and a distinct new immutable revision with successful evidence. Resubmission clears unresolved feedback, retaining the last-return guard and both immutable histories.

Flow list/detail/action responses expose `reviewFeedback: null` or the unresolved immutable decision fields. `lastReturnDecisionId` is durable after resubmission. The internal resolution flag is not a wire field. Existing list/detail/event invalidation supplies legacy Overview attention; no managed Work attention kind is introduced.

Legacy review guides use presentation IDs `legacy:<frozen-spec-digest>:<1-based-position>`. Structured return references remain `{specContentDigest, position}`. Newly designated `attempt/review-guide.json` files are bounded/validated before persistence; pinned membership is validated at submission. Ordinary JSON is not scanned. Historical invalid or missing guides remain explicit display fallbacks.

## Storage and deployment boundary

The server stores append-only decisions in `hub_legacy_review_decisions` and one latest guard per Flow in `hub_legacy_review_guards`. Flow/version, decision, guard, event and the existing immutable operation receipt commit in one SQLite transaction. Only transient events/document deltas expire; receipts remain durable. Existing explicit history quotas reject new writes atomically instead of deleting accepted facts or operation receipts. Feedback reads fetch current referenced decision IDs in one batch and never scan lifetime decision history.

Opening this implementation activates reserved database minimum-writer marker **5** after the existing migrations complete. The actual tagged **v0.4.5** startup gate refuses marker5 before it can serve requests. Managed Work wire protocol remains1. The minimum compatible release is the first release containing writer5 support; its release number must be recorded by the release process before distribution. Do not label an original v0.4.5 installation compatible merely because a local package version has not been bumped.

Before upgrade, stop the old writer and make a complete SQLite backup including committed WAL data. Trial only a copy; verify historical accepted Flow/receipt/artifact identity and run the old-v0.4.5 refusal proof against the activated copy. Keep the preactivation backup for rollback: an old binary cannot safely reopen the activated database. This work does not authorize a deployment or owner acceptance.
