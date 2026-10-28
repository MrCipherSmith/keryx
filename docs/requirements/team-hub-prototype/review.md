# Independent prototype review

Date: 2026-10-25. Scope: `src/hub/`, `src/commands/hub.ts`, `deploy/team-hub/`; requirements in specification.md and api.md. Review performed while implementation was uncommitted. This is a focused independent review, not a completed managed review-run or human acceptance.

Spec compliance was examined before logic/security. Server principal derivation, human-only decisions, pinned spec/digest/base checks, evidence subject association, transactional rollback, idempotency replay order, Git argument arrays/managed branches, cookie/origin/token rotation, safe DOM/CSP, and container persistence were read. Parent integration owns executable verification, browser acceptance, packaging and restart checks.

## Findings pending fixes at review time

### R1 — Valid three-way publication can fail local receipt verification

Severity: major. Site: `src/hub/connector.ts:304`–`313` (the `fetchDelivery` loop over all `revision.files`; line numbers may move during fixes).

Reproduction: start from two tracked files A and B; submit a snapshot changing A while retaining B's base bytes; independently change B on the remote base; publish the selected snapshot. The Git adapter correctly preserves the remote B change, but `fetchDelivery` compares the published B bytes to the old snapshot and rejects the legitimate publication. The existing advanced-base test added a new remote path and did not exercise this case.

Fix: validate exact receipt commit/tree and the selected delta relative to `gitBaseSha`, including deletions, while permitting unrelated base changes. Add an end-to-end regression covering an existing untouched file changed remotely and local edits preserved during fetch. Class scope: one verification loop in `fetchDelivery`, found by reading that function and comparing its complete-file checks with the adapter's three-way merge.

### R2 — Context sync follows checkout index symlinks outside the checkout

Severity: major. Site: `src/hub/connector.ts:238`–`256`, `sync` index read/write.

Reproduction/attack vector: an explicitly connected checkout contains `.metaproject/index.md` as a symlink to another existing writable user file. `sync` reads through that link, creates its backup and writes the routing block through the link into the external target. A symlinked `.metaproject` substituted after connection has the same class of impact. Connection-time checks of the directory do not protect this later operation.

Fix: validate the directory and index at sync time; reject symlinks/nonregular index files and paths outside the checkout before reading or writing. Add a regression asserting an external target remains unchanged. Class scope: the single index writer in `sync`; `saveBinding` was also examined and already rejects a symlinked immediate metadata directory when invoked.

Both findings were sent directly to the connector owner for fixes. The owner reproduced both RED and reported 8 focused tests / 46 assertions GREEN after fixes. Independent follow-up code inspection confirms R1 now compares selected additions/changes/deletions against the Git base and previews the delivered tree, and R2 checks the metadata/index path at sync time before an atomic replacement. The reviewer did not independently rerun those tests; the final code-verifier owns consolidated execution. No additional actionable defect was established in the remainder of the reviewed scope. This is not a claim of production readiness or exhaustive security assurance.

Routing audit: graph_used=yes (affected query reported stale files, so its dependency result was not treated as current); wiki_used=yes (wiki index); ctx_used=yes; raw_rg_used=no.
