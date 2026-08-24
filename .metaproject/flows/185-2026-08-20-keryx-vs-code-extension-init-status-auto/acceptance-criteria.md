# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: docs/requirements/keryx-vscode-extension/specification.md §4
(AC1-AC9). AC3/AC9 explicitly modified per this flow's own environment
limitation (description.md) — no VS Code/vsce available here.

## Criteria

- AC1: `keryx status`'s 3-state result correctly drives the init-prompt flow (not-initialized and incomplete both prompt; ready does not) — verified by unit test against a mocked shell-out.
- AC2: Tree view auto-reveal is wired to fire within one activation cycle of a successful `keryx init --yes` run triggered by the extension — verified by unit test on the reveal-trigger logic (real VS Code UI reveal itself is not executable in this environment).
- AC3: NOT fully met (docpack standard: real Copilot Chat tool call, no VS Code/vsce available here). Delivered instead: `VSCODE_RUNTIME`'s config shape and merge/strip/validate logic verified by unit tests against the documented `.vscode/mcp.json` schema (sourced live via WebSearch/WebFetch against official current VS Code docs); end-to-end Copilot Chat verification remains an open follow-up.
- AC4: Status bar click-through names the specific failing check when the health/security signal is non-green — verified by unit test.
- AC5: Needs Your Attention node renders a real, legible empty state on a project with neither `flow` nor `sac` configured — dedicated test case.
- AC6: Every mutating extension action produces exactly one audit-log line in the output channel — verified by test.
- AC7: Hover provider renders a wiki snippet with a staleness indicator when the underlying MCP response exposes one, and does not fabricate confidence when it does not — verified by test.
- AC8: Activation warns (non-blocking) when the installed `keryx` version is below the extension's declared minimum — verified by unit test.
- AC9: NOT fully met (docpack standard: `vsce package`/Marketplace publish validation, `vsce` not available here). Delivered instead: `package.json` manifest hand-verified against VS Code's documented contribution-points schema (activation events, contributes.viewsContainers/views/commands, no undisclosed network access beyond loopback `keryx serve`); real `vsce package` validation remains an open follow-up.
