# Policies — Sandbox Harness Hardening
Version: 0.1.0

## P-SEC-1 — Mask implies TLS (fail-closed)

Non-empty credential masks **must not** run a successful contained process without
TLS termination (explicit or auto-derived under `maskMode=auto`). Applies to:

- `shell_exec` restricted path;
- `keryx harness exec` mask flags / env.

Violation → blocked / tool error. **No** silent ignore of `--mask-env`.

## P-SEC-2 — No secrets in probe artifacts

RUN_DIR, REPORT, logs, and committed fixtures must not contain real API keys.
Synthetic fixtures only (`sk-fixture-…`, `sk-test-…`). Redaction hit → overall FAIL.

## P-OPS-1 — CONTROL required for deny claims

A deny verdict without a successful unsandboxed CONTROL is **UNKNOWN**, not PASS.
Documented false-pass rule from Linux verification runbook applies to all platforms.

## P-OPS-2 — Decisions over exit codes (restricted network)

For restricted allowlist, **`network.decisions`** is authoritative. HTTP clients
may exit 0 on proxy 403. Agents must not claim network success from exitCode alone.

## P-OPS-3 — Do not weaken sandbox to debug

Operators and agents must not set `KERYX_DANGEROUSLY_DISABLE_SANDBOX` or
`KERYX_SANDBOX_ALLOW_UNSANDBOXED` to “make the probe green.” Those flags are
human-only escape hatches and invalidate the run for security claims.

## P-UX-1 — Prefer portable one-shot probe

Multi-step interactive thrash is not a substitute for the portable probe script
once H2 lands. Agents should run the script when asked for deep verification.

## P-COMPAT-1 — Platform honesty

Linux restricted/mask/TLS remain **fail-closed** until the OS package says
otherwise. Probe must SKIP or document expected block — never claim full matrix green on Linux for macOS-only features.
