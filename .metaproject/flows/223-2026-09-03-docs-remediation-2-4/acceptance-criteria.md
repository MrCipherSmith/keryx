# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Each criterion below is verifiable by running a command whose output decides it.
Where a criterion says "enforced by a test", a passing suite alone is not
evidence: the test must be shown to fail when the fix it guards is reverted.

## Criteria

- AC1: `npm install -g @mrciphersmith/keryx` appears as an install instruction on at least one page included in the built site (a page listed in `mkdocs.yml` nav), verified by grep over `docs/docs/` excluding `README.md`.
- AC2: All four install paths (npm package, standalone binary via `scripts/install-binary.sh`, managed clone, project-local clone) are documented on the site, each with its stated prerequisite, and each naming the others; `README.md` and `onboarding.md` link to each other.
- AC3: The string `slate` appears in `docs/docs/modules.md`, `docs/docs/architecture.md` and `docs/docs/cli-reference.md`; `cli-reference.md`'s `## mcp` section names `slate.open`, `slate.writeSeed`, `slate.close` and the `slate_transport_denied` refusal alongside the existing `sac.*` five.
- AC4: `docs/docs/modules.md` no longer claims SAC "has no `modules.sac` toggle"; the replacement text matches observed behaviour, demonstrated by running `keryx modules enable sac` in a throwaway project and showing `modules.sac.enabled=true` in the manifest.
- AC5: `--acknowledge-security` is documented on `keryx workspace confirm-review` in `docs/docs/cli-reference.md` and `docs/docs/guides/shared-agent-context.md`, and appears in the command's own usage banner printed by `keryx workspace --help`.
- AC6: Every `keryx workspace` subcommand and option the CLI accepts appears in `docs/docs/cli-reference.md` — including `archive`, `rename`, `remove-resource`, `list-proposals` and `list --include-archived` — enforced by a test that derives the subcommand list from the CLI source rather than from a hand-written list, proved by mutation.
- AC7: `MODULE_COMMANDS` for `sac` lists every subcommand the CLI routes, enforced by a test that fails when the two diverge, proved by mutation.
- AC8: The obsolete caveats at `docs/docs/architecture.md` (that `security` cannot be toggled via `keryx modules`, and that toggling any module drops an enabled `mcp`) are removed, after re-confirming on the shipping revision that both behaviours are in fact fixed.
- AC9: The module-map table in `docs/docs/architecture.md` is one contiguous table — no non-pipe line between its header row and its last row — enforced by a test, proved by mutation. (Amended: the original wording required inspecting rendered site output, which this environment cannot produce — `mkdocs` needs `python3-venv`, which is absent and not mine to install. A permanent structural guard is stronger than a one-time visual check: it fails on the next stray blank line rather than confirming one build. `mkdocs build --strict` still runs in CI, though it does not validate table structure.)
- AC10: `docs/docs/index.md`'s guide list and the `Guides` section of `mkdocs.yml` nav name the same set of pages, enforced by a check that fails when they diverge, proved by mutation.
- AC11: `docs/docs/cli-reference.md` has a section for every top-level CLI verb, including `job` and `sandbox`, enforced by a test that derives the verb list from `CLI_ROUTES`, proved by mutation.
- AC12: `docs/docs/cli-reference.md`'s `## commands` section states the rule that decides which verbs the `keryx commands` registry includes and which it omits.
- AC13: `README.md` names Slate and Shared Agent Context, each with its entry point (`keryx workspace` for SAC; the `slate.*` MCP tools for Slate).
- AC14: `bun run check` (typecheck + full suite), `bun run test:guards` and `bun run check:doc-links` all pass, and `mkdocs build --strict` succeeds, on the final revision.
