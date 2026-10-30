# Keryx Team Hub prototype — implementation specification

Date: 2026-10-25, Asia/Muscat. Authorization: user explicitly requested autonomous documentation, delegated implementation and a fully working prototype for server testing on 2026-10-26. Completion is a verified handoff, not an unsolicited PR/merge/deployment. Existing research: Keryx2 Page v0.12 and wiki-openspec-flow-research job. This spec freezes routine prototype choices under that authorization; no production-completeness claim.

## Outcome

One runnable self-hosted Hub, functional browser UI and local connector: create project, import existing OpenSpec/wiki, map a spec to a managed prototype Flow, submit/check code revisions locally, propose wiki corrections, approve an exact document revision as human, finish Flow only through a human gate, synchronize context across clone/worktrees, exchange code snapshots and publish one selected revision to a Git branch. Real application/Docker environment remain local.

## Architecture and bounded scope

- New isolated `src/hub/` module, Bun 1.3.14+ and built-in `bun:sqlite`, no new runtime packages. SQLite is a deliberate single-process prototype deviation from planned PostgreSQL; durable DB+Git volume, no multi-instance claims.
- Hub canonical project/Flow/revision/proposal records live server-side; legacy local `keryx flow` files are not a mirrored second authority and are not silently imported. Reuse existing Flow transition primitive where feasible, hashing/owner concepts and boundaries; do not mutate existing wiki/SAC lifecycle just to demo the new UI.
- Two separate principal classes: human operator/reviewer and agent. Distinct high-entropy environment bootstrap tokens; human browser exchanges token for HttpOnly SameSite session cookie, no token in localStorage. Bearer CLI auth; actor/role always server-derived. No OAuth/SSO in prototype.
- Named human-only operations: freeze normative Flow criteria, accept/reject exact wiki proposal, select integration line revision, authorize Git publication, final Flow acceptance. Agent can import/propose/submit evidence/revisions but cannot self-approve.
- Evidence imported by local connector is explicitly self-reported/agent-origin, never a claimed independent trusted PASS. Human final acceptance must explicitly acknowledge that provenance and exact code revision. No model execution is required to test the app; external agents can use CLI/API locally.
- No unrestricted server shell execution. The only server subprocess operations are argument-array Git operations in managed directories. Git creates a delivery branch; merge stays external/manual. Optional GitHub PR creation only with configured token and explicit human publication. No fabricated PR URL or merge status.
- MVP sources support regular tracked files (100644/100755), add/update/delete, binary-safe encoding, path containment, payload quotas. Reject unsafe paths, symlinks/submodules until implemented; do not silently omit source entries. Secrets/config not automatically imported from ignored/untracked files.

## Files and ownership for parallel workers

1. Foundation/tests worker first: `src/hub/contracts.ts`, contract tests, server acceptance tests in `src/hub/server.test.ts`; document the exact wire contract in `docs/requirements/team-hub-prototype/api.md`. No implementation before meaningful RED tests.
2. Server worker: `src/hub/store.ts`, `domain.ts`, `server.ts`, `main.ts`, their implementation tests. API entry: `createHubApplication(config) -> { fetch(Request): Promise<Response>, close(): void }`; `startHub` adapter. Config has dataDir/operatorToken/agentToken/optional reviewerToken/host/port. No web or connector edits.
3. Web worker: `src/hub/web.ts` only plus browser test fixture if needed. Export `webAssets: Record<string,{contentType:string,body:string}>` for `/`, `/app.js`, `/styles.css`. No build framework; actual reactive navigation/forms/error states and safe DOM text rendering. No inline untrusted HTML.
4. Connector/Git worker: `src/hub/connector.ts`, `git-delivery.ts`, `src/commands/hub.ts`, registration in `src/cli.ts` and focused tests; scripts/deployment docs after code. Coordinate exact interfaces before implementing. Do not change unrelated CLI behavior.

## Core API (paths relative to /hub/v1)

All JSON mutations use `Idempotency-Key` plus expectedVersion for mutable aggregates; reuse key with changed payload conflicts. Error response `{error:{code,message}}`, no stack/secret leakage. Body/path validation, project association and role checks before mutation. Reads require auth, `/healthz` is minimal unauthenticated. Cookie-authenticated mutation validates Origin; API bearer requests do not use ambient browser authority.

- `POST /session {token}`; `GET /session`; `DELETE /session`.
- `GET/POST /projects`; `GET /projects/:p`.
- `POST /projects/:p/import {sourceRevision,documents:[{path,kind:wiki|spec,content}]}`. Stable path identity; imported page is visibly unreviewed, never trust Markdown Status as human approval. Changed existing canonical doc becomes a proposal/conflict, not silent overwrite.
- `GET /projects/:p/documents`; `GET /projects/:p/documents/:d`; `GET /projects/:p/context?after=<revision>` returns current manifest and only changed/deleted documents, with explicit full-snapshot fallback.
- `POST /projects/:p/proposals {documentId,baseVersion,content,reason,sourceRevision?}`; `GET .../proposals`; `POST .../proposals/:id/review {decision:accepted|rejected,expectedVersion,contentDigest}` human only. Accept compares target base, reviewer-bound exact content digest; concurrent edit conflicts. Acceptance records actor/time/receipt; does not rewrite old proposal content.
- `GET/POST /projects/:p/flows {title,specDocumentId,criteria:string[]}`; flow criteria pin spec content digest. Human freeze; start; submit-for-review; human accept exact subject with acknowledgment of self-reported evidence. Use familiar statuses initializing/ready/in-progress/implemented/completing/done and separate approval role. No direct arbitrary status setter.
- `POST .../flows/:f/evidence {subjectRevisionId,checkId,command,exitCode,output}`; server marks actor/source trust, stores bounded/redacted report. Code revision must belong to same project. `GET` evidence and events.
- `POST /projects/:p/revisions {baseRevisionId:null|string,gitBaseSha,message,changes:[{path,contentBase64?,mode?:100644|100755,deleted?:true}]}`. Immutable full resulting tree manifest server-side, transfer changes only after initial upload, SHA256 digests computed server-side.
- `GET /projects/:p/revisions`; `GET .../revisions/:r`; `GET .../revisions/:r/changes?from=<id>`.
- `POST /projects/:p/line {revisionId,expectedVersion}` human only; GET project includes line revision/version.
- `POST /projects/:p/deliveries {revisionId,remoteUrl,baseBranch,expectedLineVersion}` human only with idempotency key. Git implementation returns real commit/branch, optional real PR; Git conflicts remain visible, no false success. GET deliveries.
- `GET /projects/:p/events?after=N` durable audit/change cursor (bounded polling acceptable; UI must not claim realtime SSE if not implemented).

Foundation worker freezes names/types and may refine detailed route action shapes in api.md. All workers use that file as source, no independent guessed API.

## Connector UX and local state

`keryx hub serve` starts the Hub; `keryx hub connect --url --project --token-env` binds current checkout without committing credentials. Default credentials from KERYX_HUB_TOKEN env or separately permission-restricted user config, never a tracked binding field.

`hub import` reads existing openspec changes/specs and wiki with bounded allowed paths, no installing/running OpenSpec. `hub sync` updates shared project cache once under XDG and generates .metaproject binding/index entries for each checkout/worktree. Do not overwrite existing wiki/index configuration silently: backup/preserve existing entry and add managed routing; same projectId, distinct checkoutId. Recognize Git common-dir, but never attach unrelated clone by remote alone.

`hub submit` snapshots tracked regular files, compares with server base and uploads changed/deleted bytes. `hub pull` defaults to preview, `--apply` only when local state can be protected; write recovery checkpoint before mutation and refuse dirty/untracked collisions or active/unresolved Git state instead of destroying work. Partial apply has a journal and recovery path or restore; do not claim cross-file transaction.

Post-publication Git synchronization is conservative: fetch only by default, verify receipt/commit/tree mapping, refuse ambiguous dirty/staged/diverged automatic reanchor. Full arbitrary dirty rebase may remain a documented limit; the prototype MUST preserve work rather than fake automatic success. Normal manual Git remains usable.

Git adapter entry contract negotiated in contracts.ts: managed per-project mirror/cache, make candidate tree from source snapshot on gitBaseSha, apply its delta onto current remote base with actual three-way Git semantics, fail on conflict, create one clean commit, push only a unique managed branch. Repeated operation reconciles same branch/operation ID. Never force-push base/user branches. Argument arrays/timeouts, no credential logs. Test against temporary local bare remotes; actual external GitHub publication not performed during development.

## UI state × event matrix

| State | Selection/navigation | Submit/review | Refresh/retry |
|---|---|---|---|
| Unauthenticated | Login form; no private data | Only login allowed | Show inline authentication failure |
| Loading project | Cancel/ignore stale response | Disabled | Retry without losing selected project |
| Loaded | Correct project resources, selected card | Busy action, preserve drafts | Reload current data, no duplicate mutation |
| Empty | Create/import guidance | Working forms, not fake populated cards | Remains explicit empty |
| Version conflict | Preserve entered proposal/review text | Show actual conflict, no optimistic accepted | Reload latest base; explicit new proposal |
| Network failure | Keep last data visibly stale | Error visible, no false success | Retry same operation key if outcome unknown |
| Agent identity | Read/propose views | Human actions absent and server-forbidden | No UI-only permission guarantee |

## Acceptance and verification

- AC1: fresh server starts with explicit bootstrap secrets; auth separation persists across restart. Unauthenticated and agent approval/acceptance fail observably.
- AC2: two human principals can create/import/read a project; wiki/spec contents survive process restart. Imported accepted strings never create protected approval.
- AC3: OpenSpec change import → pinned Flow criteria → local evidence → exact wiki proposal review → human Flow accept works; stale digest/base/evidence subject is refused.
- AC4: code submit initial + incremental update/delete, cross-checkout pull preview/apply and conflict preserve local work; sibling worktrees share project context but have distinct IDs.
- AC5: Git delivery to a temporary bare remote publishes actual selected content on managed branch; target changes/conflicts and retry/idempotency are tested; base/user branches unchanged.
- AC6: actual browser journey login/create/import/board/proposal/review/error states works, browser console clean; server blocks agent self-acceptance even direct API calls.
- AC7: focused tests/typecheck/lint pass; required whole-project checks run or existing baseline failures are precisely separated. Restart and two-client scenarios use real HTTP and temporary filesystem/DB/Git.
- AC8: deployable bundle, Dockerfile/compose, env example, Linux direct-run instructions, backup/restore, smoke script and reproducible tomorrow test checklist exist. No server deployment or external push without target/authorization.

Tests use bun:test and real temporary SQLite/files/Git; don't mock internal domain invariants. Browser automation uses available Playwright/browser skill. Record actual executed checks, not planned checkboxes. Security-sensitive negative paths are required, not implementation-mirroring tests.

## Handoff

Deliver source branch/worktree, spec/API/runbook, release archive/checksum if build succeeds, actual test results and known prototype limits. Human final acceptance remains with user. No unsolicited PR/merge. If no completion selection arrives, the user's request to test a prototype implies verified handoff; managed implementation Flow remains open under current CLI semantics rather than fabricated done.
