# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `init` installs a managed `pre-push` git hook (behind a confirm prompt, default-on in `--yes`, opt-out with `--no-security-hook`) that runs the security guard over changed/committable content; the hook lives in a `# gd-metapro:` managed block and coexists with the existing testing pre-push block without clobbering it or any user-authored hook content.
- AC2: The pre-push hook blocks the push (non-zero exit) only in `enforced`/`ci` mode on a secret/critical finding; in `advisory` mode (the default) it warns and allows the push. The hook is not installed / is a no-op when the `security` module is disabled.
- AC3: `init` installs (behind a confirm prompt, opt-out with `--no-security-agent-hook`) a project-local `.claude/settings.json` hooks block: `UserPromptSubmit` → `gd-metapro security check-input` and `PreToolUse` (Write/Edit) → `gd-metapro security check-output`, using the valid Claude Code hooks schema.
- AC4: The `.claude/settings.json` installer is MERGE-SAFE and idempotent: installing into an existing settings file preserves all pre-existing keys and user hook entries; re-running does not duplicate the security entries; uninstall/disable removes only the managed security entries. The resulting file is always valid JSON.
- AC5: Both hooks are registered in the manifest under `security.hooks`, offered only when security is enabled, refreshed by `update` (without touching `data/security`), documented in `.metaproject/modules/security.md`, and `gd-metapro standard validate` still passes on this repo.
- AC6: New tests cover: pre-push managed-block install + coexistence with testing pre-push + no-op-when-disabled + `--no-security-hook`; agent-hook merge-safe install into empty AND pre-populated `.claude/settings.json` (user entries preserved) + idempotent re-install + `--no-security-agent-hook` + disabled-not-installed. The full pre-existing suite (142 tests) still passes unchanged; `bun run check` passes.
- AC7: Docs updated: `docs/requirements/security/{specification.md,README.md,agent-protocol.md}` describe the two hooks, `roadmap.md` reflects them, and `docs/docs` (cli-reference/modules/workspace-and-lifecycle) document the new `--no-security-hook`/`--no-security-agent-hook` flags and hook behavior; no doc↔code drift.
