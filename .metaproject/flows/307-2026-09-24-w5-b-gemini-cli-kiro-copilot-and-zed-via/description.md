# W5-b: Gemini CLI, Kiro, Copilot and Zed-via-ACP adapters, generated capability matrix, keryx integrations CLI

Status: formalized
Source: agent-platform-expansion program, Wave 1 (docs/requirements/keryx-agent-platform-expansion/implementation-plan.md), spec workstreams/W5-multi-harness.md

## Problem

W5-a (flow 305) unified the three host-hook registries into `src/integrations/`, but the registry still
covers only the harnesses that existed before the workstream. Gemini CLI, Kiro and GitHub Copilot agent have
no entry at all; Zed is registered as an empty `instruction-only` row although Keryx already enforces a
deny-by-default permission mapping when it runs as Zed's ACP agent (`src/acp/permission.ts`). There is no
generated capability matrix, so "which harness supports what" is still an unchecked claim, and operators still
use three differently-shaped installer commands with no install-state and no doctor.

## Expected Outcome

- Registry adapters for `gemini-cli`, `kiro`, `github-copilot-agent` (block + instructions surfaces, experimental,
  first-party source URLs and risk notes), `zed` as `policy-travels-with-agent` (block verified via ACP), and
  `keryx-shell` as a placeholder row W6 fills.
- A capability matrix generated from the registry, checked in, schema-validated, drift-guarded by a test and a CI
  step (`keryx integrations matrix --check`).
- `keryx integrations install|doctor|uninstall|matrix` with per-target install-state and a probe for non-JSON
  surfaces.
- Legacy installers (`ctx install-hook/uninstall-hook`, `orient install-hook/uninstall-hook`,
  `security hooks install/uninstall`) delegate to the same installer core, output unchanged.

## Out of Scope

- W6 hook runtime (`src/harness`), W8 audit (`src/security` audit) — parallel worktrees.
- `keryx ctx hook <runtime>` handler code, `keryx harness run|exec|extension|wave`.
- MCP client-config ownership (`src/mcp/client-config.ts`, `keryx integrate`): the W5 spec does not require moving
  it; recorded as a follow-up.
- Promoting any existing adapter's confidence; resolving OQ-3.
