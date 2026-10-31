# Hub context watch implementation report
Version: 0.1.0

Status: implementation verified; final Hub handoff is recorded separately. Owner acceptance remains pending. No deployment, Git/npm publication or integration-line selection is authorized by this report.

## Frozen contract and result

Flow: `0dd091f2-ef6a-4f59-b4a8-fa1b0cb414bc`. Specification: `specs/hub-context-watch.md`, digest `90d3a0c1f3a6ba0e15358d92cc3a5750c3af35e6ac90d3a09b63a849bfe50bb7`. The owner froze and started the Flow; implementation began at in-progress v3. All eight frozen criteria remain unchanged.

Implemented foreground `hub sync --watch`, interval validation, immediate/incremental updates, safe shared-cache transactions, strict incoming/cache validation, sanitized events, bounded retry, and signal cancellation. Ordinary one-shot sync uses the same serialization. Unchanged cache/index content is not rewritten. An interrupted response cannot commit; a completed cache commit remains valid, including when cancellation occurs during later index maintenance. The stopped event retains the correct committed cursor.

Runtime files: `src/hub/context-sync.ts`, `context-watch.ts`, `connector.ts`, `src/commands/hub.ts`, and source-package inclusion in `scripts/package-team-hub.ts`. New tests are `context-watch.test.ts` and `context-watch.process.test.ts`. No new runtime dependencies or shared root installation changes.

## Executed verification

| Check | Result |
|---|---|
| Watch behavior/process suite | 49 pass, 248 assertions |
| Watch plus connector, independent final review | 55 pass, 291 assertions |
| All Hub regressions, independent normalized run | 160 pass, 1019 assertions, 15 files |
| All Hub regressions with isolated release SDK 1.32.1 | 160 pass, 1019 assertions, 15 files |
| Normalized changed lint/TypeScript | PASS, zero findings |
| Script TypeScript | PASS |
| Root build and frontend freshness | PASS |
| Compiled Mac client with SDK 1.32.1 | PASS: real HTTP, two updates, signal shutdown, local work/provenance preserved |
| Compiled Linux x64 client on geekom | Same real HTTP smoke PASS in an isolated, read-only, network-disabled container |
| Source archive and Linux client/server compilation | PASS; new docs/schema included |
| Documentation links including final report | PASS: 1925 links, 636 files, zero broken |
| Independent correctness/security review | APPROVE, no open findings |

Original RED showed absent behavior. An interrupted-body regression subsequently failed before its transport retry fix. Independent review reproduced two additional defects: malformed approval arrays accepted through coercion, and an outdated stopped cursor after post-commit cancellation. Both received RED regressions, fixes, and independent re-probes. Earlier green runs are not substituted for the final candidate.

The first isolated-release suite attempt failed 15 status fixtures because the archive does not include the repository's macOS TMPDIR-canonicalization test preload. Re-running with canonical TMPDIR, matching that preload, passed all 160 tests without source changes. Both logs are preserved; this was a harness correction, not an ignored failure. Development regression runs use the pre-existing shared SDK 1.30.0; release tests and compiled clients use isolated SDK 1.32.1.

## Evidence and acceptance boundaries

Evidence is immutable and exact-subject-bound, but explicitly self-reported agent evidence, including separate-agent review; it is not independent trusted CI or human acceptance. A review-bundle Code Revision contains changed files, a Git-base patch, source hashes and reports. It cannot be selected, applied as a checkout snapshot or delivered to Git. Git base is `4f594f451649581487c64d3fbd0db45bc235d337`; the immutable bundle, not an unrecorded working tree, is the review subject.

AC1–6: CLI/parser, real HTTP/cache and real subprocess tests verify the runtime behavior and failure paths. AC7: focused, broader, release-SDK and compiled-client gates above. AC8: final revision/Evidence/submission IDs are recorded in the Hub receipt after upload. The owner alone decides acceptance.

## Limits

This is a foreground process, not persistent serve integration or an automatically started daemon. Local code/Git, wiki/OpenSpec sources and Hub approvals are not synchronized or changed by watch. The current server has no document-deletion operation; deletion handling uses contract-compatible HTTP fixtures. A killed process can leave a lock and requires conservative manual recovery as described in [usage](usage.md). Access revocation does not erase already downloaded context.

The 30-second timeout branch was inspected; real transport interruption and cancellation were executed without waiting out that entire timeout. The precise post-cache/pre-index cancellation test uses a deterministic boundary hook. Optional madge, full repository tests, full dependency audit and production multi-instance behavior are not claimed. No live project code was uploaded as a snapshot, no actual Git publication occurred, and the running server image remained unchanged during isolated Linux validation.

## Logs

Preserved under `output/hub-context-watch/`: normalized verification report and JSON/logs, independent security/correctness report, typed worker results, both release SDK runs, Linux compiled smoke, and the final Hub receipt. Main build log: `.metaproject/data/gdctx/raw/2026-10-27T05-38-03-641Z-729145_run.log`; Mac smoke: `2026-10-27T05-38-14-372Z-7d0301_run.log`; packaging: `2026-10-27T05-38-22-522Z-d67969_run.log`.

Routing: graph_used (rebuilt after source additions: 3355 nodes, 11987 edges); wiki_used (index, no dedicated Hub page); memory_used (no relevant match); ctx_used; raw_rg_used: no.
