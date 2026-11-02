STATUS: DONE

# Independent native managed-message UI review

Verdict: APPROVE for the third UI increment. No actionable blocker or major found. This review supplements the second-increment approval; it does not claim physical LLM execution or another live-browser run.

## Stage 1 — boundary and operation correctness

Read `native-selection.tsx`, the changed MessageComposer, client/header transport, remote mutation wrapper and remote mutation hook; checked the actual work execution reservation/admission guards and existing controller lease logic.

- Managed Attempt selection is explicit. It requires an enabled managed-execution capability, the current human operator, the same project and current controller actor/lease. Eligible Attempts must be started, pinned to approved Flow/Intent revisions and the exact resolved context, without an affected pending amendment or unknown execution outcome.
- Confirmation is bound to the selected Attempt version and principal/scope/project/session. Attempt version changes make the selection stale; refreshing its pins resets confirmation. Switching mode or identity/session/project resets the selection. Snapshot fetching temporarily prevents dispatch.
- The body keeps the existing native message schema. Managed headers are attached only to POST native-message paths, in a pair, with the frozen Attempt ID/version. The wrapper refuses a legacy Flow association or non-message endpoint. Explicit ad-hoc wire consent remains required; changing work modes clears consent rather than silently converting a legacy association.
- The original message body, target path, raw idempotency key, paired managed headers and submitted-draft reference are captured once in a separately scoped unresolved operation. Unknown retry reuses that capture; subsequent text or selection edits cannot replace the original request. A second new submission is blocked while unresolved. Definitive refusal permits correction; uncertain network/server results retain the original operation.
- Controller inactivity disables initial send and retry. Backend reserve requires the current original authorized human operator, exact Attempt CAS and work/context pins; before-admission authorization and controller behavior remain server-owned. UI hints confer no authority.
- In-flight callbacks use auth generation checks. Original draft setters remain scoped to the captured session; later completion cannot clear an edited draft because clearing compares the original reference. The unresolved store is keyed by principal/project/session/scope. Existing auth-loss flow clears drafts and aborts requests.
- Normal v2 calls keep their original wrapper signature and body. Optional transport metadata is supplied only when a managed submission captures it; no machine JSON extension or post-hoc execution-link fabrication was introduced.

## Stage 2 — UI and regression checks

The picker exposes Flow/Intent revision IDs and digests, Attempt ID/version, context ID/digest and explicit unverified-runtime wording before confirmation. Stale selection and uncertain outcome are visible; unknown retry explicitly names the retained operation/Attempt rather than looking like a new send. Existing accessible Field/Select/checkbox/Button controls are used.

Executed:

- Native-message/controller/client/draft-owned controls batch: 5 files, 14 tests passed. This includes all six new native guard tests. Command: `npm --prefix apps/hub-web test -- managed-native-message remote-client remote-controller remote-draft-renewal remote-owned-controls`. Log: `.metaproject/data/gdctx/raw/2026-11-01T11-52-39-696Z-293b85_run.log`.
- Client/auth/recovery/renewal/draft/remote regression batch: 7 files, 36 tests passed. Command: `npm --prefix apps/hub-web test -- client.case remote-recovery remote-renewal remote.case auth.case drafts.case`. Log: `.metaproject/data/gdctx/raw/2026-11-01T11-52-48-796Z-8ae467_run.log`.
- Direct client-only filter: 2 files, 12 tests passed (the current client suites contain 12, not 14). Log: `.metaproject/data/gdctx/raw/2026-11-01T11-53-27-828Z-d855aa_run.log`.

These batches overlap; counts are not added into a claimed unique total. Tests verify explicit pin/consent requirements, unchanged body shape, exact paired headers and retry identity, stale-version refresh/reconfirmation, project/session isolation and role/transport denials, plus existing client and controller behavior.

No source edits, new tests, installs, commits, deployment, real credentials or fixture lifecycle changes. Only this report was written. Live-browser synthetic admission evidence is owned by the root task and was not independently repeated here.

Routing audit: graph_used: yes in the initial review (known stale and not relied on for current proof); wiki_used: yes in the initial review (no managed-work page); ctx_used: yes; raw_rg_used: no. Local frontend/logic/testing guidance reused from the first pass. Review is bounded to this native UI delta and its direct consumers.
