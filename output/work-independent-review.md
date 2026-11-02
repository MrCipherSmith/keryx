STATUS: DONE_WITH_CONCERNS

# Independent correctness and security review

Verdict: **REQUEST_CHANGES**. Candidate: `feat-hub-work-management`, HEAD supplied as `11a776df1` plus live uncommitted/new core files. Base: `main` (`3dd6ac53…` supplied). No production edits. Frontend deliberately excluded.

Stage 1 checked the implemented lifecycle against `docs/requirements/hub-work-management/specification.md` v0.1.1, particularly §§3, 4, 6–8 and AC2/5/7/9. The findings below prevent a conformance pass. Stage 2 examined authorization/replay, context and subject pins, coverage, cancellation, SQLite transactions, native-v2 reservation/queue bridges, legacy writer refusal and Git observation trust/revalidation. This is a bounded independent pass, not a claim every AC is independently verified.

## F-001 — A cancellation request bypasses the mandatory Attempt start/context gate

- Severity: **blocker** (AC2 / §3 Attempt / §4 required context).
- Source: `src/hub/work/domain.ts:403–407`; downstream submit admits blocked at `:460`.
- Reproduction: create approved Flow/Intent with an exact specification document that is unavailable; create context and a draft Attempt. `attempt.start` correctly returns `context-unavailable`. Send `attempt.report` with `event:"cancel-request"`. This changes draft to blocked. Create report subject and passing Evidence, submit, select and accept. All succeed; aggregate acceptance preview also succeeds with the unavailable required context.
- The draft guard checks only progress/blocked; cancel-request reaches the same blocked state from which submit is allowed. This also skips the caller's exact start-digest confirmation.
- Fix: explicitly define allowed report events from draft; a cancellation request must not confer started/submit eligibility. Keep a start invariant at submit/accept as appropriate so alternate transitions cannot bypass required resolution.
- Class scope: sites `domain.ts:403`, `domain.ts:407`, `domain.ts:460`. Enumeration: read all state assignments in `execute` and all `attempt.report`, `attempt.start`, `attempt.submit`, `review.decide` branches; the only non-start path from draft to a submit-eligible state is cancel-request.

## F-002 — Required-Intent coverage is not enforced at Flow start or aggregate acceptance

- Severity: **blocker** (explicit §3 Flow requirements).
- Sources: `src/hub/work/domain.ts:322–332`, `:744`, `:762–770`.
- Reproduction: create a Flow with one criterion and one `required:false` Intent mapping that criterion; freeze FlowRevision `requiredIntentIds:[]`, approve both revisions. `flow.start` succeeds. Accept a normal manual Attempt for the optional Intent. Flow acceptance-preview succeeds and its entire criterionCoverage consists of that optional Intent. The same manifest is usable by flow.submit/final review because they reuse acceptanceManifest.
- Start never checks at least one required approved Intent or the complete union of approved required mappings. The aggregate loops all required **or accepted optional** Intents and counts every mapping. §3 explicitly requires complete coverage from required IntentRevisions before start/submit and says optional Intents do not satisfy Flow criteria.
- Fix: share a required-membership/mapping check at start and aggregate validation, including at least one approved required Intent. Optional accepted results may be included as supplementary manifest entries but must not contribute required Flow criterionCoverage.
- Class scope: sites `domain.ts:322`, `domain.ts:744`, `domain.ts:762`. Enumeration: `keryx ctx rg` for `case 'flow.start'`, `const selected =`, `for (const m of ir.criterionMappings)` plus reading acceptanceManifest callers (`flow.submit`, flow-review, acceptance-preview). Those are the single admission and shared aggregate paths.

## F-003 — Initial requirement approval resurrects a cancelled Flow

- Severity: **major** (observable terminal-state violation).
- Source: `src/hub/work/domain.ts:293–303`.
- Reproduction: flow.create → work.cancel targeting Flow → requirements.approve its original unapproved current FlowRevision, with the now-current Flow version. Result: cancelled Flow becomes ready and gets an approval Decision. No stale CAS or invalid payload is needed.
- Unlike the Intent approval branch, the Flow branch omits `open(f)` before assigning ready. Cancellation is terminal in the specified lifecycle and everywhere else guarded through open.
- Fix: require an open eligible draft Flow for initial approval; ensure initial Intent approval also requires an open parent Flow.
- Class scope: sites `domain.ts:293–303` and related parent guard at `:307–317`. Enumeration: compared both requirements.approve target branches and all direct assignments of `f.state = 'ready'`; amendment resolution already invokes open(f).

## Executed evidence

- `bun output/work-independent-probe.ts`: reproduced all three findings. The script imports actual domain/validation code, uses synthetic in-memory state and no provider. Output includes `START_CORRECTLY_REFUSED`, `UNAVAILABLE_CONTEXT_ACCEPTED`, `OPTIONAL_ONLY_FLOW_PREVIEW`, `CANCELLED_FLOW_RESURRECTED`.
- Repro raw output: `.metaproject/data/gdctx/raw/2026-11-01T10-43-03-085Z-3cd700_run.log`.
- `bun test src/hub/work/domain.test.ts src/hub/work/execution.test.ts src/hub/work/git-observer.test.ts src/hub/work/observer-http.test.ts src/hub/work/legacy.test.ts src/hub/work/http.test.ts`: **49 pass, 0 fail, 400 assertions**. Existing tests do not expose these sequences. Raw output: `.metaproject/data/gdctx/raw/2026-11-01T10-43-14-206Z-af1025_run.log`.

No additional proven injection, credential disclosure, cross-project read, human-role bypass, observer trust fabrication or replay defect was found in the inspected paths. This does not waive the lifecycle failures above. No live vendor calls or credentials were used.

Routing audit: graph_used=`gdgraph affected src/hub/work/domain.ts` (navigation only; graph predates uncommitted/new files, not relied on as current); wiki_used=wiki index read, dedicated Hub page unavailable; ctx_used=read/rg/run/diff summaries and saved raw probe/test evidence; raw_rg_used=no. Local review-logic/review-security-code skills and testing context read. Local baseline review-agent-profile was unavailable at both referenced candidate locations and absent from `.metaproject` discovery, so the review skills' explicit evidence/severity rules were used. No nested orchestrator or agent dispatch.
