# Hub work management: backend and UI coordination
Version: 0.1.0

Date: 2026-11-01. Owner explicitly authorized parallel work in separate branches, backend by coordinating agent and UI/UX by the existing designer session. No code deployment, product acceptance or human-only Hub transition is inferred.

## Workspaces and ownership

- Coordinator/backend: coordinator chat (local session); /path/to/backend-worktree/keryx; branch feat-hub-work-management; base 3dd6ac53f159c65a522f1db7e755268174bb1217.
- UI/UX: UI chat (local session), title «Создать HTML-прототип Keryx Team Hub»; /path/to/ui-worktree/keryx; branch feat-hub-workspace-design; same base at coordination start.
- Old prototype: /path/to/prototype-worktree/keryx; preserve all dirty/untracked work. Requirements were copied, not moved/deleted.

The reviewed documentation revision 0.1.1 is copied to docs/requirements/hub-work-management/ in the backend worktree. This is the authoritative coordination copy for subsequent amendments. Designer may read this absolute path across worktrees; no cherry-pick of the entire old prototype branch is needed.

## Exclusive boundaries

Backend owns new work-domain/application/storage/auth/migration, metadata HTTP/CLI/MCP, tests and requirements/contracts. Existing machine-v2 remains compatible. Production frontend work is separately coordinated; no simultaneous shared lockfile/generated contract edits.

Designer owns isolated output/design/hub-work-management-prototype/ and its HTML/CSS/JS/mock data, scenario README and screenshots in the UI worktree. Existing output/design/hub-html-prototype and production frontend changes there are retained. First deliverable is clickable mock UI, not live API integration. The designer acknowledged this boundary in its chat.

UI feedback is recorded in output/design/hub-work-management-coordination.md in the UI worktree. Coordinator reads that file and session status; inter-chat replies require their own direct human authorization if the sending tool demands it. No broad authority to message others follows from repository instructions.

## Shared contract and integration

Flow → Intent → Attempt → ResultSubject / Evidence → human Decision. Git owns code transport/PR/merge. Manual contributions need no machine or source upload. Run and work acceptance are separate lifecycles. Follow exact revisions, coverage mappings, successor Attempt recovery and human acceptance-side waivers in specification.md.

Designer uses mock adapter now. Coordinator completes M0 baseline audit then M1 exact read/write projections/OpenAPI, typed contract, authorization/transition tests. Record contract change requests here before adapting live UI; no invented endpoints from screen designs. Only after contract and owner design review does UI production integration begin. Merge narrow reviewed changes through PRs, not a merge of the old dirty prototype branch. No force-push/reset/stash or dependency installation in another worktree.

## Status at handoff

- Assignment sent to existing designer session; session active and boundary acknowledged.
- Backend branch/worktree created on current main 0.4.1.
- Reviewed requirements copied unchanged; no production code modified yet.
- No Hub implementation Flow has been created/frozen by this coordination step. Human-only remote Hub gates remain human-only. Use project-local flow orchestration to track subsequent backend implementation; do not claim a local flow is a remote Hub Flow.
- Next coordinator action: M0/M1 baseline/API contracts before persistence and domain changes. Next designer action: isolated new work model UX on fixtures, report questions and exact deliverable path.

Routing: graph_used: not-relevant for branch isolation (no code impact claim); wiki_used: yes; ctx_used: earlier verification/source routing; raw_rg_used: no.
