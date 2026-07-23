# P0 sandbox credential auto-mask

## Problem

Sandboxed shell_exec / harness exec only mask credentials when operators
manually set `KERYX_SANDBOX_MASK_ENV` + TLS. Keys already in `auth.json` are
injected cleartext into the child unless mask env is set.

## Expected outcome (this flow only)

- Pure `resolveCredentialMasks` shared by shell_exec and harness exec.
- Auto-derive masks from provider registry + Anthropic when `maskMode=auto`.
- **P0.a default:** unset `KERYX_SANDBOX_MASK_MODE` ⇒ `manual` (no behavior surprise).
- Wire both call sites; AC1–AC8 green; no secrets in fixtures.

## Out of scope

- P1 `sandbox.json`, P2 project policy/init, live dual-axis Verify, P0.b default=auto.
