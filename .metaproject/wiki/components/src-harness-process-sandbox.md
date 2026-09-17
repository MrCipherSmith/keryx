---
Title: "Module src/harness/process/sandbox"
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/process/sandbox` groups 31 file(s). Depends on `src/harness/process`, `src/lib`, `src/harness/policy`. Exposes 17 public symbol(s)."
---

# Module src/harness/process/sandbox

## Summary

`src/harness/process/sandbox` owns the sandboxing layer for process execution inside the harness. It defines sandbox profiles, translates policy-derived constraints into concrete sandbox settings, detects available sandbox launchers, and exposes wrappers and adapters that other modules use to run commands under controlled restrictions.

The module is consumed by command execution, web harness flows, and stress-testing tooling whenever a process needs to be isolated from the surrounding environment.

## Overview

The module provides a bridge between high-level execution requirements and platform-specific sandbox mechanisms. It exposes reusable abstractions for describing what a sandboxed process may or may not access, and then turns those descriptions into runnable wrappers.

Its primary responsibilities are:

- defining default and policy-derived sandbox profiles,
- wrapping commands for sandbox execution,
- detecting and selecting a usable sandbox launcher,
- exposing a process adapter for callers that need sandboxed execution,
- providing helpers for restricted network runs.

The module depends on `src/harness/process` for process execution primitives, `src/harness/policy` for policy-shaped inputs, and `src/lib` for shared utilities.

## How it works

The module is organized around a small execution pipeline rather than a single monolithic runner.

### Profile layer

At the foundation are sandbox profile abstractions. The module exposes a default read deny list and a default sandbox profile that represent conservative baseline restrictions. It can also derive a profile from a higher-level policy shape, making it easier for callers to request a sandbox that reflects application or harness policy rather than hand-authored low-level settings.

For Seatbelt-style environments, the module can serialize a profile into a format understood by the sandbox launcher. This keeps profile construction separate from command wrapping.

### Wrapping layer

Once a profile exists, the module can wrap a command so it runs inside the sandbox. Wrapping is handled for both Seatbelt-style and bubblewrap-style launchers, with helper APIs for constructing the appropriate command arguments and invoking the launcher binary.

This separation lets higher-level callers request “run this command in a sandbox” without needing to know whether the underlying platform uses `sandbox-exec`, `bwrap`, or another mechanism.

### Detection and adapter layer

Not every environment exposes the same sandbox facilities. The module includes detection logic for discovering an available sandbox launcher and resolving an appropriate adapter. The adapter interface gives callers a stable way to launch sandboxed processes even when the underlying launcher differs.

This is the main integration surface for process execution. Callers can obtain an adapter and use it as the execution layer, while the sandbox module continues to handle argument construction and launcher selection underneath.

### Network layer

For networked runs, the module provides helpers for allowlisting traffic and preparing network execution context. These helpers support routing or mediation of outbound connections, matching targets against an allowlist, and creating certificate authority material for the run. This makes it possible to combine filesystem/process isolation with controlled network access.

### Module composition

The main entry point re-exports the public surface consumed by other modules. Internally, the functionality is split across files for profile handling, launcher detection, network support, command wrapping, and process adapters.

## Key concepts

### Sandbox profile

A sandbox profile is the module’s canonical representation of what a process is allowed to do. It is used as the input to platform-specific wrapping logic.

Public APIs:

- `defaultSandboxProfile`: the module’s baseline profile.
- `defaultReadDenyList`: default denied read paths or patterns used to restrict access.
- `sandboxProfileFromPolicy`: derives a profile from policy-shaped input.

### Sandbox launcher

A sandbox launcher is the external mechanism used to apply the sandbox around a command. The module supports wrappers for Seatbelt and bubblewrap-style launchers.

Public APIs:

- `SANDBOX_EXEC_PATH`: launcher path identifier for Seatbelt-style execution.
- `BWRAP_PROGRAM`: launcher program identifier for bubblewrap-style execution.

### Wrappers

Wrappers turn a profile and command into the actual sandboxed invocation.

Public APIs:

- `wrapSeatbelt`: wraps a command for Seatbelt-style execution.
- `wrapBwrap`: wraps a command for bubblewrap-style execution.
- `wrapWithSandbox`: generic wrapping helper used by callers that want a ready-to-run sandboxed command.
- `buildSeatbeltProfile`: produces the Seatbelt-facing profile representation.
- `buildBwrapArgs`: produces bubblewrap-facing arguments.

### Adapter and detection

The adapter layer makes sandboxed process execution callable from the rest of the system.

Public APIs:

- `detectSandboxLauncher`: identifies an available sandbox launcher.
- `resolveSandboxAdapter`: returns an adapter suitable for the current environment.
- `SandboxedProcessAdapter`: the adapter used to run sandboxed processes.

### Network controls

The network controls allow the module to support sandboxed execution with restricted outbound access.

Public APIs:

- `createAllowlistProxy`: creates a proxy layer for allowlisted network traffic.
- `matchesAllowlist`: evaluates whether a target matches the configured allowlist.
- `setupNetworkRun`: prepares execution context for a network run.
- `createRunCa`: creates certificate authority material for network execution.

## Main flows

### Flow 1: Resolve a sandbox adapter and run a command

1. A caller in `src/commands`, `src/harness/web`, or another consumer asks the sandbox module for a way to execute a sandboxed process.
2. The module uses detection logic to determine which sandbox launcher is available.
3. It resolves a `SandboxedProcessAdapter` appropriate for that environment.
4. The caller executes the command through the adapter.
5. Internally, the adapter uses profile and wrapping logic to construct the sandboxed invocation, while execution primitives come from `src/harness/process`.

This flow is the main integration point for higher-level callers that need sandboxed process execution but should not directly depend on low-level launcher details.

### Flow 2: Build a sandbox profile from policy

1. A caller starts with a policy from `src/harness/policy` or a desired sandbox shape.
2. The module derives or selects a profile using `sandboxProfileFromPolicy` or `defaultSandboxProfile`.
3. If needed, it augments or constrains the profile using `defaultReadDenyList`.
4. The resulting profile is passed to `buildSeatbeltProfile` or `buildBwrapArgs` depending on the chosen launcher.
5. The resulting wrapper is executed through `wrapWithSandbox` or an adapter.

This flow keeps policy interpretation separate from platform-specific command construction.

### Flow 3: Run a networked command with allowlisting

1. A caller needs to run a command that may perform network activity.
2. The module prepares the network execution context with `setupNetworkRun`.
3. `createAllowlistProxy` provides the network mediation layer, and `matchesAllowlist` is used to decide which targets are permitted.
4. `createRunCa` supports certificate-related material for the run.
5. The command is still launched through the sandbox adapter or wrapper, so filesystem/process isolation and network policy are applied together.

This flow lets the harness combine sandbox isolation with controlled outbound access in a single execution model.

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

This grouping reflects the module’s intended use: first describe the sandbox, then choose a launcher, then run the process, and optionally attach controlled network behavior.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

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

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/process](src-harness-process.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/policy](src-harness-policy.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/web](src-harness-web.md)
- [Module scripts/stress](scripts-stress.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections enriched for wiki review.
