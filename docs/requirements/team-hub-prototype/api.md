# Team Hub prototype API v1

Canonical types: `src/hub/contracts.ts`. All paths below are relative to `/hub/v1`. JSON keys use camelCase; SHA256 digest strings are lowercase hex. IDs are opaque. Dates are ISO strings. A successful JSON mutation returns HTTP 200 or 201; read returns 200. Errors return `{error:{code,message}}` with 400 validation, 401 missing/invalid identity, 403 role/origin denial, 404 unknown entity, 409 stale version/digest/base/idempotency conflict, 413 quota failure.

Every JSON mutation requires `Idempotency-Key`, scoped to authenticated principal + method + path. An identical payload/key repeats the original status/body without a duplicate event; a changed payload is 409. Login/logout are authentication exceptions. Check idempotency replay before mutable-version validation. Mutable aggregates require the expected version specified below; create operations have no previous version.

Bearer tokens derive the actor server-side; caller actor/role fields never confer authority. `POST /session {token}` returns `{principal}` plus HttpOnly SameSite cookie; `GET /session` returns `{principal}`; `DELETE /session` clears it. Cookie mutation requires matching `Origin`; bearer requests do not require Origin. Token strings never appear in response/events. Unauthenticated `/healthz` returns `{ok:true}` and no private data.

## Projects and documents

| Method/path | Request | Response |
|---|---|---|
| GET /projects | — | `{projects: Project[]}` |
| POST /projects | `{name}` | `Project` |
| GET /projects/:p | — | `Project` |
| POST /projects/:p/import | `ImportRequest` | `ImportResponse` |
| GET /projects/:p/documents | — | `{documents: HubDocument[]}` |
| GET /projects/:p/documents/:d | — | `HubDocument` |
| GET /projects/:p/context?after=N | optional numeric cursor | `ContextResponse` |

Projects start `version:1`, `lineVersion:0`, `contextRevision:0`, `lineRevisionId:null`. Import compares project `expectedVersion`, increments project version once, and contextRevision when documents change. New paths become version 1 unreviewed documents. Identical content is unchanged. Changed existing paths produce pending proposals without overwriting canonical content. Path identity is stable per project; duplicate/unsafe paths are rejected. Context `after` uses contextRevision: omitted/unknown/out-of-range cursor gets fullSnapshot true; a valid cursor receives changed documents and deletion IDs, and always the entire current manifest.

## Proposals

| Method/path | Request | Response |
|---|---|---|
| GET /projects/:p/proposals | — | `{proposals: Proposal[]}` |
| POST /projects/:p/proposals | `CreateProposalRequest` | `Proposal` |
| POST /projects/:p/proposals/:id/review | `ReviewProposalRequest` | `Proposal` |

Only a human reviews. Proposal starts pending/version 1. Review requires the exact proposal contentDigest, expected proposal version, and unchanged canonical document baseVersion for acceptance. Accepted content creates next canonical document version with acceptedBy/At and a receipt; no Markdown status field grants approval. Rejection preserves canonical content. A second fresh-key review of a decided proposal conflicts.

## Flows and evidence

| Method/path | Request | Response |
|---|---|---|
| GET /projects/:p/flows | — | `{flows: HubFlow[]}` |
| POST /projects/:p/flows | `CreateFlowRequest` | `HubFlow` |
| GET /projects/:p/flows/:f | — | `HubFlow` |
| POST /projects/:p/flows/:f/freeze | `{expectedVersion}` | `HubFlow` |
| POST /projects/:p/flows/:f/start | `{expectedVersion}` | `HubFlow` |
| POST /projects/:p/flows/:f/submit-for-review | `{expectedVersion,subjectRevisionId}` | `HubFlow` |
| POST /projects/:p/flows/:f/accept | `{expectedVersion,subjectRevisionId,acknowledgeSelfReportedEvidence:true}` | `HubFlow` |
| GET /projects/:p/flows/:f/evidence | — | `{evidence: Evidence[]}` |
| POST /projects/:p/flows/:f/evidence | `CreateEvidenceRequest` | `Evidence` |

Create pins specContentDigest and criteria in initializing/version 1. Human freeze checks the pinned spec is still current and moves to ready. Start moves ready→in-progress. Evidence is immutable and always labeled self-reported, with server actor. Submit requires at least one zero-exit report for the exact project revision, all reports for that subject successful, and a still-current pinned spec; it moves in-progress→implemented and pins subjectRevisionId. Human accept requires implemented, the same exact subject, still-current pinned spec, explicit self-report acknowledgement, successful evidence, and writes receipt/acceptedBy/At while advancing through completing→done atomically. No arbitrary status setter exists. Evidence for another project is rejected. Every successful action increments Flow version once.

## Code and delivery

| Method/path | Request | Response |
|---|---|---|
| GET /projects/:p/revisions | — | `{revisions: CodeRevision[]}` |
| POST /projects/:p/revisions | `CreateRevisionRequest` | `CodeRevision` |
| GET /projects/:p/revisions/:r | — | `CodeRevision` |
| GET /projects/:p/revisions/:r/changes?from=:base | same-project base optional | `{baseRevisionId:string|null,revisionId:string,changes:RevisionChange[]}` |
| POST /projects/:p/line | `{revisionId,expectedVersion}` | `Project` |
| GET /projects/:p/deliveries | — | `{deliveries: Delivery[]}` |
| POST /projects/:p/deliveries | `CreateDeliveryRequest` | `Delivery` |
| GET /projects/:p/events?after=N | numeric sequence cursor | `{events: HubEvent[],cursor:number}` |

Revision `files` is the complete immutable tree (base64 bytes, mode, SHA256 content digest), sorted by path; upload changes are incremental. Empty tree/deletion is supported. Missing base rejects; deleted entries have no content. Reject traversal/absolute/.git paths, symlink/submodule modes, duplicate paths, malformed base64 and over-quota input. Line selection is human only and compares `expectedVersion` to **lineVersion**, incrementing it once; revision must belong to project. Delivery is human only, must match selected revision and expectedLineVersion, and calls injected/default `GitDeliveryAdapter` from contracts. Adapter operationId equals durable delivery ID and retries reconcile a managed unique branch. Conflict/failed results remain visible; only published has actual branch/commit/tree receipt. Git subprocess details live in adapter; no generic remote shell.

Limits are bounded and enforced server-side: 500 documents/import, 1 MiB/document, 2 MiB evidence output before redaction/truncation, 5,000 changes/revision, 20 MiB decoded snapshot and 32 MiB HTTP JSON body. Events contain metadata, never raw tokens. Human operator and reviewer share protected review authority in this prototype. Prototype canonical Flows are isolated from legacy local Flow records.

## Optional Cloudflare SSO and review bundles

The SSO extension adds independently verified browser identity, explicit reloadable role mapping and bounded session lifetime. Its endpoint and compatibility details are documented in the [Cloudflare SSO integration contract](../hub-cloudflare-sso/README.md#http-integration-contract).

Revision requests may carry `purpose: "review-bundle"` for a review-only patch package. Missing purpose preserves the existing complete-snapshot behavior. Review bundles are valid Evidence subjects but cannot be selected as the integration line, published through Git delivery, applied by connector pull, used as snapshot submission bases, or reconciled as delivery receipts. This marker is enforced by the updated server and connector; old clients must not apply bundles by ID.

## React frontend revision metadata projection

`GET /projects/:p/revisions?summary=1` returns `{revisions: CodeRevisionSummary[]}`: existing revision metadata and `fileCount`, without `files` or base64 code bytes. The default list and `GET /projects/:p/revisions/:r` remain unchanged. The React frontend uses summaries for overview counts, pickers and lists, and loads a full tree only when inspecting a selected revision.
