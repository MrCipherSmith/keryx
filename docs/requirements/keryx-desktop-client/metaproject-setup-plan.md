# Desktop Metaproject setup and diagnostics

Status: proposed. Source baseline: `main` at `23834c60`. This plan covers the existing Keryx Desktop app, local projects and the CLI that Desktop resolves for a project.

## Current behavior

- [Desktop Project menu](../../../apps/desktop/src/project/projectCommands.ts) already exposes Init, Update and wiki commands. [Project runner](../../../apps/desktop/src/project/useProjectRunner.ts) invokes the current window's CLI in a terminal tab. [App](../../../apps/desktop/src/App.tsx) opens and switches projects through the existing picker, recent projects and window registry. [CLI locator](../../../apps/desktop/src-tauri/src/locator.rs) handles Automatic, PATH, bundled and custom CLI sources. [Desktop updater](../../../apps/desktop/src-tauri/src/appupdate.rs) handles the Desktop app's own release.
- [Init](../../../src/commands/init.ts) supports recommended defaults, interactive module and hook prompts, and a gdskills profile (minimal, recommended, full, custom). Its default-on modules are gdgraph, gdctx, gdwiki, gdskills, health, testing, memory, tasks and security. MCP and SAC are opt-in. Tree-sitter and coverage-map test impact analysis are advanced options. MCP client config and Git hooks have separate side effects. Enabling Testing already analyzes the workspace during init. A graph build is suggested after init.
- [Update](../../../src/commands/update.ts) refreshes service files and can recover a legacy manifest and add Task Manager. The managed runtime fetch can be skipped. Custom post-update hooks require `--hooks`. Most data artifacts are preserved. On the current CLI, `--yes` also authorizes pruning eligible stale worktrees. Desktop setup should never pass it merely to make Update noninteractive.
- [Module status](../../../src/commands/modules.ts) provides JSON for the catalog and current enabled flags. Module changes today invoke init again. Desktop needs one batch plan to preserve unchanged settings, including opt-ins and hook configuration, and prevent the implicit Task Manager backfill from overriding a user's deselection.
- Establish the wizard catalog from supported capabilities. For example, the source help advertises `init --external-agents` without a corresponding init parser option. Verify that behavior before exposing an External Agents control.
- [Doctor](../../../src/commands/doctor.ts) reports version availability, prerequisites, providers, integrations, Standard, entrypoints and Git hooks, stale worktrees, and graph/wiki freshness. It reads existing freshness evidence. It also performs a bounded version lookup, so split global checks from local project scans and do the former at most once per refresh window. A valid JSON report can carry a nonzero exit code when checks fail.
- Init and Update have text previews with create/update/skip/conflict and digests for lifecycle-managed files. They do not supply final bytes or complete mutation coverage. [Install journal](../../../src/lib/install-plan.ts) records the writer version for managed steps and resume information. Manifest `schemaVersion` and `standardVersion` describe separate contracts. `createdBy` identifies Keryx and carries no CLI version.
- [Entrypoint writers](../../../src/rules/entrypoint-writers.ts) preserve existing team files under their rules. Fresh projects default to local scope. Claude's filename is `CLAUDE.local.md`. The Codex override is generated as `AGENTS.override.md` when its configured source exists. Shared `AGENTS.md` is an explicit choice. [Ignore handling](../../../src/lib/metaproject-gitignore.ts) defaults to managed rules in Git's local `info/exclude`. A repository-wide `/.metaproject/` rule in the tracked `.gitignore` is a separate opt-in and has no effect on already tracked files.

## Desktop behavior

When adding a folder, run discovery before any project writes. A new folder offers Setup. An initialized folder opens normally and offers Update or Repair when the scan finds drift. Cancel from the wizard leaves the project untouched and allows opening it without setup. Show missing folder, uninitialized workspace, damaged or incomplete workspace, unavailable CLI, and incompatible CLI as distinct results. If an ancestor has a Metaproject, identify it and offer opening that root or explicitly setting up the selected folder.

Use a single Setup and Update dialog from project onboarding, the Project menu and notifications. Include:

1. **Overview.** Show the folder, the chosen CLI source/version, and the detected project service-file state. Show three separate update actions when relevant: Desktop app update, CLI upgrade, and project service refresh. A newer CLI alone does not prove that service files need rewriting.
2. **Modules and settings.** Start fresh projects with the CLI's defaults. Show all available modules, enabled/disabled state, gdskills profile, and advanced options for hooks, MCP, SAC and indexing features. Preserve existing choices by default on update. Explain prerequisites and show when a choice changes hooks or client config.
3. **Files and ignore rules.** Preview exact managed Markdown or a diff for the effective `AGENTS.md`, `AGENTS.override.md` and `CLAUDE.local.md` targets. Show when an absent Codex source means no override will be written. Offer shared `AGENTS.md` creation or an update as an explicit team-file choice. Offer a separate, unchecked checkbox for adding `/.metaproject/` to the repository's `.gitignore`. Show the planned hunk, existing ignore rules and any tracked Metaproject paths. Write no Git config or ignore files during preview.
4. **After setup.** Offer Graph check, Rebuild graph, and Check and rebuild if stale as alternatives within one selection. Use the existing graph status/freshness check and `gdgraph build`. Offer Code Health, testing context refresh, optional project checks, and wiki collect/index/validate as separate actions. Order the relevant steps so wiki collection sees current graph, health and testing evidence. Keep model-backed wiki enrichment available through its existing dialog. Show which operations can run project commands or use the network.
5. **Review and apply.** Show changed modules, predicted file edits, conflicts and selected operations. Keep files on divergence by default or let the user resolve a named conflict. Report progress by step, with a terminal or log action for details. On failure show completed, failed and skipped steps and allow replan/retry without repeating completed writes unnecessarily.

## Implementation stages

### 1. CLI project inspection and typed plan

Extract shared read-only inspection and planning from existing CLI services. Expose a versioned JSON contract for Inspect, Plan and Apply through dedicated CLI commands. Keep interactive CLI invocations on the same implementation. Return the module catalog and defaults, detected project root, version/capability information, normalized findings, typed step IDs, file diffs, and blocked steps. Use writer-version and digest evidence for managed file drift and show an unknown legacy state when there is no reliable record.

Move rendering of managed entrypoint blocks into read-only planners shared with the writers. Represent create, update, unchanged, conflict and unsupported targets. Represent hooks and other effects honestly when a byte-for-byte preview cannot be generated. Use existing ignore helpers and add the tracked ignore rule as a separate contained write that preserves user changes.

Plan a single state transition for module choices and refresh. Apply under a lock for the project plus any shared Git resources, using canonical paths and a plan fingerprint tied to CLI version, config and file digests. Replan when inputs change. Build argv in trusted code from known operations. Keep arbitrary Doctor fix text display-only. Default to skipping runtime fetch, custom hooks and worktree pruning for Desktop apply. Preserve local and shared ownership rules and journal partial work.

The Stage 1 entry point is `keryx setup inspect|plan|apply`. The versioned request,
plan approval, partial Apply receipts, and follow-up action IDs are documented
in the [CLI reference](../../docs/cli-reference.md#project-setup-json).

### 2. Desktop wizard and project entry points

Use the native CLI locator before the agent session starts, so onboarding works when the normal session is offline or the bundled binary is needed. Add a typed Tauri transport with a browser-dev equivalent or a clear feature-unavailable state. Wire add/open, Project menu and Project Settings to the same wizard. Do not scrape PTY output for state. Reuse the existing Dialog and project command log surfaces. Render selections, preview and confirmation from the CLI plan, and refresh project capability state after success.

### 3. Project checks and notifications

Run a bounded read-only scan after Desktop starts and when a folder is added. Scan the current project first and deduplicated known projects next. A saved folder on an unavailable volume should report unavailable instead of prompting setup. Coalesce repeated scans across windows and refresh on explicit request or after Apply. Use stable incident keys by project and finding, retaining dismissal until the underlying issue changes. Never rebuild indexes, run repository checks or apply fixes in the background.

Add an accessible bell in the main app header with an unread indicator and a keyboard-accessible popover. Show project name, issue, last check time and action. Clicking an item opens the same wizard for that project with only the relevant fixes preselected and a fresh preview. Use allowlisted mappings from finding IDs to fixes. Provider connectivity or CLI installation issues open their appropriate settings when there is no project operation to apply.

### 4. Verification and rollout

- CLI integration on clean Git and plain folders, a linked worktree, a nested folder, old and malformed manifests, stale graph/wiki, unexpected symlinks, and dirty/tracked entrypoints. Verify Inspect/Plan and Cancel leave project files unchanged. Check Update applies only selected actions, keeps data, and does not prune worktrees or run custom hooks by default.
- Compare the previewed and applied managed blocks and ignore diff. Check stale plan refusal, module selection preservation, idempotence, partial failures and retry. Cover absent or old CLI, fallback source and a newer project writer.
- Desktop coverage for onboarding, field dependencies, cancel, progress, notification deduplication, the correct target project across windows and an accessible bell/dialog sequence. Verify with a real installed app plus a disposable repository. Run automated suites in GitHub CI.

## Evidence from the investigation

The analysis pinned source to `main` at `23834c60` (package version 0.4.46). In a disposable Git repository with the locally installed CLI 0.4.45, Init preview and Update preview exited successfully without changing project files. Init succeeded, the module-status response was JSON, and only `CLAUDE.local.md` was created among the four entrypoint filenames checked in that empty project. No Desktop interaction or full test suites were run for this plan.
