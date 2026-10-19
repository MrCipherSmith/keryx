---
Title: "Module src/harness/process/sandbox"
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/process/sandbox` groups 31 file(s). Depends on `src/harness/process`, `src/lib`, `src/harness/policy`. Exposes 17 public symbol(s)."
---
```markdown
---
Title: "Module src/harness/process/sandbox"
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/process/sandbox` owns the sandboxing layer for process execution inside the harness. It defines sandbox profiles, translates policy-derived constraints into concrete sandbox settings, detects available sandbox launchers, and exposes wrappers and adapters that other modules use to run commands under controlled restrictions."
---

# Module src/harness/process/sandbox

## Summary

`src/harness/process/sandbox` is the OS-containment layer under harness process execution. It projects a policy profile onto a sandbox profile (filesystem and network posture), wraps a command in the platform launcher (`sandbox-exec` on macOS, `bwrap` on Linux), and exposes a `ProcessAdapter` that applies this to the real spawn. Restricted-network runs additionally route traffic through a loopback allowlist proxy.

## Overview

The module bridges what a run may touch and the platform mechanism that enforces it. It takes a `PolicyProfile` (or a default posture), turns it into a `SandboxProfile`, and produces a launcher-wrapped command that the OS enforces on the child process, whatever command was chosen.

Its responsibilities are:

- projecting policy onto a sandbox profile (`sandboxProfileFromPolicy`, `defaultSandboxProfile`),
- defining the home-relative secret read deny list (`defaultReadDenyList`),
- wrapping a command for seatbelt or bubblewrap (`wrapWithSandbox`),
- detecting the launcher and resolving an adapter (`detectSandboxLauncher`, `resolveSandboxAdapter`),
- running restricted-network commands through a proxy (`setupNetworkRun`).

It depends on `src/harness/process` for the `ProcessAdapter` and `ContainedCommand` types in `executor`, and on `src/harness/policy` for the `PolicyProfile` type.

## How it works

The module is a small pipeline that separates deciding the posture from enforcing it.

### Profile layer

`profile.ts` is pure: it reads no clock, environment or filesystem, and callers pass in `cwd`, `tmpDir` and `home`. `sandboxProfileFromPolicy` maps the policy onto a `SandboxProfile` with a mode, a network posture, writable roots, a read deny list, allowed domains and a `required` flag. `defaultSandboxProfile` is the fixed baseline: workspace-write, network off, not required.

### Wrapping layer

`wrap.ts` dispatches on platform. `danger-full-access` passes through unwrapped, `darwin` goes to `wrapSeatbelt` (`seatbelt.ts`), `linux` goes to `wrapBwrap` (`bwrap.ts`), and any other platform returns a fail-closed reason. On Linux, `network: "restricted"` is refused, because bwrap alone cannot force traffic through the proxy.

### Detection and adapter layer

`detect.ts` is the only impure file. It checks for `sandbox-exec` at a fixed path on darwin, and searches `PATH` for `bwrap` on linux. It does not spawn anything. `resolveSandboxAdapter` builds a `SandboxedProcessAdapter` from the result and returns the launcher info alongside it.

`SandboxedProcessAdapter` decorates an inner `ProcessAdapter`. The enclosing `runContainedProcess` guards run on the original command first; the adapter then rewrites the command to its launcher form right before the single spawn. When the launcher is missing or the wrap is refused, it returns a `spawn-error` if the profile is `required`, the network is `restricted`, or `failIfUnavailable` is set (default true). Otherwise it spawns unsandboxed. A launcher exit code 71 on a wrapped command is also reported as a spawn error.

### Network layer

`network-run.ts` handles restricted runs. For any other posture, `setupNetworkRun` returns the profile unchanged. For `restricted`, it starts a proxy worker in a worker thread, so the proxy keeps serving while the main thread is blocked in `spawnSync`. It waits for the worker's ready port, sets `proxy` on the returned profile to `127.0.0.1` and that port, and returns proxy environment variables. Each masked credential gets a per-run sentinel in the child's environment; the real value stays in the worker. With `tlsTerminate`, the run CA certificate (created inside the worker, per the file's comment) is written to a temp PEM and the CA-trust variables point at it. The caller must call `close()`.

### Module composition

`index.ts` re-exports the public surface. The implementation is split across `profile.ts`, `detect.ts`, `wrap.ts`, `adapter.ts` and `network-run.ts`, with the platform builders in `seatbelt.ts` and `bwrap.ts`, and proxy and CA helpers in `proxy.ts` and `tls-ca.ts`.

## Key concepts

### Sandbox profile

A `SandboxProfile` is the canonical posture: a `SandboxMode` (`read-only`, `workspace-write`, `danger-full-access`), a `SandboxNetwork` (`off`, `on`, `restricted`), writable roots, the read deny list, allowed domains, an optional proxy address, and `required`, which means fail closed.

Public APIs:

- `defaultSandboxProfile`: the baseline profile when no policy applies.
- `defaultReadDenyList`: home-relative secret paths such as `.ssh`, `.aws`, `.config/gh`, `.config/keryx` and `.local/share/keryx`, which holds keryx's own credentials and approval allowlist.
- `sandboxProfileFromPolicy`: projects a policy profile onto a profile.

### Sandbox launcher

The external mechanism that applies containment: `sandbox-exec` (Seatbelt) on macOS and `bwrap` (bubblewrap) on Linux.

- `SANDBOX_EXEC_PATH`: the absolute path checked on macOS.
- `BWRAP_PROGRAM`: the program name searched for on `PATH` on Linux.

### Wrappers

Wrappers turn a profile and command into the launcher invocation.

- `wrapWithSandbox`: the platform dispatcher; returns a wrapped command, a pass-through, or a fail-closed reason.
- `wrapSeatbelt` and `buildSeatbeltProfile`: Seatbelt-facing wrapping and profile text.
- `wrapBwrap` and `buildBwrapArgs`: bubblewrap-facing wrapping and arguments.

### Adapter and detection

- `detectSandboxLauncher`: reports whether the launcher is available, with its path or a reason when it is not.
- `resolveSandboxAdapter`: builds the adapter for the current environment and returns the launcher info so callers can fail early.
- `SandboxedProcessAdapter`: the decorator that performs the wrapped spawn.

### Network controls

- `setupNetworkRun`: starts the proxy worker for restricted runs and returns the proxy-addressed profile and environment.
- `createAllowlistProxy` and `matchesAllowlist`: the allowlist proxy and host matching; these appear to be used by the proxy worker, and `proxy.ts` was not read in detail.
- `createRunCa`: creates the run CA for opt-in TLS termination; it appears to be used by the proxy worker (`tls-ca.ts`).

## Main flows

### Flow 1: Resolve a sandbox adapter and run a command

1. A caller, such as one in `src/commands`, has a `SandboxProfile` and an inner `ProcessAdapter`.
2. `resolveSandboxAdapter` calls `detectSandboxLauncher` to find the launcher for the platform.
3. It returns a `SandboxedProcessAdapter` together with the launcher info.
4. The caller spawns through the adapter. It wraps the command for the platform, and if the launcher is missing or the wrap is refused, it returns a `spawn-error` when the profile is fail-closed.
5. The inner adapter performs the one real spawn of the wrapped command.

### Flow 2: Build a sandbox profile from policy

1. A caller passes a `PolicyProfile` with `cwd`, `tmpDir`, `home` and any allowed domains to `sandboxProfileFromPolicy`. `dangerFullAccess` returns early with no containment.
2. The mode comes from `defaults.write`, the network from `defaults.network` and the allowed domains, and `required` from `requiredControls.isolation`. Writable roots are `cwd` and `tmpDir` unless the mode is read-only.
3. The read deny list is filled in from `defaultReadDenyList(home)`.
4. `wrapWithSandbox`, through `resolveSandboxAdapter`, selects the Seatbelt or bwrap builder by platform. On Linux, a `restricted` profile is refused at this step.

### Flow 3: Run a networked command with allowlisting

1. A caller with a `restricted` profile calls `setupNetworkRun`, optionally with credential masks and `tlsTerminate`.
2. The function starts the proxy worker in a worker thread, waits up to five seconds for its ready port, and returns the profile with `proxy` set to `127.0.0.1` and that port.
3. The worker rules on each host against the allowlist and reports each decision back, which is appended to `decisions`.
4. `envAdditions` supplies the `HTTP(S)_PROXY` variables, CA-trust variables when TLS is terminated, and sentinel values for masked credentials. The worker substitutes the real secret on the wire for the configured hosts.
5. The command is launched through the adapter, so the launcher allows only the proxy socket on macOS. The caller reads `decisions` and calls `close()` after the run. On Linux this flow fails closed, because `restricted` is not enforced there.

## Module boundaries

### Owns

- sandbox profile shape and defaults,
- policy-to-profile conversion helpers,
- Seatbelt and bubblewrap wrapping helpers,
- launcher detection and adapter resolution,
- network run helpers for allowlisting and CA preparation.

### Consumes

- `src/harness/process`: process execution primitives and related abstractions.
- `src/harness/policy`: policy inputs that can be translated into sandbox profiles.
- `src/lib`: shared utilities used across the module.

### Used by

- `src/commands`: command runners that need sandboxed execution.
- `src/harness/process`: process integration points.
- `src/harness/web`: web-related flows that execute sandboxed processes.
- `scripts/stress`: stress tooling that exercises sandboxed execution paths.
- `src/harness/tool/builtin`: built-in tools that may require sandboxing.

## Public surface notes

The public API can be grouped into four clusters:

- **Profiles**: `defaultReadDenyList`, `defaultSandboxProfile`, `sandboxProfileFromPolicy`
- **Platform wrappers**: `buildSeatbeltProfile`, `wrapSeatbelt`, `SANDBOX_EXEC_PATH`, `buildBwrapArgs`, `wrapBwrap`, `BWRAP_PROGRAM`, `wrapWithSandbox`
- **Adapters and detection**: `SandboxedProcessAdapter`, `detectSandboxLauncher`, `resolveSandboxAdapter`
- **Network execution helpers**: `createAllowlistProxy`, `matchesAllowlist`, `setupNetworkRun`, `createRunCa`

This grouping reflects the module's intended use: first describe the sandbox, then choose a launcher, then run the process, and optionally attach controlled network behavior.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by `--force`. The prose sections above are the agent/human-owned part.

### Public API

- `defaultReadDenyList`
- `defaultSandboxProfile`
- `sandboxProfileFromPolicy`
- `buildSeatbeltProfile`
- `wrapSeatbelt`
- `SANDBOX_EXEC_PATH`
- `buildBwrapArgs`
- `wrapBwrap`
- `BWRAP_PROGRAM`
- `wrapWithSandbox`
- `createAllowlistProxy`
- `matchesAllowlist`
- `setupNetworkRun`
- `SandboxedProcessAdapter`
- `detectSandboxLauncher`
- `resolveSandboxAdapter`
- `createRunCa`

### Key files

- `src/harness/process/sandbox/profile.ts` - imported by 21, imports 1
- `src/harness/process/sandbox/detect.ts` - imported by 11, imports 5
- `src/harness/process/sandbox/network-run.ts` - imported by 8, imports 2
- `src/harness/process/sandbox/index.ts` - imported by 0, imports 9
- `src/harness/process/sandbox/wrap.ts` - imported by 5, imports 4
- `src/harness/process/sandbox/adapter.ts` - imported by 5, imports 3

### Depends on

- `src/harness/process` - 11 import(s)
- `src/lib` - 3 import(s)
- `src/harness/policy` - 2 import(s)

### Depended on by

- `src/commands` - 8 import(s)
- `src/harness/process` - 5 import(s)
- `src/lib` - 4 import(s)
- `src/harness/web` - 2 import(s)
- `scripts/stress` - 1 import(s)
- `src/harness/tool/builtin` - 1 import(s)

### Entry points

- `src/harness/process/sandbox/index.ts`

### Graph signals

- Files: 31
- Cross-module imports: 16

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/process](src-harness-process.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/policy](src-harness-policy.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/web](src-harness-web.md)
- [Module scripts/stress](scripts-stress.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections enriched for wiki review.
```
