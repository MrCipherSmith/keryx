# Plan — 346 External switch

1. Locate: user config helpers (shell-config.ts), Jev client + callers, provider catalog,
   routing/model-selection choke point, jev-profile.ts, TUI slash-command registry, CLI command
   registry, data-dir helpers for the notice flag.
2. Add `ExternalBlockedError`, the external-providers JSON store (load/create-defaults/validate),
   the effective-external-setting resolver (user + project override), and the default provider
   list with per-entry reasons.
3. Wire the Jev choke point (`callJevSystemOne`) to check-and-throw before I/O; verify/patch each
   caller's catch path.
4. Wire the routing/model-selection choke point to exclude listed providers/models when external
   is off; refuse (not silently switch) when the user's own session model is listed.
5. Implement the single Jev-profile-default resolver (external on + credential resolvable ->
   ci_triage/select/edit_guard default true) and update `jev-profile show`.
6. Implement the one-time consent notice + per-project recorded flag.
7. CLI: `external on|off|status|list` commands.
8. TUI: `/external` slash command + modal, sidebar indicator, AGENT_SLASH_COMMANDS/HELP_GROUPS,
   regenerate commands-by-task, update tui-shell text-reader audit inventory.
9. Tests for all of the above, hermetic, OPENROUTER_API_KEY unset.
10. Docs: README, docs site, jev-in-review.md, delivery-loop guide, CHANGELOG.
11. `keryx test related`, typecheck, lint; fix; commit; push; open PR; watch CI; close flow.
