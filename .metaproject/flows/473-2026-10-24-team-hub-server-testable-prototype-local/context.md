# Pinned implementation context

Date: 2026-10-25 Asia/Muscat. Root <repo>, branch codex/team-hub-prototype from main. Task Manager enabled. Prototype Flow owner MrCipherSmith, final acceptance remains human.

Research: <repo>/.metaproject/jobs/wiki-openspec-flow-research/analysis.md and Page v0.12. Existing wiki collect/refresh is deterministic; enrich preserves accepted status even after prose edits. SAC wiki owner writes a new decision stub, not existing-page patch; contract-change routes to skill. Slate is working context, Flow owns work state. Hub must add exact revision review and separate actor authority rather than infer trust from Markdown status.

Runtime: installed Bun1.4.2, git, Docker CLI28.4.0. Node modules shared read-only via symlink to original checkout; do not run package installs in parallel. No new runtime dependency planned. Official Bun1.4.2 server docs resolved through Context7; SQLite driver is bun:sqlite, actual files in dataDir (never embedded volatile DB). References: https://bun.sh/docs/runtime/sqlite and https://bun.sh/docs/runtime/http/server .

New worktree graph index unavailable; use original known graph navigation pointers and explicit bounded files, or rebuild once at integration. All text search via keryx ctx rg. Testing context .metaproject/data/testing/context.md. No tests claimed green before execution.

Existing source remains unchanged unless assigned: src/hub new module, src/commands/hub.ts and one CLI registration, docs/requirements/team-hub-prototype, deployment assets/scripts. No changes to Vantage or real user repositories; acceptance fixtures use temporary clones/worktrees/remotes.
