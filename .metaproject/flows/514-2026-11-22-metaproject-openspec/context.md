# Context

- Product and review baseline: [PRD](../../../docs/requirements/keryx-metaproject-openspec/prd.md), [specification](../../../docs/requirements/keryx-metaproject-openspec/specification.md), [implementation plan](../../../docs/requirements/keryx-metaproject-openspec/implementation-plan.md). The documentation pass, including independent re-review, found zero remaining blockers and warnings.
- Base is main at b3dd71b88. Flow 512/PR 1283 supplied the existing Explorer, not the OpenSpec module. Other active flows concern their original scopes. Team Hub import is separate.
- Explorer source and contracts: `src/integrations/metaproject-explorer{,-contract}.ts`; Tauri `apps/desktop/src-tauri/src/metaproject.rs`; frontend `apps/desktop/src/metaproject/MetaprojectView.tsx`. Read contained source through `src/lib/contained-read.ts`.
- Wiki: `.metaproject/wiki/architecture/wiki-graph-sac.md`; evidence and storage ownership are local. The fresh worktree has no built graph yet. Search and code/test navigation use gdctx. The package documents pinned upstream formats.
- Automated suites run in GitHub CI. Existing GitHub core scripts explicitly enumerate test directories; Desktop suite runs from its own folder. Preserve no-local-test-suite guidance and record checks honestly. Native packaged acceptance stays separate.
- Worktree: `/Users/Goodea/.codex/worktrees/keryx-openspec-docpack`, branch `docs/metaproject-openspec`, base `main`.
