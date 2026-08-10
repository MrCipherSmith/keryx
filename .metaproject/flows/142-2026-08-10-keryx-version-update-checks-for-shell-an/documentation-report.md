# Flow 142 Documentation Change Report

Status: complete for AC6/AC8 documentation scope

## Source of truth

The documentation reflects the implemented version-check service in
`src/lib/version-check.ts`, the `keryx version check [--json]` command in
`src/commands/version.ts`, the shell/TUI integration, and the managed template
in `src/lib/templates.ts`. The implementation branch intentionally does not
perform a release version bump.

## User-facing changes

- `README.md` now describes the shell's background, non-blocking advisory,
  `keryx version check [--json]`, the 24-hour success cache, 15-minute failure
  suppression, 2-second timeout, and the exact manual install command.
- `docs/docs/cli-reference.md` documents the top-level `version` command,
  human/JSON outcomes, non-blocking unavailable results, cache/timeout bounds,
  no auto-install behavior, and the bootstrap limitation.
- `docs/docs/complete-setup-and-agent-workflows.md` includes the command in the
  canonical command reference.
- `CHANGELOG.md` records the advisory and generated-index guidance under
  `[Unreleased]`, including the prompt-only nature of the instruction and the
  pre-feature bootstrap limitation.

## Generated guidance

`bun run keryx -- update --skip-runtime` regenerated the working-tree
`.metaproject/index.md` through the supported generator path. Its operating
model now tells agents to run `keryx version check --json` once per session,
notify only for `update-available`, and never block on timeout, offline,
unavailable, or unknown-command results. The command reached the generation
step but exited at the existing environment's `.git/hooks/post-commit` write
with `EPERM`; the generated index was nevertheless refreshed and verified.

## Verification

- `bun run keryx -- ctx read .metaproject/index.md --mode full` confirmed the
  generated guidance.
- No production code, tests, flow state, `flow.json`, or frozen acceptance
  criteria were edited by this documentation task.
- No network command was run.

## Known concern

The update command also created unrelated generated dashboard, provenance, and
security artifacts. The orchestrator removed that run-specific churn and kept
only the generated version-guidance line, so the final diff does not mix this
feature with unrelated workspace refresh output.
