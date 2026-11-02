STATUS: DONE_WITH_CONCERNS

# Independent managed-work UI review

Verdict: REQUEST_CHANGES. Two major findings; no confirmed blocker. Review covers current source, not stale embedded assets, against base `3dd6ac53f` plus untracked managed-work files. Second-increment amendments, waivers, event watching and observer controls were explicitly outside this first pass.

## UI-001 — Requirements approval conceals material fields

- Severity: major.
- Anchors: `apps/hub-web/src/features/managed-work/view.tsx:481` and `:543`.
- Trigger: a collaborator proposes a Flow revision whose scope or linked specification differs from what the reviewer expects, then a human opens Approve requirements.
- Result: Flow approval exposes outcome, criteria and a digest, but never problem, scope, exclusions, specification reference/version/digest, or the exact required Intent set. Intent approval similarly omits approach, exclusions and criterion mappings. The confirmation shows the hash alone. The human cannot inspect the complete object whose digest they authorize through this UI.
- Why this matters: exact hash/CAS submission protects the stored identity of an approval, but the screen omits material contents of that identity. A correctly authorized command can approve requirements the human could not review.
- Fix: provide an expandable exact revision view containing every requirement field and source reference, linked to the same revision/digest used by confirmation, for Flow and Intent approval.
- Reproduction: `apps/hub-web/node_modules/.bin/vitest run --config output/work-ui-probe.config.mjs -t "approval exposes"`. The probe reaches an enabled approval button, then fails because the scope marker is absent. Raw evidence: `.metaproject/data/gdctx/raw/2026-11-01T10-54-03-657Z-36f25f_run.log`.

## UI-002 — Route navigation preserves a prepared decision for another Flow

- Severity: major.
- Anchors: `apps/hub-web/src/features/managed-work/view.tsx:155` (route synchronization), `:160` (prepared action), `:434` (decision rendering).
- Trigger: prepare approval for Flow A; use Back/Forward or an in-app location update to Flow B within the same project and Work tab.
- Result: the route effect changes only flowId, leaving the prepared action. Flow B's heading appears while A's approval form and digest remain. Confirm still uses A's expectedVersions and revisionId. If A did not change, CAS permits the wrong-context approval.
- Fix: invalidate prepared actions and child selection when the route Flow changes, or key the decision subtree by the target Flow and reject a mismatched action before submit. Preserve the separately stored unsent reason if desired.
- Reproduction: `apps/hub-web/node_modules/.bin/vitest run --config output/work-ui-probe.config.mjs -t route`. The probe displays Different flow marker and fails because A's approval form remains. Raw evidence: `.metaproject/data/gdctx/raw/2026-11-01T10-54-32-211Z-f65dce_run.log`.

## Coverage and verification

Read managed-work adapter, types, validation usage, model, operation recovery, contribution forms, review controls, decision history and core board; checked client auth invalidation, navigation/Shell remount boundaries, backend approval/review/receipt authorization and boundary behavior. Existing managed-work tests: 8/8 passed using `npm --prefix apps/hub-web test -- managed-work`. Independent DOM probes: two expected regression failures, kept under output only. No product edits, commits, deployment or real credentials. No live-browser or full redesigned-machines/sessions accessibility audit was performed in this pass.

Checked explicit demo activation, no silent fake fallback, bounded staged snapshot pages, exact digests/CAS, separate attempt selection and acceptance, human-only decision controls, uncertain-operation lookup, project/auth scope keys, and pinned context metadata. No additional confirmed defect in these checked paths. Managed execution advanced UI and event cursor updates require delta review after integration.

Routing audit: graph_used: yes (affected query attempted, answer explicitly predates untracked/modified source and was not used as current proof); wiki_used: yes (index read; no managed-work wiki page exists); ctx_used: yes; raw_rg_used: no. Testing context and local frontend/logic guidance read. Memory search found no conflicting managed-work decision.
