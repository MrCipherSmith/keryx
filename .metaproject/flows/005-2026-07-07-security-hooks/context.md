# Context

Enriched by flow-orchestrator (Phase 1).

## Existing hook pattern to mirror (git hook = Hook 1)

- `src/lib/templates.ts`: `renderGdgraphPostCommitHook()`, `renderTestingPrePushHook()`, `renderHealthPostCommitHook()`, etc. — each returns a shell hook body wrapped in a `# gd-metapro:<id>:begin … :end` managed block.
- `src/commands/init.ts`: `enable<Module>Hook` flags (defaults false), interactive `confirm(...)` prompts, `--no-<x>-hook` flags; hooks written into `.git/hooks/<name>` merging managed blocks with existing user content. The manifest module entry has a `hooks: { gitPostCommit?, prePush?, postUpdate }` slot. Testing already installs a `prePush` hook — Hook 1 is the exact analog.
- `src/commands/update.ts`: refreshes hook definitions.
- The hook body should call the CLI and honor the config `mode` (advisory warns / enforced+ci exit non-zero).

## Agent hook (Hook 3) — NEW infra

- No `.claude/settings.json` scaffolding exists in the CLI today (only the bundled `hookify` skill documents the format). Claude Code hooks live in `.claude/settings.json` under `hooks: { UserPromptSubmit: [...], PreToolUse: [{ matcher, hooks:[{type:"command", command}] }] }`.
- Install MERGE-SAFE: read existing `.claude/settings.json` (may be absent / may have user hooks), add the security hooks under a managed marker so re-install/uninstall is idempotent and user entries are preserved. Reuse `src/lib/json.ts` and the managed-block idea from `src/lib/templates.ts`.
- Hook commands: `gd-metapro security check-input --source untrusted-external` (UserPromptSubmit), `gd-metapro security check-output` (PreToolUse Write/Edit). They must read the payload and exit 0 in advisory.

## Security CLI facts (already shipped)

- Module key `security`; config `.metaproject/security.config.json` (`mode`: advisory|enforced|ci). Guard: `src/security/guard.ts`. `security scan/check-input/check-output/report` in `src/commands/security.ts`. `ci` mode already exits non-zero on a blocker.

## Constraints

- Both hooks: no-op / not installed when security disabled; removable; managed blocks only (never clobber user hook content or user `.claude/settings.json`).
- Do not change guard/engine/detectors. Do not touch other modules' hooks.

## Baseline

- main @ 0144c8f; `bun run check` green (142 tests). Security enabled (9 modules).
