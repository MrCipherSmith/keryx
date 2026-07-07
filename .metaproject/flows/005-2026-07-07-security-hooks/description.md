# Security hooks: git pre-push gate + agent (.claude) input/output guard

Status: formalized
Source: user request (hook set "1+3")

## Problem

Metaproject Security's guard runs in-process at the 5 write seams, and the CLI
exists, but there is no **hook** that runs the guard automatically at the two
boundaries that matter most: the git push boundary (secrets leaving the repo) and
the agent↔model boundary (content sent to a model / written by a tool). Other
modules (gdgraph/health/testing/gdwiki/gdskills) offer a git hook at `init` with a
prompt; security has none.

## Expected Outcome (hook set 1 + 3)

**Hook 1 — git pre-push gate (blocking).** A managed `pre-push` git hook (mirrors
the existing testing pre-push) that runs `gd-metapro security scan`/report over
the changed + committable content before push. In `enforced`/`ci` mode it exits
non-zero (blocks the push) on a secret/critical finding; in `advisory` it warns
and allows. Offered at `init` with a confirm prompt and a `--no-security-hook`
flag; recorded in the manifest `security.hooks`; refreshed by `update`.

**Hook 3 — agent guard hook (.claude/settings.json).** A project-local Claude
Code hooks block that calls the guard at the model boundary:
- `UserPromptSubmit` → `gd-metapro security check-input --source untrusted-external`
  (screen content before it reaches the model);
- `PreToolUse` (Write/Edit) → `gd-metapro security check-output` (screen content
  before a file write).
Advisory by default (warn, non-blocking); enforced can block. Offered at `init`
with its own confirm prompt and `--no-security-agent-hook` flag. Installed
**merge-safe** into `.claude/settings.json` via a managed block/marker so an
existing user settings file is never clobbered.

Both hooks are no-ops / not installed when the `security` module is disabled, and
are removable.

## Out of Scope

- Security Phase 4 (model/API detection backends, gateway mode).
- Changing the guard/engine behavior or detectors.
- Global (non-project) agent config; only project-local `.claude/settings.json`.
- Non-Claude agent runtimes (codex/cursor/zed) — leave for a follow-up; the git
  hook covers all runtimes at the commit/push boundary.
