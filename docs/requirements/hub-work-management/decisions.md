# Evidence and decisions
Version: 0.2.0

Status: draft. Distinguish owner decisions from recommended specification choices.

## Confirmed by owner discussion

- D1: primary pain is shared context, work history and acceptance; Hub serves collaborative product/project work, not only one operator's agent cockpit.
- D2: defer code exchange/integration through Hub. Git/GitHub retain code, branches, PRs, CI and merge.
- D3: preserve remote agents as an execution capability. One project has shared knowledge and multiple explicit machines/checkouts/worktrees.
- D4: keep human acceptance separate from agent completion. Overview concentrates actionable work; Machines, Flows, Knowledge and agent configuration remain separate sections.
- D5: current request authorizes documentation and a separate UI assignment; it does not authorize production changes or human-only Hub transitions.

## Source observations

Reviewed local Git objects from main0.4.1 and v0.4.0, without switching/resetting checkouts. Relevant source paths at that baseline:

- `src/hub/contracts.ts`: HubFlow has title/spec/criteria/status/selected CodeRevision, no distinct product Intent/Attempt types; Evidence requires subjectRevisionId and provenance self-reported.
- `src/hub/domain.ts`: v1 freeze/submit/accept checks spec digest, CodeRevision and Evidence; human acceptance records a receipt.
- `src/hub/remote-v2/model.ts`: RunRow binds project/machine/checkout/session/turn, command, FlowAssociation, ConfigSnapshot and observed execution outcome.
- `src/hub/remote-v2/results.ts`: terminal run result builds review-bundle CodeRevision and self-reported FlowEvidence or ad-hoc RunChecks. It preserves original pins and detects drift.
- `src/remote-control/generated/types.ts`, `src/session/host.ts`: existing session/controller/queue/approval lifecycle; do not equate it with product-work acceptance.
- v0.4.0 CHANGELOG: remote sessions beta plus machine enrollment/configure/readiness/recover, explicit human approvals, local execution and self-host distribution. Live physical multi-machine/providers/public Access remain owner verification items; unit/source presence is not proof of those trials.

Graph is stale and was used only for orientation; conclusions above derive from exact files/Git objects. ctx routing used; no bare rg/grep. Existing prototype review.md is a historical design review, not runtime certification.

## Recommended choices requiring owner review

- P1: Intent is a bounded deliverable within one Flow, not a transcript, one tool call or a competing whole-Flow strategy. Attempt records one accountable approach to one Intent and can contain several runs.
- P2: introduce opt-in managed-work model beside legacy records, under separate `/hub/work/v1` metadata API; do not repurpose machine `/hub/v2` or legacy `/hub/v1` acceptance semantics.
- P3: immutable FlowRevision/IntentRevision and ContextSnapshot identify declared and separately observed work context. Proposed requirement amendments suspend affected admissions until human approval; old results remain reviewable against their old pins.
- P4: Attempt submission seals an immutable ResultSubject and Evidence set. A change-requested/rejected/withdrawn submission is retained; continued implementation uses a new Attempt linked by supersedesAttemptId. Existing session may continue under a fresh explicit association.
- P5: a subject is a manifest of immutable Git commit/tree references, document versions/digests and optional legacy review attachments. PR URL/head is an observed link; mutable branch name alone cannot be accepted.
- P6: owner/reviewer and authorized team contributors can perform work-domain operations; runtime controller is distinct. Agent can propose/submit, never approve requirements/select/accept/waive.
- P7: single-process SQLite migration first, protected outbox/inbox and object append history; no new mandatory infrastructure. Large logs optional/retained by policy, no upload of entire repo/history/env/hidden reasoning.
- P8: accepted work is distinct from Git publication/merge and wiki freshness. Merged external PR alone never auto-accepts a Flow.

No change to frozen existing remote-session documents is made. These recommendations are frozen only through a later explicit owner-approved work Flow/spec revision.

- P9: v1 defers carry-forward compatibility; amended requirements require fresh Attempts and review. Waivers are acceptance overlays, not mutations of sealed submissions. Flow criterion coverage is complete and integration criteria have an explicit required Intent.

## Implementation refinements

- I1: the owner subsequently authorized autonomous implementation and parallel backend/UI work. This authorizes candidate development, not product self-acceptance or implicit production rollout.
- I2: physical SQLite storage follows the repository's typed JSON row pattern with project+ID keys and dedicated event/receipt/archive/reservation/observation tables. Domain guards and closed schemas enforce relationships transactionally; the original table-per-entity list was a design sketch, not a migration already applied.
- I3: original native admission uses optional paired HTTP sidecar headers, preserving frozen v2 JSON and every existing controller/ad-hoc-consent check. Runtime content consumption remains explicitly unverified.
- I4: completed snapshot exports are released, with bounded unfinished exports and explicit resync on consumed/expired cursors. A real browser trial reproduced the previous retained-export quota defect before this correction.
