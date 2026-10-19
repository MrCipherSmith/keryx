# Module src/harness/hooks

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/harness/hooks` is the lifecycle hook runtime for `keryx shell`. It loads hook registrations from the built-in set and from user and project `hooks.json` files, selects and runs the ones that match an event, and folds their decisions and context into one result. It groups 21 file(s) and depends on `src/lib`, `src/harness/policy` and `src/harness/process/sandbox`.

## Overview

This module owns the lifecycle hook system for `keryx shell` (flow 306, W6). It defines the ten named events from `SessionStart` to `SessionEnd`, the configuration that declares which hooks run on them, and the runtime that executes those hooks and turns their output into decisions, additional context and invocation records. Its public surface is re-exported from `src/harness/hooks/index.ts`, whose header describes the module as usable standalone, with wiring into the run and agent paths left to later tasks.

## How it works

The module has three layers plus the built-in handlers.

- **Types** (`types.ts`) are side-effect free. They define `HookEventName`, the four `HookClass` values, the resolved `HookRegistration`, the per-event stdin payload shapes and `HookInvocationRecord`. `GATE_CAPABLE_EVENTS` and `PER_TOOL_EVENTS` decide which events can block and which events take a regex matcher over the tool name.
- **Config** (`config.ts`) produces the registration list. `loadHookConfig` reads `~/.keryx/hooks.json` (user scope) and `<project>/.metaproject/hooks.json` (project scope), validates each file against the bundled schema, and merges both over `BUILTIN_HOOK_REGISTRATIONS` in the order built-in, user, project. The loader is fail-closed: any diagnostic makes the whole load return `ok: false`. Overrides can only disable a hook. A project file cannot disable a protected built-in gate, and a user-scope disable needs an explicit acknowledgement. Project registrations are checked against a trust digest from `trust.ts`, and untrusted or changed ones are removed from the list rather than only disabled. A `KERYX_HOME` that points inside the project is ignored.
- **Runtime** (`runtime.ts`) is `createHookRuntime`, which returns a `HookRuntime`. `fire()` selects candidates by event, profile and matcher, then sorts them by `order` and `id`. Gate and gate-advisory hooks run one at a time, and the first `deny` stops the rest for that event. Observe and context hooks run in parallel, and each is raced against its own timeout. Every failure is turned into an outcome through `failureEffect` in `semantics.ts`, and `runOneHook` catches throws so they do not escape `fire()`. Command hooks go through an injected `HookProcessRunner`, and their output is parsed by `codec.ts`. Built-in handlers run in-process through ports.
- **Built-in handlers** are dispatched by name in `runBuiltinHook`. `learning-observer` forwards the event to a learning sink. `impact-evidence` asks an evidence provider about the files a call touches. `resolveBuiltinCommandRunsIn` runs built-in command gates unsandboxed unless the active profile requires fail-closed isolation.

For `UserPromptSubmit`, `Stop` and `SubagentStart`, `fire()` folds the decisions into a `tightened` outcome through `tightenOutcome` in `compose.ts`. For `PreToolUse`, that composition happens outside this module, against the policy engine's own decision.

`forChild` derives a restricted runtime for a spawned child agent. It keeps only the registrations the parent would let a child inherit, sets `interactive` to `false`, and starts with fresh per-child state, so the child never has an interactive approver.

## Key concepts

- **Hook class** sets how a hook's output and failures are treated. `gate` is fail-closed in every profile and honours its decision on a gate-capable event. `gate-advisory` also honours its decision, but its failure handling depends on the profile. `observe` only produces side effects, its decision is never honoured, and it fails open. `context` may add `additionalContext` but never a decision, and it also fails open.
- **Registration** (`HookRegistration`) is a hook after merge. Its `scope` (`builtin`, `user` or `project`), `order` and `id` decide precedence. A `keryx.`-prefixed id is reserved for built-ins.
- **Handler** is either a `command` (an argv that is never shell-interpolated) or a `builtin` (a name dispatched in-process).
- **Gate-capable events** are `PreToolUse`, `UserPromptSubmit`, `Stop` and `SubagentStart`. The per-tool events `PreToolUse`, `PostToolUse` and `PostToolUseFailure` match their `matcher` against the tool name.
- **Trust state** of a project file is `untrusted`, `changed` or trusted, judged by the digest of its full registrations.
- **HookFireResult** carries `decisions`, the optional `tightened` outcome and `denyReason`, the collected `additionalContext`, the invocation `records`, plus `warnings` and `anomalies`. Anomaly names include `hook-timeout`, `hook-crashed`, `hook-malformed-output` and `hook-sandbox-unavailable`.
- **Impact-evidence acknowledgement**: after an operator approves an impact-evidence `ask`, `acknowledgeImpactEvidence` records the files, and the next request for them carries `acknowledgement: "operator-approved"`. This only applies when every file in the call has been approved.

## Main flows

1. **Config load.** `loadHookConfig` reads both files through an injectable `readFile`, runs `validateHookConfigDocument` on each (schema version major `1`, then the bundled schema), and passes them to `resolveHookRegistrations`. That merges them over the built-ins and applies disable-only overrides. It then digests the project registrations with `digestProjectHooks` and drops any project hook whose trust state is `untrusted` or `changed`.

2. **A PreToolUse gate.** A caller invokes `fire("PreToolUse", payload, { toolName })`. `selectCandidates` filters by event, profile and matcher, and the gate group runs in order through `runOneHook`. For a command hook, `runCommandHook` builds the stdin with `buildHookStdin`, the environment with `buildHookEnv` and the argv with `resolveKeryxArgv`, then calls `runner.run`. The result goes through `parseHookResult`. A failure becomes a `buildFailureOutcome`, whose effect comes from `failureEffect`. The first `deny` ends the gate group. `fire()` returns the decisions, and the caller composes them with the policy decision.

3. **The impact-evidence built-in.** `runBuiltinHook` takes the target files from `extractFilePathsFromToolInput`. That covers single-path tools and the `patch` field of `apply_patch`, including rename and copy sources. It skips the call when every file has already been cleared for the session in `editedFiles`. Otherwise it calls the evidence provider under `runWithTimeout`, sends the acknowledgement if every file was operator-approved, and marks files clean only on a non-escalating outcome. A timeout, crash or service failure leaves them unmarked, so a retry asks again.

---

<!-- keryx:reference:begin v=1 hash=153298fa83375aa62303b02344e5c4a475339808d584c4815199dfa81607f1d8 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Key files

- `src/harness/hooks/index.ts` - imported by 16, imports 10
- `src/harness/hooks/runtime.ts` - imported by 9, imports 9
- `src/harness/hooks/guard.test.ts` - imported by 0, imports 17
- `src/harness/hooks/types.ts` - imported by 14, imports 1
- `src/harness/hooks/config.ts` - imported by 5, imports 8
- `src/harness/hooks/failure-matrix.test.ts` - imported by 0, imports 13

### Depends on

- `src/lib` - 8 import(s)
- `src/harness/policy` - 8 import(s)
- `src/harness/process/sandbox` - 3 import(s)
- `src/harness/context` - 1 import(s)
- `src/contracts` - 1 import(s)

### Depended on by

- `src/commands` - 6 import(s)
- `src/harness/run` - 2 import(s)
- `src/lib` - 2 import(s)
- `src/harness/child` - 1 import(s)
- `src/harness/tool/builtin` - 1 import(s)

### Dependency basis

- Production imports only: 44 import(s) from test file(s) (e.g. `src/commands/agent-hooks.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/harness/hooks/index.ts`

### Graph signals

- Files: 21
- Cross-module imports: 21
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/policy](src-harness-policy.md)
- [Module src/harness/process/sandbox](src-harness-process-sandbox.md)
- [Module src/harness/context](src-harness-context.md)
- [Module src/contracts](src-contracts.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/run](src-harness-run.md)
- [Module src/harness/child](src-harness-child.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
