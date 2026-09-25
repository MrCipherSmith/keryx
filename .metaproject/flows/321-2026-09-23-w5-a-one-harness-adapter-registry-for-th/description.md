# W5-a: one harness adapter registry for the ctx guard, orient injector and security hooks

Status: formalized
Source: docs/requirements/keryx-agent-platform-expansion/workstreams/W5-multi-harness.md (Wave 0 slice W5-a, implementation-plan.md)
Base branch: feat/agent-platform-expansion

## Problem

Keryx writes into host-harness settings files through three independent
registries — the gdctx routing guard (`src/ctx/runtimes.ts`), the graph+wiki
orientation injector (`src/ctx/orient-runtimes.ts`) and the security
check-input/check-output installer (`src/security/agent-hooks/runtimes.ts`).
Each has its own runtime list, its own `Confidence` type, its own sentinel
helpers and its own merge/strip/validate walker, and three installers each read
and rewrite the same physical files (`.claude/settings.json`,
`.cursor/hooks.json`, `.windsurf/hooks.json`, `.codex/hooks.json`) with no
knowledge of each other. That design already produced one real clobbering bug
(the `securityHooks` / OQ-3 history: two installers wrote incompatible JSON types
under one `hooks` key, whichever ran second destroyed the first). The fix was a
point fix; the class of bug is still open to any fourth writer (W6, W3, W8).

## Expected Outcome

- One harness adapter registry (`src/integrations/`) with the W5
  `SurfaceFlag` (12 flags) / `Confidence` / `AdapterKind` / `SurfaceAdapter` /
  `HarnessAdapter` interface, covering exactly today's runtimes: claude, codex,
  cursor, windsurf, antigravity, opencode, zed (registered, no installable
  surface, unsupported reasons) and generic-mcp.
- The three existing modules become views derived from the registry — no
  independent runtime lists, no duplicate walkers — with zero change in
  confidence or behaviour for any runtime.
- One merge/strip/validate path per settings file (`SettingsFileOwner`): every
  installer writes through it, it refuses an operation that would invalidate a
  surface that was valid before, and a registry invariant rejects two surfaces
  that disagree on the JSON type of a key in one file (the OQ-3 class).
- A guard test proving neither the ctx guard nor the security hooks can
  clobber the other for any existing runtime, in both install orders.
- `keryx ctx install-hook|uninstall-hook`, `keryx orient install-hook|uninstall-hook`,
  `keryx security hooks install|uninstall` and `keryx ctx hook <runtime>`
  unchanged from the operator's point of view.

## Out of Scope

- New harnesses (gemini-cli, kiro, github-copilot-agent, keryx-shell) — W5-b.
- Zed as a `policy-travels-with-agent` adapter with a verified `block`
  surface — W5-b (W5-AC6). Zed stays registered as unsupported here.
- `keryx integrations install|doctor|uninstall|matrix` CLI, the generated
  capability matrix artifact and its CI check, install-state persistence — W5-b.
- Resolving OQ-3 (whether Cursor/Windsurf honour `securityHooks`).
- Changes to `hook-classify.ts` or the policy engine.
