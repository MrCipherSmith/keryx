---
Title: Module src/harness/process
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/process` is the harness module for running commands through a contained process execution boundary. It defines public types for describing a command, observing process activity, and returning a final outcome, and it provides helpers for shell-oriented sandbox and spawn configuration."
---
# Module src/harness/process

## Summary

`src/harness/process` is the harness module for running commands through a contained process execution boundary. It defines public types for describing a command, observing process activity, and returning a final outcome, and it provides helpers for shell-oriented sandbox and spawn configuration.

## Overview

This module owns the contract that other harness code uses to run a command without touching the host process layer directly. Its entry point is `runContainedProcess`, a fail-closed decision core that checks an approved command, consults an injected `ProcessAdapter` exactly once, and classifies the adapter's observation into a typed outcome. It also holds the shell planning that turns harness and sandbox settings into a sandboxed spawn: sandbox mode, restricted masks, extra read-deny roots, the shell environment, and the final `SandboxSpawnPlan`. The executor reuses existing security primitives (`guardAction`, `actionFingerprint`, `inheritBudget`) rather than reimplementing them. The sandbox code lives in `src/harness/process/sandbox`, and the module is consumed by `src/commands` and `src/harness/tool/builtin`.

## How it works

The module has an offline decision core and a single side-effecting port, with shell planning alongside.

The executor side (`executor.ts`) is deterministic. `runContainedProcess` runs three deny gates before any side effect: the `guardAction` structural check, an environment allowlist that rejects any key on `command.env` missing from `envAllowlist` (only the key name is reported, never the value), and `inheritBudget` against the parent's remaining runtime. Only then does it call `adapter.spawn(command)`, once. The clock and id source arrive through `RunContainedProcessDeps`, so receipts and evidence are reproducible. The observation alone drives classification: `clean-exit` becomes `completed` with the real exit code, even when it is non-zero; `deadline-exceeded` becomes `timeout`; overflow and cancellation get their own outcomes; and `spawn-error` or an unknown kind becomes `blocked`. The `timeout`, `output-overflow` and `cancelled` outcomes carry an `indeterminate` receipt, not a success.

The adapter side is the only place a real process is created. `real-process-adapter.ts` implements `ProcessAdapter` with `spawnSync` and is gated behind `allowRealSubprocess` or `KERYX_ALLOW_REAL_SUBPROCESS=1`. Its exported pure function `classifyProcessResult` maps a spawn result to an observation, so the rules can be tested without spawning anything. Deadline kills are leader-only: the direct child is killed, but grandchildren are not group-reaped. The `observedHash` covers the command identity (path and argv), not captured output, so output that may contain secrets never reaches evidence.

Shell planning (`shell-spawn.ts`) sits beside the executor. `resolveShellSandboxMode` reads `KERYX_DANGEROUSLY_DISABLE_SANDBOX`, then `KERYX_SANDBOX_SHELL` or the saved sandbox config, to choose `off`, `workspace` or `strict`. `resolveShellEnv` starts from the operator's environment, withholds credentials keryx saved from its config (unless `KERYX_SHELL_PASS_SAVED_KEYS=1`), and marks the child with `KERYX_TOOL_CALL=1`. `resolveShellSpawn` builds the plan. In `off` mode it returns a plain `/bin/sh -c` spawn. Otherwise it fails closed if the sandbox launcher is missing, starts a restricted-network proxy when allowed domains are set, and wraps the command with `wrapWithSandbox`.

## Key concepts

- **ContainedCommand** — An approved `path`, `argv`, `env` and `cwd`, passed unchanged to `adapter.spawn`.
- **ProcessAdapter** — The single side-effecting port. Its `spawn` returns one `ProcessObservation`.
- **ProcessObservation / ProcessObservationKind** — What the adapter saw: `clean-exit`, `deadline-exceeded`, `output-overflow`, `cancelled` or `spawn-error`, with exit code, output bytes, termination mode and observed hash.
- **ContainedProcessOutcome** — The typed result: `completed`, `timeout`, `output-overflow`, `cancelled` or `blocked`. Only `completed` confirms an effect. `blocked` carries a reason and no receipt, and it also covers spawn errors, because no effect boundary was crossed.
- **RunContainedProcessInput / RunContainedProcessDeps** — The approval surface (worktree root, env allowlist, policy profile, risk, budget, output limit) plus the injected `idSeq` and `clock`.
- **ShellSandboxMode** — `off`, `workspace` or `strict`. `strict` turns network off unless domains are allowed.
- **SandboxSpawnPlan** — The `spawnArgs`, final `env`, and `netClose` hook for the restricted-network proxy.
- **Resolution helpers** — `resolveShellEnv`, `resolveShellSpawn`, `resolveShellRestrictedMasks` and `extraReadDenyRoots` turn harness and sandbox settings into concrete spawn inputs.

## Main flows

### Run a contained process

A caller passes a `RunContainedProcessInput` and `RunContainedProcessDeps` to `runContainedProcess`. The structural guard, env allowlist and budget gates run in that order. If all three pass, `adapter.spawn` runs once and its observation is classified. A clean, in-bounds exit yields `completed`, with an `EvidenceRecord` and an `evidence:` reference. A caller-set `cancelled` flag turns even a clean exit into `cancelled`. Deadline, overflow and cancellation return `timeout`, `output-overflow` and `cancelled` receipts marked `indeterminate`.

### Resolve a shell spawn plan

`resolveShellSpawn(root, command, baseEnv)` reads the sandbox mode from `process.env`. In `off` mode it returns a plain `/bin/sh -c` spawn with the given env. Otherwise it checks the launcher through `detectSandboxLauncher` and returns an error instead of running unsandboxed. If the profile is network-restricted, `resolveShellRestrictedMasks` and `setupNetworkRun` set up a proxy that injects real credential values for allowed hosts, and its env additions are merged in. `wrapWithSandbox` then produces the wrapped argv. If wrapping is refused, the proxy is closed before the error is returned.

### Real adapter interaction

Only `RealProcessAdapter` spawns a real process. Its constructor throws unless `allowRealSubprocess` (or the env flag) is set, so the offline executor suite never reaches a real process. `spawn` runs `spawnSync` in `command.cwd` with the approved env, a SIGKILL deadline, and a `maxBuffer` hard cap, then passes the result to `classifyProcessResult`. A signal that was not the adapter's own deadline is reported as `spawn-error`, not as a timeout. Exit codes and output sizes are reported as observed. `real-process-adapter.classify.test.ts` exercises the classifier.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `ContainedCommand`
- `ProcessObservationKind`
- `ProcessObservation`
- `ProcessAdapter`
- `ContainedProcessOutcome`
- `RunContainedProcessInput`
- `RunContainedProcessDeps`
- `runContainedProcess`
- `ShellSandboxMode`
- `SandboxSpawnPlan`
- `resolveShellSandboxMode`
- `extraReadDenyRoots`
- `resolveShellRestrictedMasks`
- `resolveShellEnv`
- `resolveShellSpawn`

### Key files

- `src/harness/process/executor.ts` - imported by 15, imports 7
- `src/harness/process/shell-spawn.ts` - imported by 5, imports 8
- `src/harness/process/executor.test.ts` - imported by 0, imports 6
- `src/harness/process/real-process-adapter.ts` - imported by 4, imports 1
- `src/harness/process/shell-env.test.ts` - imported by 0, imports 4
- `src/harness/process/real-process-adapter.classify.test.ts` - imported by 0, imports 2

### Depends on

- `src/harness/process/sandbox` - 5 import(s)
- `src/harness/mutation` - 2 import(s)
- `src/lib` - 2 import(s)
- `src/harness/child` - 1 import(s)
- `src/harness/evidence` - 1 import(s)
- `src/harness/policy` - 1 import(s)

### Depended on by

- `src/harness/process/sandbox` - 5 import(s)
- `src/commands` - 2 import(s)
- `src/harness/tool/builtin` - 2 import(s)

### Dependency basis

- Production imports only: 17 import(s) from test file(s) (e.g. `src/commands/harness-exec-extension-wave.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 7
- Cross-module imports: 15

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/process/sandbox](src-harness-process-sandbox.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/evidence](src-harness-evidence.md)
- [Module src/harness/policy](src-harness-policy.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
