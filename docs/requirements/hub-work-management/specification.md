# Specification: Flow / Intent / Attempt / Evidence / Decision
Version: 0.2.0

Status: implemented candidate contract for owner testing; independent review and scoped automated verification passed. Product acceptance remains pending. Identity: `hub-work-management`, metadata protocol version1. Baseline and open owner choices: [decisions](decisions.md).

## 1. Domain boundaries

Hub owns project knowledge/work metadata and acceptance. Git/GitHub own code history, PR and merge. Existing SessionHost owns local execution, controller and tool policy. This feature never routes Git bytes between developers or turns Hub into a shell/CI executor. All work entities are scoped to exactly one project. Cross-project parent/reference IDs refuse even when an actor can access both projects.

A Flow contains Intents; an Intent is one bounded deliverable (proposed P1). An Attempt is one accountable approach to one exact IntentRevision. Attempts can run concurrently on different allowed workspaces. Session and Run IDs are execution references, never substitutes for Intent/Attempt. A bounded manual attempt can have zero run links. A run can link to only one Attempt; historical links never move.

## 2. Authoritative records

Closed draft2020-12 schemas: [domain](schemas/domain.schema.json), [commands](schemas/command.schema.json), [events](schemas/event.schema.json). HTTP projections may aggregate these records but cannot invent actor, acceptance, execution or trust values. Schemas validate structure; transactional invariants in sections3–8 are equally required.

| Record | Meaning and immutable content |
|---|---|
| WorkFlow | Mutable aggregate/version/status; stable ID, project, owner; points to exact approved FlowRevision and accepted Decision |
| FlowRevision | Problem, expected outcome, scope/out-of-scope, spec document ref, stable Flow criteria and required Intent ID set; digest excludes server envelope |
| WorkIntent | Stable bounded deliverable/owner/required flag; state and approved IntentRevision pointer |
| IntentRevision | Deliverable, plan/non-goals, stable Intent criteria, exact parent FlowRevision and relevant Flow criterion IDs |
| Attempt | Accountable participant and method, exact requirement/context pins, state, outcome report and optional superseded Attempt; mutable metadata version until sealed submission |
| ContextSnapshot | Immutable ordered manifest of document/config refs, declared Git base refs and source/resolution states; digest and provenance |
| ExecutionLink | Existing session/turn/run/checkout/machine IDs plus native association observation; no new execution authority |
| ResultSubject | Immutable manifest of commits/trees/documents/legacy attachments, bounded report and digest; no full source tree required |
| EvidenceRecord | Immutable exact subject + Attempt + criterion refs, method/results/provenance, output digest or bounded report |
| ReviewSubmission | Immutable subject/evidence-set/coverage/context/requirement pin snapshot and digest; target of every review decision |
| Decision | Append-only authorized human decision over exact immutable subject/submission/revision, with reason and causation; referenced by state projection |
| WorkEvent | Durable per-project sequence for committed mutation, deduplicated operation identity and bounded safe metadata |

Stable IDs are opaque; criteria IDs persist within revisions and are never reused for a different meaning. Semantic edits create a new revision/digest; deletion tombstones rather than rebinding IDs. Server stamps createdBy/At, updatedAt, actorKind, verified observations and version. Shared principal is shown as shared, never a verified personal identity. Requested owner need not equal creator; unassigned is explicit.

Canonical digests are SHA-256 of UTF-8 canonical JSON: recursively lexicographically sorted object keys, no whitespace, array order preserved and validated canonical ordering for manifest entries/criterion IDs, no server envelope (IDs/actor/timestamps) inside contentDigest. A record binds identity separately through foreign keys and ReviewSubmission references. Reject duplicate criterion/ref IDs; never accept a client digest without recomputation.

## 3. Lifecycle and transactional guards

### Flow

`draft → ready → in-progress → in-review → accepted`; explicit human `cancelled` from nonaccepted states. Proposed amend freezes a new revision separately; historical approved versions stay readable. Flow moves to ready only through a human requirement-approval decision. Start requires at least one explicit required Intent with approved revision. Submit requires current revision, all required Intents accepted against that exact revision, and an immutable aggregate acceptance manifest. Every Flow criterion must map to at least one criterion in a required IntentRevision through explicit criterionMappings {intentCriterionId,flowCriterionId}; the union must cover the complete Flow criterion set before Flow start and submit. At start, only approved mapping completeness is required; finished Evidence is not. At submit and final acceptance, all mapped criteria must have accepted passing Evidence or exact permitted waivers in the current Intent submissions. Integration/cross-deliverable criteria require an explicit required integration Intent with Evidence over the complete result composition. Mappings reference criteria in the same exact revisions, duplicate pairs refuse, and flowCriterionIds is the server-validated unique projection of those mappings (client mismatch refuses). Empty mappings never establish coverage; unmapped optional Intents do not satisfy Flow criteria. FlowSubmission includes server-derived criterionCoverage mapping Flow criteria to exact Intent criterion/submission/Decision IDs. Preview, submit and final acceptance recompute coverage and reject omissions or unrelated criteria. That manifest names each selected accepted Intent Decision/subject, requirement/context validity and unresolved knowledge follow-ups; its digest is the Flow review subject. Human final acceptance CASes that exact manifest and current Flow version. A concurrent required-Intent change invalidates submission, never old decisions.

### Intent

`draft → ready → in-progress → in-review → accepted`; `cancelled` human-only with required-Intent membership amendment if Flow remains active. An Intent is ready only after human approves its revision under the current approved FlowRevision. FlowRevision membership uses stable required Intent IDs to avoid circular revision hashes; approved IntentRevision pins its parent FlowRevision. Flow submission captures the exact current accepted Intent revisions/decisions, not a floating membership set. A successful Attempt submission may move Intent to in-review, but does not prevent other existing Attempts from finishing. Selection of one Attempt is a separate human Decision; only its exact ReviewSubmission may be accepted for the Intent. Change request moves Intent to in-progress; failed Attempt does not auto-fail Intent.

### Attempt

`draft → running|blocked|cancelled`; `running ↔ blocked`; `running|blocked → submitted|failed|cancelled`; `submitted → accepted|changes-requested|rejected|withdrawn`.

Starting snapshots one approved IntentRevision/FlowRevision and context. Draft has no implicit executed work. An Attempt can aggregate several runs in the SAME approved work scope; one successful turn does not submit the Attempt. Progress/blocked is contributor-report, not proof of OS pause. Failed/cancelled work can retain partial subject/Evidence but cannot be submitted as successful work. A submission seals the Attempt's report/context/result/evidence set. Continued implementation after changes-requested/withdrawn uses a new Attempt with supersedesAttemptId; no old subject rewrite. Existing session can be reused after fresh explicit association.

Stopping an Attempt does not prove runtime cessation. Cancellation first requests underlying allowed run cancellation, records unknown if uncertain, and blocks new bindings/submission while linked work may still mutate the result. A work state never releases physical session/checkout ownership. Unknown or active linked Runs prevent submission; late results append as observations requiring review, not silently alter sealed data.

### Amendments and concurrency

Requirement amendment is human-only. Creating a proposal leaves current approved requirements intact; authorizing an amendment marks affected Intents/admissions as change-pending in the same transaction. New Attempt starts/dispatches refuse until replacement revisions approved or amendment withdrawn. Existing active work receives a visible scope-drift signal and must recheck at next admission; this metadata feature cannot promise to retract an already-running effect. Old Attempts remain pinned; they can be reviewed historically or used as historical inputs to a new Attempt with fresh context, Evidence and review under replacement revisions. No automatic rewrite/reuse of an old accepted status for a changed criterion. All derived acceptance pointers update transactionally or not at all.

Amendment v1 deliberately excludes compatibility/carry-forward Decisions. Every Intent affected by a replacement FlowRevision requires a replacement IntentRevision pinned to it, a fresh Attempt and fresh acceptance; old accepted decisions remain historical. The immutable AmendmentManifest contains flowId, sourceFlowRevisionId, affectedIntentIds and an exact sorted replacement set of {targetType,targetId,revisionId,contentDigest}, plus reason. Its server-recomputed digest binds the whole set. requirements.resolve-amendment targets amendmentId+manifestDigest and atomically approves the complete set or withdraws it; no partial replacement. A Flow revision change affects all member Intents, even unchanged deliverables. One pending amendment per Flow. requirements.approve cannot independently activate revisions in a pending amendment. Amendment approval resets affected work projections to ready and clears current selections/acceptance pointers, retaining history. Accepted Flows are immutable; later work creates a successor Flow.

Bootstrap: create Flow draft, create explicit draft Intents, propose FlowRevision containing their stable required IDs, approve that Flow revision, then propose/approve Intent revisions pinned to it. Flow start requires approved membership and full mapped coverage. Adding membership after approval uses the amendment transaction.

## 4. Context and metadata movement

1. Contributor obtains current Flow/Intent revisions and a ContextSnapshot manifest with authorized document versions/digests and declared Git base refs.
2. Local consumer resolves/cache-fetches exact referenced content. Required missing version or unsupported overlay prevents start, not silent use of latest. Optional unresolved content remains explicitly absent. Snapshot age != actual runtime consumption proof.
3. Start receipt pins the manifest. For agent runs an ExecutionLink records what the runtime actually observed (or `unverified`); it cannot claim the approved metadata manifest replaced runtime context when it did not.
4. Actor records progress, questions, blockers and actual result refs; disconnected local outbox retries the SAME operation key and original payload/preconditions.
5. Hub commits canonical metadata, immutable records and event/outbox atomically. Project cursor updates local caches/UI; response loss is reconciled before a new operation.
6. New context versions produce drift observations/proposals. Existing Attempt history is unchanged. Admission to changed approved requirements requires a new explicit work association.

Runtime bridges stay on frozen v2. A new server-side WorkExecutionBinding associates an existing v2 run atomically at its creation boundary using the original human principal and existing FlowAssociation pins; a separately created run may attach only through an exact verified link with no intervening execution association change. The link is a fact, not a fresh controller lease/grant. Arbitrary machine-supplied Attempt IDs are never trusted. A bridge that cannot prove binding reports unavailable for managed execution; manual work metadata still works. See [protocol](metadata-protocol.md).

## 5. Git and document results

A subject's artifact manifest supports:

- `git`: configured project repository ID, full commit OID, optional independently observed treeOID, and canonical configured PR link + observed headOID (never a floating branch-only result).
- `document`: Hub document ID, exact version/content digest and immutable bounded proposal ref if applicable.
- `legacy`: existing same-project CodeRevision ID/digest, retaining review-bundle restrictions. Optional; never mandatory for new result subjects.

Client claims and server-verified repository observations are separate. Full OIDs accept SHA1(40hex) or SHA256(64hex) according to repository object format. URLs never carry credentials; use configured repository/provider IDs plus PR number, not arbitrary fetch URLs. Multi-repository results enumerate each commit; no atomic multi-repo merge claim. Reports/no-code outcomes may have document artifact only; purely narrative result requires immutable bounded report artifact, not fabricated commit.

Manual contributor submission may be `unverified` but cannot satisfy a verification policy requiring repository reachability. A configured server read adapter or dedicated read-only Git integration may verify exact repo/object/head. No new GitHub credential needed for drafting; deployment provision is separate. A moving PR head never changes the subject: append observation, mark that live-PR projection stale, and refuse current-PR acceptance until the reviewed head is exact. Historical commit result remains valid for historical review; decision must explicitly target that commit, not claim latest PR approval. A merge observation is not Flow acceptance. A CI pass on another SHA/repository is not Evidence for this subject.

## 6. Evidence, selection and acceptance

Evidence separates contributor report, machine observation, GitHub CI observation and human review. A server service account signing a report does not make contributor output trusted CI. CI observations require configured provider/repository identity, exact head, check/workflow identity, conclusions and freshness/revocation policy; API transport verification alone does not certify test adequacy. Existing source self-reported stays self-reported.

Coverage maps stable criterion IDs to immutable Evidence IDs with `pass|fail|inconclusive|missing`. Criterion pass requires actual result plus permitted provenance policy. Default: at least one relevant record per required criterion, no unresolved fail/inconclusive/missing, current subject and requirements. Waived is an acceptance-side projection, never a field/Decision ID inside the sealed coverage. review.decide atomically creates criterion-waiver Decisions and the acceptance Decision under one operationId, with targetType criterion-waiver, targetId equal to the scoped criterion ID, targetDigest equal to the submission digest; the acceptance projection resolves those siblings by operationId. A human waiver needs reason and exact criterion/submission, and only for criteria explicitly declared waivable in the approved revision. Unwaivable safety constraints never waive. No count/exit0 shortcut. New contradictory Evidence while a submission is under review blocks acceptance. Recovery requires contributor withdrawal or human request-changes/rejection, then a successor Attempt with supersedesAttemptId, fresh Evidence and a new submission. A sealed Attempt cannot resubmit; explicit revalidation can reuse the same commit in a new subject. Appended Evidence never edits the old snapshot. Contradiction after acceptance appends an attention incident; historical acceptance is retained, current Flow submission eligibility is blocked until a new human-reviewed remediation Intent/requirement amendment resolves it.

Agent submits a ReviewSubmission; authorized human selects an Attempt (if several) and separately accepts/rejects/requests changes. These decisions can be one explicit UI transaction only when both consequences and exact subject shown, but remain separate audit records. Intent acceptance transaction checks current authority, revision, selected submission, coverage, no unsettled execution and expected versions. Flow acceptance checks all required Intent decisions and aggregate manifest. No automatic final acceptance on agent success, CI pass or PR merge. Product acceptance does not publish or approve a GitHub PR.

Knowledge follow-up must be either linked proposal(s), or explicit `no-update-required` with reason. It does not fabricate wiki verification. Product owner may accept work with visible pending nonblocking knowledge proposals only if approved policy permits; required blocking knowledge criteria still gate acceptance. Machine tool Allow once/Deny is unrelated to these Decisions.

## 7. Authorization and storage

Project authorization reuses current principal scopes. Initial implementation uses existing operator/reviewer as human reviewers, contributors as permitted existing agent/human principals; never invent new team ACL guarantees without implementing them. Named per-member permissions are additive later. Every read is scoped, including nested IDs, events, artifact details and cached observations. Revocation checked on each mutation/long job before privileged effect; agent cannot select/accept/waive/approve amendments. A machine principal may report only its bound run facts, not create human or arbitrary project decisions. Session controller role alone confers no human work-review role.

Use additive tables in the existing Hub SQLite database. The candidate represents Flow/Intent/Attempt/revisions/context/subjects/Evidence/submissions/Decisions/amendments as schema-closed typed payloads in `hub_work_records` keyed by project+ID, following the existing remote repository payload pattern. Dedicated tables hold `hub_work_events`, `hub_work_operations`, `hub_work_outbox`, `hub_work_documents`, `hub_work_conversions`, `hub_work_legacy_previews`, `hub_work_execution_reservations`, `hub_work_git_observations`, `hub_work_observation_generations`, `hub_work_observation_jobs` and `hub_work_settings`. This physical mapping replaces the original per-entity-table sketch; entity relationships remain mandatory transactional domain guards, not arbitrary JSON insertion. Indexed project+ID and unique `(projectId,runId)` where present, `(actorId,projectId,operationId)`, `(projectId,eventSequence)`. Composite parent foreign keys or equivalent validated transaction guards prevent cross-project joins. Flow projection and version are mutable; content rows/submissions/decisions/events append-only at application level. Single transaction covers operation receipt, state, event and outbox. Bounded atomic outbox claiming supports restart; retry never runs model/tools or repeats a human Decision.

Version1 defaults (configurable only by administrator, reported in diagnostics): 64KiB JSON mutation excluding separately bounded attachments; 100 artifacts/subject; 256 context entries/snapshot; 200 criteria/revision; 1000 events/page and page byte cap1MiB (whichever first); 64KiB report; Evidence excerpts32KiB; optional attachment1MiB, project retained attachment budget100MiB; return explicit quota error before metadata acceptance. IDs/digests/relations still retained. No full repo snapshots, node_modules, Docker volumes, env or hidden reasoning. Retention can expire raw optional logs after30days; before admitting a reference, store sufficient bounded immutable digest/provenance/summary for its role. Acceptance-required raw attachment cannot be deleted while referenced without explicit archival policy preserving retrievability; an unavailable artifact is visible and never considered newly verified. Backup includes work DB and retained attachments; caches rebuild, decisions do not.

## 8. API, adapters and UI

Proposed namespace `/hub/work/v1/projects/{projectId}`; exact routes/commands/errors in [metadata protocol](metadata-protocol.md). This is a new metadata API, not an incompatible reinterpretation of machine-v2 or legacy Hub-v1. CLI/MCP additions route to same application service; agent-facing tools expose no protected human operations. Future commands are not installed by these docs.

Overview aggregates canonical pending review/questions separately. Decision in Flow view updates the same request in Overview through project event cursor. Global/unfiltered views require project authorization per item and never use a cursor from another project. Session/run detail link opens existing execution UI. Designer can build fixtures first; implemented UI consumes projections, not independent work lifecycle logic.

### State × event matrix

| State | Navigate/project switch | Mutation/decision | Refresh/reconnect |
|---|---|---|---|
| loading | cancel/ignore old response, clear incompatible selection | disabled | bounded retry |
| empty | clear scoped empty guidance | permitted create only | stay empty until canonical data |
| loaded | scoped links preserve entity IDs and drafts per project | send exact versions/digests/key, busy visible | update projection, preserve drafts |
| stale/conflict | retain original draft under original project | refuse stale mutation; explicit rebase/new submission | fetch latest, show what changed |
| pending unknown outcome | retain operation ID | no duplicate fresh-key action | query receipt/retry original payload |
| observer/revoked | remove private/new authority data as appropriate | disabled UI AND server refusal | recheck identity; no implicit takeover |
| offline | keep clearly marked last known data | work decision not queued as new authority | resync cursor then revalidate actions |
| amended requirements | show old pins/history and current difference | block incompatible start/acceptance | explicit human amendment and fresh-Attempt workflow |

## 9. Acceptance criteria

Every AC Verification: judged. Implementers must supply executable tests/evidence named in [plan](plan.md); judged means owner evaluates coverage, not permission to skip tests.

- AC1: one Flow/Intent and two human/agent/manual Attempts are represented without fabricating session or code upload; all project relationships enforced. Verification: judged.
- AC2: exact immutable requirement/context versions are retrievable; start refuses missing required content, amendment drift and stale expected versions. Verification: judged.
- AC3: run links attach only verified exact existing execution, never duplicate/reassign history or grant new authority; multi-turn Attempt and zero-run manual Attempt work. Verification: judged.
- AC4: immutable commit/document subjects work without CodeRevision; mutable PR-head observations and unavailable/wrong-repository objects remain explicit. Verification: judged.
- AC5: Evidence coverage handles pass/fail/inconclusive/missing and authorized exact waivers; source trust/criterion/subject mismatch refuses. Verification: judged.
- AC6: only authorized human selects/accepts/waives/approves requirements; direct agent/machine API and cross-project misuse refuse. Verification: judged.
- AC7: immutable ReviewSubmission/Decision survives later reports, context edits and changed PR heads; stale acceptance cannot silently apply. Verification: judged.
- AC8: response loss, restart, duplicate/reordered metadata and concurrent reviewer races yield one canonical decision/event and visible conflicts. Verification: judged.
- AC9: known/unknown cancellation and late results cannot produce fake stopped/submitted/accepted state; physical leases untouched by work-state changes. Verification: judged.
- AC10: optional Git observation refreshes freshness and links actual PR/commit/CI state without push/merge or automatic product acceptance. Verification: judged.
- AC11: linked knowledge proposals/no-update reasons remain separate from content verification and product acceptance. Verification: judged.
- AC12: legacy v1 and frozen machine-v2 regressions pass; conversion eligibility, dry-run, backup and old-writer refusal are tested without invented Attempts. Verification: judged.
- AC13: HTTP/CLI/MCP share same state/auth invariants; agent tool surface excludes human Decisions; no false installed command claims. Verification: judged.
- AC14: real RU/EN375px browser journey and state matrix preserve identity/drafts and show distinct actions/provenance. Verification: judged.
- AC15: quota/redaction/retention/backup/restore failures preserve accepted subject meaning; no secrets/environment/source upload required. Verification: judged.
- AC16: exact candidate docs/API/schema/migration and independent verification/review delivered for owner review; no self-acceptance/deploy/publication. Verification: judged.
