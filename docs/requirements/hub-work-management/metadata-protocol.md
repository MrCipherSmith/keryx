# Work metadata protocol and application surface
Version: 0.2.0

Status: proposed, not implemented. Base: `/hub/work/v1/projects/{p}`. All routes require existing Hub authentication; cookie mutations validate configured Origin. Server derives actor and project permissions. No untrusted document/agent output is an instruction or authority.

## HTTP envelope and idempotency

Every mutation is POST with `Idempotency-Key` (opaque operation ID) and body `{operationId, expectedVersions, command, payload}` matching [command schema](schemas/command.schema.json). Header and operationId must match. Keys unique by principal+project+operationId; canonical payload digest includes command/path/preconditions. After current authentication and project-read authorization, same-key/same-body returns the original actor-scoped committed result before current-version checks; revoked project access returns403 without revealing the receipt. Replay never repeats privileged effects. changed payload refuses409. ExpectedVersions has an entry for every changed/read-to-decide aggregate (Flow, Intent, Attempt or conversion source); immutable digest pins still required. Reject missing required guards even if schema permits variable map keys. Idempotency failures never overwrite original operation.

Response `{operationId, entities, eventCursor, receiptId}` includes only authorized safe projections, schema-validated domain records. GET `/operations/{operationId}` is owner/principal-scoped (reviewer cannot enumerate other actors' operation IDs). An old successful receipt is historical evidence, not authorization to run another action. Pending outcome returns202 with no fake committed status; client polls boundedly or resyncs. Error `{error:{code,message,retryable,currentVersions?},operationId?}` never secrets/stacks. 400 schema/invalid-transition,401 unauthenticated,403 forbidden,404 not-found,409 version-conflict/subject-drift/requirements-drift/idempotency-conflict/execution-unsettled,413 quota,422 coverage-incomplete/unresolved-context,503 observation-unavailable. Cross-project nested references use404 without private metadata.

## Read routes

| GET suffix | Meaning |
|---|---|
| `/capabilities` | protocol version, enabled flag, current actor allowedCommands, quotas and feature flags; never credentials |
| `/snapshot?cursor=&limit=` | authorized immutable read snapshot pages plus cursorN; see resync rules below |
| `/amendments/{id}` | exact AmendmentManifest, pending/resolved state and resolution Decision IDs |
| `/flows?afterId=&limit=` | WorkFlow list plus legacy references, no full histories |
| `/flows/{f}` | flow/current revision, Intents, acceptance summary and action eligibility |
| `/flows/{f}/revisions/{r}` | exact immutable approved/proposed revision |
| `/intents/{i}` and `/intents/{i}/revisions/{r}` | scoped deliverable and exact revision |
| `/intents/{i}/attempts?afterId=&limit=` | bounded attempts |
| `/attempts/{a}` | current work state, exact pins and link metadata |
| `/contexts/{c}`, `/subjects/{s}`, `/submissions/{r}`, `/flow-submissions/{r}` | exact immutable manifests and authorized content refs |
| `/attempts/{a}/evidence?afterId=&limit=` | metadata/excerpts, no unbounded raw logs |
| `/decisions?targetId=&afterId=&limit=` | immutable decision history |
| `/events?after=&limit=` | ordered project work events; limit≤1000 and byte cap1MiB |
| `/attention?afterId=&limit=` | current actionable projection, not a second queue of mutable requests |
| `/flows/{f}/acceptance-preview` | current aggregate acceptance manifest/digest at observed Flow version; no state change |
| `/operations/{operationId}` | original actor's committed/pending operation outcome |

Read pages default50/max200 except event max1000; cursor is opaque/project-bound. Event after gap/pruned cursor returns `resync-required` plus authorized snapshot cursor, never silently skips missing state. Work API uses its own work event cursor; do not compare it numerically with existing document contextRevision or machine sessionEventSeq. Snapshot response is a consistent DB read at cursorN, then client applies events>N. UI global views keep separate cursor per project.

## Mutations

Suffix `/commands` handles domain commands below; a single domain service is used by HTTP, planned CLI and MCP. Entity refs are opaque IDs, not arbitrary filesystem paths/URLs. Closed payload variants are in schema; parent links and current-state validation are transactional.

| command | Payload / guards | Permitted actor |
|---|---|---|
| `flow.create` | title/problem/outcome/owner/spec ref/criteria; creates explicit draft revision | contributor |
| `flow.start` | flowId, exact approved revision digest; ready only, CAS Flow | contributor |
| `context.create` | exact Flow/Intent revisions, closed context entries and Git base refs; server resolves/checks claims | contributor |
| `revision.propose` | Flow or Intent ID and full proposed semantic fields, server assigns revision/digest; no approval | contributor |
| `legacy.preview` | legacyFlowId, exact source version; bounded dry-run/conversion receipt, no source mutation | authorized human |
| `intent.create` | flowId, title/deliverable/owner/required/criteria; draft only | contributor |
| `requirements.approve` | target revision ID/digest, parent Flow revision; CAS parent+target | authorized human |
| `requirements.amend` | flowId, sourceFlowRevisionId, affectedIntentIds, exact replacement entries with target/revision/digest, reason; approved proposal only changes pending guards, not old pins | authorized human |
| `requirements.resolve-amendment` | amendmentId, manifestDigest, approve/withdraw and reason | authorized human |
| `attempt.create` | approved intentRevisionId, contextSnapshotId, accountable participant, method, optional predecessor | contributor |
| `attempt.start` | attemptId and exact context/requirement digests; local required refs resolvable | contributor |
| `attempt.report` | attemptId, progress/blocked/failed/cancel-request/cancel-confirmed, bounded report; confirmed requires all linked known terminal or zero linked runs | owner/contributor within scope |
| `execution.bind` | attemptId, exact session/run/turn/checkout/machine refs plus association observation | authenticated original operator / verified bridge for own run |
| `subject.create` | attemptId, bounded immutable report/artifact manifest | contributor |
| `evidence.record` | attemptId, subjectId/digest, criterion refs, results and claimed source | contributor; server sets actual provenance |
| `attempt.submit` | attemptId, subjectId/digest, exact Evidence IDs and coverage map, knowledge follow-up; seals ReviewSubmission | contributor |
| `attempt.withdraw` | attemptId, submissionId/digest, reason; no replacement edits | contributor |
| `attempt.select` | intentId, attemptId, exact submissionId/digest, reason | authorized human |
| `review.decide` | Intent or Flow target, exact submission/manifest digest, accept/reject/request-changes, reason, optional permitted exact waivers | authorized human |
| `flow.submit` | Flow revision and exact accepted Intent Decision set, digest | contributor; server constructs/seals aggregate manifest |
| `work.cancel` | Flow/Intent, reason, expected versions; rejects uncertain execution without explicit cancel coordination | authorized human |
| `legacy.convert` | legacyFlowId, sourceVersion, dryRun receipt/digest, explicit new Intent definition | authorized human |

`context.create` and `revision.propose` use the same `/commands` envelope with exact write projections in command schema; there is no generic record insertion. Server rejects supplied actor/version/digest/state. Flow acceptance-preview is read-only; `flow.submit` checks its recomputed manifest/digest and CASes every accepted Intent decision dependency. `legacy.preview` returns a durable bounded dry-run receipt tied to source version, actor and project; convert revalidates all eligibility and never trusts a stale preview. No public POST of a Decision or Evidence trust label exists.

## Authority and work execution binding

For browser-dispatched work use one server transaction/outbox intent that names Attempt and original existing human execution request. Adapter invokes existing v2 admission with that principal, checks pinned FlowAssociation equals approved work pins, and records resulting run ID before publishing binding as confirmed. No machine-v2 new Attempt field or forged caller authority. If legacy v2 creation cannot transactionally return a run ID, persist correlation/reservation and withhold new managed dispatch until reconciliation; never retry with a fresh execution command. A failure before execution allocation can safely abort binding; ambiguous allocation blocks retry.

For existing/manual runs, bind only after current authorized lookup proves run/project/session/turn and original work association. If association lacks new context proof, record observation `unverified`; cannot satisfy policy requiring observed runtime consumption. No bind to another participant's foreign machine run based only on knowing its ID. A run already bound elsewhere returns409. Start/submit of work-domain Attempt does not itself invoke model/tools. Existing v2 controller/approval/recovery checks are never bypassed by work owner/reviewer status.

Machine results may append observations/Evidence for its exact bound run through adapter, with immutable operation ID derived from run/result receipt; machine cannot assign trusted CI or accept work. Existing review-bundle upload stays unchanged; metadata adapter can link that legacy revision. New Git-native/manual subject submission is a separate pathway; do not require legacy `ResultUpload` to understand commit refs.

## Git/CI observation and metadata sync

Repository settings declare provider, stable repository ID, allowed hosts/object format and expected verification policy. Observer is an opt-in read service; current profile/API account remains local unless deliberately configured server credential exists. Manual artifact starts with contributor provenance. Resolver checks canonical repository identity + object accessibility through permitted API/read adapter and records timestamp/OID. No arbitrary URL fetch, credential-bearing URL, direct local path, SSH launch or implicit admin connection.

Webhook delivery is only an observation trigger. Validate configured signature, deduplicate provider delivery ID and re-fetch relevant authoritative object; do not grant trust from payload author text. Periodic bounded reconciliation covers missing deliveries. Out-of-order older observation cannot roll current PR head back: compare fetched authoritative state/generation, not client clock ordering. CI observations identify exact subject SHA/repository/check and configured workflow trust policy. Changed head adds drift; does not mutate old ResultSubject or Decision. Unreachable ref => unavailable, not absent/deleted/unverified success. Force-push/deletion preserves old OID metadata and reveals availability separately.

Client outbox stores same operation ID/payload/versions with bounded retry/backoff outside Git/credentials. Offline queues progress observations only; protected acceptance/waivers never auto-execute after reconnection from an old UI click. Revalidate human role and exact current subject interactively. Project work events coalesce invalidations, then fetch canonical records; do not execute tool/work instructions from event content. Document context sync continues its existing revision namespace, with exact old versions fetchable via new immutable resolver where current API only supplies latest.

## Planned CLI/MCP

Planned CLI family `keryx hub work`: flow/intent/attempt show/create, context fetch, attempt start/report/submit, evidence add, events/watch, subject inspect. These names are design proposals, not commands present in0.4.0. Readonly MCP adds scoped work reads; contributor MCP may create/report/submit within rights. Do NOT expose requirement approval, selection, waiver or acceptance as agent tools. Human UI calls same domain via authenticated browser; no token in localStorage. Existing MCP namespace/tools remain compatible.

## Read response contract and bounded resync

All successful record reads return `{record, eventCursor}`; record validates against the relevant domain definition. Aggregate Flow/Intent/Attempt reads return `{records, actions, eventCursor}` with records drawn only from domain records, and actions as bounded `{command, allowed, reasonCode}` entries derived from current authority/state. Action hints confer no authority. Lists return `{records,nextCursor,eventCursor}` (records≤200); events return `{events,nextCursor}` validated by event schema with the stated limits. Null nextCursor means complete. Every route has project authorization before projection/receipt lookup; cross-project refs are404.

Capabilities returns `{protocolVersion:1,enabled,allowedCommands,limits,features}`. allowedCommands contains only known command names permitted to the current actor; limits use section7 administrator bounds; features has explicit booleans managedExecution/gitObserver/legacyConversion. Disabled returns enabled:false and no mutation commands. A detailed OpenAPI schema covering every aggregate projection/response/error and operation receipt is the M1 gate before production UI integration; these documentation JSON schemas are domain/command/event schemas, not a claim of a complete generated HTTP client.

Snapshot first GET without cursor creates a bounded consistent read snapshot token bound to project+principal+authorization generation+cursorN; pages return `{records,nextCursor,eventCursor:N}` in dependency order. Client stages all pages then atomically replaces its cache, preserving drafts separately, and fetches events>N. Token expires after five minutes; expiry410/resync-required discards staged pages and restarts. Revocation invalidates pages immediately. Snapshot includes all managed records and immutable referenced history needed by current active/reviewed work; historical pagination remains available through exact record routes. Server uses a bounded temporary snapshot export, never holds a SQLite write lock across browser requests; export cap20MiB/project, quota413 means use scoped views rather than silently omit records. Optional old history need not be cached globally. Events gaps invalidate the export and require restart. GET operations returns `{operationId,status:pending|committed,receiptId,result,eventCursor}` with nullable fields for pending; committed result is the same safe response as the original command. Conversion preview result is scoped to its original actor; AmendmentManifest is a project record and is readable by authorized reviewers without disclosing another actor's receipt.

Input provenance is closed: subject.create Git inputs contain only repositoryId/commitOid/treeOid/pullRequestNumber; context.create entries contain entryId/role/reference/required/contentDigest, and gitBases only repositoryId/commitOid. Supplying verification, observedAt, resolution or provenance is400, never silently normalized into trust. Server resolves references, hashes content and assigns claimed/observed states. A local-overlay must reference an exact authorized archived Hub document version (use existing document proposal/import); null reference stays unresolved and cannot satisfy required content. Runtime consumption can only come from the verified execution bridge, never context.create.

## Implemented candidate extensions

The generated OpenAPI is the exact executable projection contract. External eventCursor values are opaque HMAC tokens bound to principal/project, not internal event numbers. Commands return {operationId,entities,eventCursor,receiptId}. GET operations additionally distinguishes pending202 from committed outcomes. Provider observations use the separate closed observe envelope documented in observer.md.

GET /documents/{documentId}/versions/{version}?digest=<sha256> retrieves exact authorized archived content with its id/project/path/kind/version/contentDigest/content and eventCursor. Digest mismatch, wrong project and unavailable history return404 without latest fallback. Content is rehashed and bounded to1MiB. MCP hub_work_get_document_version and CLI document show --version --digest expose the same read boundary.

Native execution sidecar HTTP headers and current guarantees are documented in execution.md. The minimum writer activation marker and candidate limitations are documented in implementation-status.md.
