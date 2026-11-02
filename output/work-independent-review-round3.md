STATUS: DONE

# Independent backend review — round 3

Verdict: **APPROVE for the reviewed backend scope**. No unresolved blocker or major findings. This is a delta review plus revalidation of the security/lifecycle invariants examined in rounds 1–2; frontend remains outside this review.

Candidate: `feat-hub-work-management`, HEAD `11a776df1643d5127277f9c2f3909f76c962aacf` plus the actual untracked/working backend implementation inspected on 2026-11-01. The new files are not represented by that HEAD alone. No production edits made by this reviewer.

## Prior findings resolved

- Initial F-001: draft report events cannot bypass exact Attempt start/context checks.
- Initial F-002: Flow start enforces nonempty exact approved required membership and mapping coverage; optional accepted Intents cannot supply required aggregate coverage.
- Initial F-003: cancelled Flow initial approval is refused.
- R2-001: `src/hub/work/execution.ts:87–104` revalidates bound-run facts at final admission through `assertKnownExecutions`, and refuses competing reservations while ignoring its own reservation. The queued message remains queued and receives no new execution-link or command while the earlier linked allocation is unknown. Inspected the production guard and the permanent real HTTP/WebSocket regression test's assertions: one original link, no emitted start command, null run receipt, original native queue state retained. The earlier modified diagnostic alone was not used as proof.
- R2-002: `contradictoryAcceptedEvidence` derives exact immutable nonpassing post-acceptance Evidence by Attempt, subject ID/digest, sealed submission and human acceptance Decision. The canonical attention and Flow projections include those Evidence records without rewriting history. Current replacement acceptance resolves the attention projection; amendment approval alone does not. Existing project filtering precedes this derivation.

The accepted-Intent proposal change now permits a new immutable proposal while preserving approved revision and acceptance pointers. Parent Flow must remain open; cancelled Intent still refuses. Whole-set human amendment clears current acceptance only on approval, and the fresh Attempt/selection/acceptance cycle resolves the incident. The permanent remediation regression checks that historical Decision, subject and submission remain byte-identical and Evidence remains retrievable.

## Executed validation

`bun test src/hub/work/domain.test.ts src/hub/work/execution.test.ts src/hub/work/git-observer.test.ts src/hub/work/observer-http.test.ts src/hub/work/legacy.test.ts src/hub/work/http.test.ts src/hub/work/storage.test.ts`

**68 passed, 0 failed, 519 assertions across 7 files.** Raw evidence: `.metaproject/data/gdctx/raw/2026-11-01T10-55-30-851Z-568413_run.log`.

Re-ran the unchanged independent attention reproduction `bun output/work-independent-round2-probe.ts`: it now returns the exact late failing Evidence in attention and continues to refuse current Flow acceptance-preview. Raw evidence: `.metaproject/data/gdctx/raw/2026-11-01T10-55-30-825Z-f69850_run.log`.

Reviewed the added exact document read route `src/hub/work/http.ts:324–333`: current project authorization occurs first, version/digest are explicit and bounded, historical lookup is scoped, retrieved bytes are digest-checked, and there is no fallback to a different latest version. The HTTP regression verifies historical fetch after update/restart and wrong-project/digest refusal.

## Coverage and limits

Across the three passes, inspected actual domain/schema validation, human/project authorization and replay checks, SQLite transaction/storage integration, requirement/context/subject pins, selection and waiver coverage, native original/queued reservations and execution facts, cancellation/unknown-execution gates, legacy conversion eligibility and writer refusal, observer post-I/O authority/version revalidation, exact provider/repository/workflow/head/policy trust, generation ordering and freshness. No additional reproducible security or concurrency defect was found in the reviewed backend.

This approval does not assert live vendor compatibility, verified runtime context consumption, automatic result ingestion or unrestricted retry after native uncertainty. Those remain explicit documented limits. It also does not replace the root's broader lint/type/frontend/full-Hub gates or user acceptance.

Routing audit: graph_used=prior `gdgraph affected src/hub/work/domain.ts`, navigation only, graph predates ongoing new files; wiki_used=index read, dedicated Hub page unavailable; ctx_used=targeted reads/searches and saved command/test evidence; raw_rg_used=no. Local review skills/testing context were read in round 1 and retained. No live provider calls, credentials, nested agents or production changes.
