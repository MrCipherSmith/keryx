STATUS: DONE_WITH_CONCERNS

# Independent review — round 2

Verdict: **REQUEST_CHANGES**. No production edits. Scope and routing are inherited from `work-independent-review.md`; frontend remains excluded. Review follows spec compliance, then correctness/security. The three initial finding classes are fixed in the inspected source and protected by new focused tests. Two additional reproducible issues remain.

## Prior dispositions

- F-001 fixed: draft cancel-request now refuses instead of creating a submit-eligible blocked state.
- F-002 fixed: Flow start requires nonempty exact approved required membership, CASes those Intents and checks their mapping union; aggregate coverage includes required Intents only.
- F-003 fixed: initial Flow approval invokes open(f), preventing cancelled Flow resurrection.
- Original `bun output/work-independent-probe.ts` now fails early with expected 409 `required-intents-missing`; this is the expected rejection of the original optional-only setup.

## R2-001 — Queued dispatch does not recheck another linked run that became unknown

- Severity: **major**. Sources: `src/hub/work/execution.ts:89–100`, compare the correct fresh-reservation guard at `:75–78`; caller `src/hub/remote-v2/queue.ts:37–39`.
- Concrete sequence: start managed run A on machine A. On healthy machine B, start unrelated work and enqueue a managed message for the same Attempt while run A is active. Revoke machine A, making its linked run unknown. Deliver B's native queue and idle events. The queued message is admitted, a fresh start command is sent to B, and a second execution-link is committed despite A's uncertain execution.
- Reproduction: `bun test output/work-independent-queue-probe.test.ts`. Uses actual local Hub HTTP/WebSocket fixture and real reservation/queue services; no provider. Fails expected link count 1, actual 2, logging `QUEUED_AFTER_UNKNOWN_ALLOCATED command 2`. Raw evidence `.metaproject/data/gdctx/raw/2026-11-01T10-48-37-780Z-4a9d70_run.log`.
- Cause: reserve() checks existing bound-run facts, but beforeAdmission() only checks authority/lifecycle/pins. Time in the native queue is an admission boundary; run availability can change meanwhile. execution.bind refreshes the cached unknown outcome but does not refuse another allocation.
- Fix: beforeAdmission must inspect current existing linked-run facts and refuse if any are unknown, reusing the fresh admission rule. Its own reserved marker must not be treated as a competing unknown reservation. Retain the original queue/reservation for explicit reconciliation; do not manufacture a native transition.
- Class scope: `execution.ts:75–78`, `:89–100`; `sessions.ts` admitMessage and `queue.ts` drainSessionQueue both pass through beforeAdmission. Enumeration: read both reservation and final admission guards, all beforeAdmission/admitted calls and original/queued execution tests; the delayed queue is the missing revalidation path.

## R2-002 — Post-acceptance contradictory Evidence produces no attention item

- Severity: **major**. Sources: `src/hub/work/domain.ts:461–475`, `:834–835`; blocking aggregate guard `:781–782`.
- Concrete sequence: complete a normal required Intent acceptance while its Flow remains in progress; append failing Evidence for its accepted exact subject. The immutable acceptance remains intact and Flow acceptance-preview correctly refuses late-evidence. However `/attention` returns `records:[]`, so there is no actionable incident in the canonical Overview projection.
- Spec §6 explicitly requires contradiction after acceptance to append an attention incident, retaining historical acceptance and blocking current Flow eligibility until human-reviewed remediation. Current code provides the retention and blocking but omits the incident/attention visibility.
- Reproduction: `bun output/work-independent-round2-probe.ts`, exit 0, output `ACCEPTED_LATE_EVIDENCE_ATTENTION { records: [], ... }` and `FLOW_PREVIEW_BLOCKED Error: Late evidence requires new Attempt and current acceptance`. Raw evidence `.metaproject/data/gdctx/raw/2026-11-01T10-47-43-049Z-67f442_run.log`.
- Fix: derive an authorized attention entry from immutable contradictory Evidence whose Attempt/subject matches an accepted submission and whose ID is absent from its sealed evidence set; link it through Attempt/Intent/Flow. Preserve the historical Decision. Resolve the projection when current human-reviewed replacement acceptance supersedes the affected submission; do not hide historical Evidence.
- Class scope: `domain.ts:461–475`, `:834–835`. Enumeration: complete `keryx ctx rg "attention|late-evidence|accepted.*amend|remediation|amend.*accept" src/hub/work docs/requirements/hub-work-management --all`, then inspect Evidence writer, attention reader, acceptance guards and all relevant record variants. Only one attention projection exists.

## Validation and remaining scope

- Focused production suite: **57 pass, 0 fail, 419 assertions**, six files (`domain`, `execution`, `git-observer`, `observer-http`, `legacy`, `http`). Raw `.metaproject/data/gdctx/raw/2026-11-01T10-47-04-264Z-428163_run.log`.
- Reviewed actual SQLite repository and transaction integration; request/replay authorization and current-identity checks; observer post-I/O subject/version/auth revalidation, highest-generation selection, configured workflow/repository/head/policy identity; native reservation/binding facts and legacy conversion/writer guards. No additional proven injection, unauthorized cross-project access, fabricated human decision or credential disclosure found.
- Accepted explicit limitations were not reported as defects: unverified runtime context consumption, no automatic result ingestion, and conservative retry behavior after known native refusal. R2-001 is an additional dispatch while an earlier bound allocation is unknown, not that documented retry limitation.
- Parallel storage/HTTP work was still ongoing; this verdict is for the source inspected, not unobserved later edits.

Routing audit: graph_used=`gdgraph affected src/hub/work/domain.ts` from prior pass, navigation only, stale against ongoing edits; wiki_used=index read, no dedicated Hub page available; ctx_used=read/rg/run with saved raw probe/test logs; raw_rg_used=no. No nested dispatch, live vendor request, credentials or production changes.
