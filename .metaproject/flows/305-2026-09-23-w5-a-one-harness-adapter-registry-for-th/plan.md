# Implementation Plan

Status: approved by flow orchestrator (dispatched run, autonomous)

## Approach

A new core-zone directory `src/integrations/` (named after the future
`keryx integrations` CLI namespace; `src/harness` is the agent runtime and must
not be confused with host-harness integration). The three existing modules keep
their exported API (every existing test and caller imports it) but become thin
views derived from the registry. Commands keep importing the old modules, so no
new `client-imports-core-internal` edges appear in the import-policy ratchet.

### Files

- `src/integrations/types.ts` — `SurfaceFlag` (the 12 W5 flags), `Confidence`,
  `AdapterKind`, `PayloadCodec`, `DecisionCodec`, `HookAction`, `Settings`,
  `SurfaceSlot`, `SurfaceAdapter`, `HarnessAdapter`, `SettingsFileOwner`.
- `src/integrations/settings-json.ts` — the ONE set of JSON walkers:
  `MANAGED_KEY`, sentinel add/remove, `isManagedBy(sentinel)`,
  `stripManaged`, `hooksObject`, `mergeIntoHookArray` (with the legacy
  array -> `unmigratedHooks` migration), `stripFromHookArray`,
  `managedGroups(settings, {container, key, shape, sentinel, command, match})`
  (the proven `managedGroupsFor` walker, generalised: flat vs nested, nested
  requires `type: "command"`), `readSettingsFile`/`writeSettingsFile`.
- `src/integrations/codecs.ts` — payload parsers (claude/codex tool_input,
  cursor, windsurf, antigravity), `parseToolName`, `refusalAction`,
  `allowAction` (moved from ctx/runtimes; ctx/runtimes re-exports them).
- `src/integrations/surfaces/*.ts` (or one `surfaces.ts`) — surface
  definitions per subsystem:
  - ctx guard (`ctx-guard`, flag `block`, sentinel `ctx-agent-hooks`) for
    claude, codex, cursor, windsurf, antigravity (JSON) and opencode (file
    artifact: `customInstall`/`customUninstall` plugin writer);
  - orient injector (`orient`, flag `inject-context`, sentinel
    `ctx-orient-hooks`) for claude, codex, cursor;
  - security (`security-check-input`, flag `prompt-gate`;
    `security-check-output`, flag `block`; sentinel `security-agent-hooks`) for
    claude (event-keyed UserPromptSubmit / PreToolUse Write|Edit) and
    cursor, windsurf, generic-mcp (flat `securityHooks` array).
- `src/integrations/registry.ts` — `HARNESS_ADAPTERS` in the order claude,
  codex, cursor, windsurf, antigravity, opencode, zed, generic-mcp;
  `getHarnessAdapter`, `surfacesOf(adapter, {flag?, subsystem?})`,
  `SETTINGS_FILE_OWNERS` / `settingsFileOwnerFor(relativePath)` (derived: one
  owner per distinct relative settings path), `assertRegistryCoherent()`
  (run at module load and in tests).
- `src/integrations/settings-file.ts` — `SettingsFileOwner` implementation:
  `apply(existing, {install: surfaceIds, uninstall: surfaceIds})` applies
  surface merges/strips in the owner's fixed canonical order, then validates:
  every surface that validated clean BEFORE the operation and is not being
  uninstalled must still validate clean, and every installed surface must
  validate clean; otherwise it returns errors and the caller does NOT write.
  Plus the on-disk `installSurfaces(root, runtimeId, surfaceIds)` /
  `uninstallSurfaces(...)` used by every installer.
- `src/integrations/index.ts` — the module's public door.

### Interface decisions (deviations from the W5 sketch, recorded)

1. `HarnessAdapter.surfaces` is `readonly SurfaceAdapter[]`, not
   `Partial<Record<SurfaceFlag, SurfaceAdapter>>`: Claude already has TWO
   `block` surfaces in one file today (ctx guard `PreToolUse Bash|Grep` and
   security check-output `PreToolUse Write|Edit`), which a one-per-flag record
   cannot express. `surfacesOf(adapter, {flag})` answers "does X support Y".
   Each `SurfaceAdapter` carries `id` (unique per adapter), `flag`,
   `subsystem` (`ctx-guard | orient | security`), `sentinel`, `confidence`,
   `riskNotes`, `sourceDocs`, `slots` (the JSON keys it writes and their type),
   `settingsFile` (relative path, absent for non-JSON artifacts) and
   `merge/strip/validate` or `customInstall/customUninstall`.
2. `HarnessAdapter.unsupported: Partial<Record<SurfaceFlag, string>>` carries
   today's `UNSUPPORTED_RUNTIMES` / `UNSUPPORTED_ORIENT` reason strings
   verbatim; the old exported records are derived from it.
3. Adapter `confidence` = the harness's ctx-guard confidence (today's
   `CtxRuntime.confidence`); generic-mcp and zed get `experimental` with
   risk notes. Surface-level confidence is the source of truth.
4. Security on cursor/windsurf/generic-mcp: `confidence: "experimental"` with
   risk note citing OQ-3 (the matrix target). The `keryx security hooks`
   CLI output is NOT changed by this (no new warning line) — non-breakage.
5. Sentinel semantics unchanged: merge moves the surface's sentinel to the end
   of `_keryxManaged`; strip removes it only when no other surface sharing that
   sentinel in the same file still has managed entries. A pre-existing
   sentinel with no entries is left alone (pinned by hook-install tests).

### One-path guard (the OQ-3 class, by construction)

- `slots`: every JSON surface declares `{key, type: "object" | "array"}` for
  each top-level key it writes (`hooks: object`, `securityHooks: array`,
  `keryx-ctx-guard: object`, `version: number` etc.).
  `assertRegistryCoherent()` throws when two surfaces on one settings file
  declare different types for one key — exactly the pre-fix
  `hooks: object` vs `hooks: array` collision.
- `SettingsFileOwner.apply` refuses (errors, no write) when an operation
  leaves a previously-valid surface invalid.

## Steps

1. (T1) Context: done by the orchestrator (this plan, context.md).
2. (T2) Implement `src/integrations/*`, re-express the three modules as views,
   route `hook-install.ts`, `security/agent-hooks.ts`, `commands/orient.ts`
   install/uninstall through `installSurfaces`/`uninstallSurfaces`; add
   `integrations` to `ZONE_TABLE` as core.
3. (T3) Tests: `src/integrations/registry.test.ts` (shape, coverage exactly the
   8 runtimes, 12 flags, derived views equal the old literal lists and
   confidences, coherence invariant incl. a negative control),
   `src/integrations/coexistence.test.ts` (the Wave-0 exit guard: for every
   `SettingsFileOwner`, every permutation of its surfaces installs valid;
   uninstall of any one leaves the rest valid; ctx vs security in both orders
   through the owner AND through the legacy per-module merges; negative
   control with a deliberately clobbering surface is refused).
4. (T5) Verification: targeted tests for every touched module unchanged and
   green; typecheck; eslint on changed files; import-policy tests.
5. (T6) End-to-end CLI smoke in a temp dir with `bun ./src/cli.ts`: ctx
   install-hook / security hooks install / orient install-hook for
   claude, cursor, windsurf, codex in both orders, then uninstall each, file
   contents and exit codes checked.
6. (T7) Docs: short architecture note + W5 doc "status" pointer.
7. (T4) Review (opus, adversarial) -> fix -> PR -> CI -> merge.

## Risks

- Re-deriving walkers reintroduces the bug class — mitigated by moving the
  proven walkers verbatim and keeping every existing test unmodified.
- Orient validation currently accepts either flat or nested command
  placement; routing it through the shared walker tightens it (nested needs
  `type: "command"`). Acceptable only if no existing test changes; otherwise
  keep the orient matcher lenient and record it.
- Security split into two surfaces changes the internal array order on a
  single-surface re-install; installing both in canonical order is
  byte-identical to today (coexistence idempotency test pins count = 2).
