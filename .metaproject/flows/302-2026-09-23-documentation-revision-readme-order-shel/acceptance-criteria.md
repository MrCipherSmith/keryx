# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: README.md has one quick start, near the top, and places install, first run and the first working session before the deep-dive sections ("The agent harness", "Core capabilities"); the duplicate "## Quick start" block further down is gone, and a test pins that heading order.
- AC2: A newcomer reading README.md top to bottom meets, in this order: what keryx is, install (npm, the standalone binaries), `keryx init`, connecting a model provider, the first `keryx shell` session, and where to go next (docs site, `keryx help` once flow 303 lands); every command shown exists and runs as written.
- AC3: `docs/docs/onboarding.md` walks a new user through the first `keryx shell` run: connecting a provider (`/connect`, `keryx auth login`, `keryx providers list`), picking a theme (`/theme`), permission modes, the slash-command basics and sessions, alongside the existing workspace and `init` path; each step names the exact command and what the user should see.
- AC4: The onboarding page links to the flow 303 page of commands grouped by task (`docs/docs/commands-by-task.md`), and does not keep a second, hand-maintained full command list of its own.
- AC5: `complete-setup-and-agent-workflows.md` and `agent-installation-playbook.md` each state their audience in their first paragraph and link to `onboarding.md` for install and first run instead of restating those steps; any restatement that remains is justified in the page.
- AC6: Every page in `docs/docs/` and every root `.md` visible on GitHub (README, CONTRIBUTING, SECURITY, AGENTS, CODE_OF_CONDUCT) is checked against the current code: stale commands, flags, paths, versions and removed features are corrected, and the journal lists every page with what changed or "checked, no change".
- AC7: `docs/docs/index.md` lists every guide and page that `mkdocs.yml` navigates to, and a test fails when the two disagree.
- AC8: `docs/requirements/keryx-docs-remediation/README.md` is marked closed, citing where each of its nine findings is now fixed.
- AC9: The README and the docs site describe the features of 0.2.150-0.2.157 (ACP, triggers, schedules with the allowlist network, governance, flow confirm, the TUI sections) in one consistent vocabulary, with honest limits (Linux-only allowlist, no macOS sandbox, the confirmation token is friction not proof).
- AC10: `mkdocs build --strict`, `bun run check:doc-links` and the CLI reference coverage test pass.
- AC11: CI is green on the pull request and `keryx health run` passes before merge.
