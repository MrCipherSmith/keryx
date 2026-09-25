# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Scoped from W5-multi-harness.md (W5-AC1, W5-AC2, the alias half of W5-AC3,
W5-AC7) plus the Wave 0 exit criterion in implementation-plan.md. W5-AC3's
`keryx integrations` CLI, W5-AC4/5/6/8 belong to W5-b.

## Criteria

- AC1: `src/integrations/` exports one harness adapter registry (`HARNESS_ADAPTERS`) typed by `SurfaceFlag` (exactly the 12 W5 flags), `Confidence`, `AdapterKind`, `SurfaceAdapter` and `HarnessAdapter`, registering exactly claude, codex, cursor, windsurf, antigravity, opencode, zed and generic-mcp — no other harness and no `keryx integrations` command — proven by a registry test.
- AC2: `CTX_RUNTIMES`/`UNSUPPORTED_RUNTIMES` (src/ctx/runtimes.ts), `ORIENT_RUNTIMES`/`UNSUPPORTED_ORIENT` (src/ctx/orient-runtimes.ts) and `RUNTIME_HOOKS` (src/security/agent-hooks/runtimes.ts) are derived from the registry, with no independent runtime list or merge/strip/validate walker left in those modules, and every runtime keeps its current confidence (block: claude/codex/cursor/windsurf verified, antigravity/opencode experimental; inject-context: claude/codex/cursor verified; windsurf/zed/opencode/antigravity inject-context unsupported with byte-identical reason strings) — proven by a registry test comparing against the pre-refactor values.
- AC3: every settings file targeted by two or more surfaces (at least `.claude/settings.json`, `.cursor/hooks.json`, `.windsurf/hooks.json`, `.codex/hooks.json`) is owned by exactly one `SettingsFileOwner`, every installer (ctx install-hook/uninstall-hook, orient install-hook/uninstall-hook, security hooks install/uninstall and the init/update security wrappers) writes through it, and it refuses without writing an operation that would leave a previously-valid surface invalid — proven by a test with a deliberately clobbering surface.
- AC4: a registry invariant rejects two surfaces on one settings file that declare different JSON types for the same top-level key (the `securityHooks`/OQ-3 class), with a negative-control test proving it fires.
- AC5: a guard test proves, for every existing runtime and settings file, that the ctx guard and the security check-input/check-output hooks (and the orient injector where present) never invalidate each other in both install orders and every permutation, including uninstalling either one — the Wave 0 exit criterion.
- AC6: existing tests pass without modification: src/security/agent-hooks.coexistence.test.ts, src/security/agent-hooks.test.ts, src/security/agent-hooks/runtimes.test.ts, src/ctx/runtimes.test.ts, src/ctx/hook-install.test.ts, src/ctx/orient-runtimes.test.ts, src/ctx/hook*.test.ts and the command tests for ctx/orient/security/init/update; `keryx ctx hook <runtime>` behaviour and invocation strings are unchanged.
- AC7: existing on-disk formats stay readable and are migrated as before: sentinel strings, container keys, legacy `hooks` array migration and `unmigratedHooks` preservation are unchanged — proven by the existing legacy-migration tests passing.
- AC8: an end-to-end CLI run (`bun ./src/cli.ts`) in a temp project of ctx install-hook, security hooks install and orient install-hook for claude, codex, cursor and windsurf in both orders, followed by each uninstall, leaves every remaining surface valid with exit code 0; typecheck, eslint on changed files and the import-policy tests pass, and the PR's CI is green.
