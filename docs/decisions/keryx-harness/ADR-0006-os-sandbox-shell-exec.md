# ADR-0006: OS sandbox for real shell execution (v1)

- **Status:** Accepted (flow 093); **Linux launcher choice superseded by
  [ADR-0010](./ADR-0010-linux-containment-without-privilege.md)** (2026-08-08)
- **Date:** 2026-07-21
- **Supersedes / relates to:** ADR-0003 (security profiles & containment) — this
  adds the OS-level enforcement layer under the policy engine defined there.

> **Superseded in part.** The Linux decision below (bubblewrap) and the
> "Deferred to v1.x" line on Landlock were both written on the assumption that
> unprivileged user namespaces are available. Ubuntu 23.10+ withdrew them, which
> makes bubblewrap unusable on a stock current Ubuntu and makes Landlock the
> mechanism rather than the hardening. Everything else here — the paradigm, the
> adapter integration, fail-closed, canonicalization — stands unchanged. See
> [ADR-0010](./ADR-0010-linux-containment-without-privilege.md).

## Context

Until now, keryx contained `shell_exec` with policy profiles + explicit approval
+ a structural argv guard (`runContainedProcess`). These decide **what** may run,
but once a command runs it has the **full permissions of the user**: a
prompt-injection that yields an approved-looking command can read `~/.ssh`, write
outside the workspace, or exfiltrate over the network.

Surveying the field (Codex CLI, grok-build, Claude Code vs opencode, pi) there
are two paradigms: real OS-kernel isolation, or approval-only (explicitly *not* a
security boundary). For a prod v1 that permits any auto/semi-autonomous shell
execution, approval-only is insufficient.

## Decision

Adopt the **grok-build / Codex model**: wrap each approved command in the
platform OS-sandbox launcher right before the single real spawn, enforced by the
kernel regardless of what the model chose to run.

**v1 posture — `workspace-write` + `network-off`, deny-by-default writes:**
- **macOS:** `sandbox-exec` (Seatbelt) with an allow-default + targeted-deny
  profile (deny writes outside cwd+tmp, deny secret reads, deny network).
- **Linux:** `bubblewrap` — `--ro-bind / /`, re-bind writable roots RW, `--tmpfs`
  mask on secrets, `--unshare-net` for network-off, plus `--die-with-parent`
  `--new-session` `--unshare-ipc`.
- **No new npm dependency:** launchers are system binaries → `dependencies: {}`
  stays empty (consistent with ADR-0005 dep policy).

**Integration:** a `SandboxedProcessAdapter` decorates the injected
`ProcessAdapter` port of `runContainedProcess`. The existing guard / env-allowlist
/ budget gates run unchanged on the **original** command (approval semantics
intact); only the launcher wrap is added under them. `keryx harness exec` builds
this by default.

**Fail-closed:** a missing launcher or unsupported platform yields a
`spawn-error` → `blocked` outcome (never a silent unsandboxed fallback) when the
profile is `required` or `failIfUnavailable` (default true). Escape hatches:
`KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` (no containment) and
`KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` (run unsandboxed when no launcher exists).

**Canonicalization:** writable roots are `realpath`'d before entering the
profile, because macOS `/tmp` and `/var` are symlinks the launcher matches on the
real path.

## Consequences

- Positive: an approved command can no longer write outside the workspace, read
  listed secrets, or reach the network under the default profile — verified on
  real macOS by the flag-gated live smoke.
- Negative: `sandbox-exec` is formally deprecated by Apple (accepted — Codex /
  Claude Code / grok-build all rely on it). Linux requires `bubblewrap`
  installed (`apt/dnf install bubblewrap`); Ubuntu 24.04 needs an AppArmor userns
  profile for `bwrap`.
- The pure builders (profile/seatbelt/bwrap/wrap) are deterministic and fully
  unit-tested offline; the only impure module is launcher detection.

## Alternatives considered

- **`@anthropic-ai/sandbox-runtime`** (Anthropic's extracted primitives) — ready
  made, but an npm dependency; would need optional-dep + ADR-0005 pinning. Kept
  as a fallback, not chosen.
- **microVM (pi/Gondolin) / full container** — stronger but heavy; offered as an
  optional external wrapper, not the default.
- **Approval-only (opencode/pi default)** — rejected as insufficient for prod.

## Deferred to v1.x

- Network **allowlist proxy** with per-domain approval + credential masking
  (Claude Code model) — v1 is binary network on/off (`--unshare-net`).
- **Landlock + seccomp** hardening on Linux (bwrap ro-bind already enforces the
  FS boundary).
- TLS inspection; native Windows (use WSL2).
