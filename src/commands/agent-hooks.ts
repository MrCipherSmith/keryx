// Production wiring for `keryx shell`'s lifecycle hook runtime (flow 306, W6, T9).
//
// `src/harness/hooks/` (T5) is the standalone, side-effect-free runtime —
// deliberately NOT wired into any real entry point yet. This module is that
// wiring for `keryx shell`'s own agent loop (`src/commands/agent.ts`): it
// loads `~/.keryx/hooks.json` + `.metaproject/hooks.json`, merges them over
// the built-ins, and builds one `HookRuntime` per session/run.
//
// Off-limits per the flow 306 dispatch: `src/harness/hooks/*` itself, and the
// other worker's files (`src/harness/run/run.ts`, `src/harness/child/*`,
// `spawn-subagent-tool.ts`, `src/harness/session/types.ts`, `src/commands/
// hooks.ts`, `src/cli.ts`). This file only CONSUMES the T5 runtime's public
// surface (`src/harness/hooks/index.ts`).
import os from "node:os";
import {
  createHookRuntime,
  createRealHookRunner,
  loadHookConfig,
  type HookRegistration,
  type HookRuntime,
} from "../harness/hooks";
import type { PolicyProfileId } from "../harness/policy/types";

/**
 * `executeCall`'s Keryx tool names, mapped to the Claude-Code-shaped name a
 * built-in/host hook matcher expects (`hook-config.schema.json`'s `matcher`
 * is a regex over THIS aliased name, e.g. `keryx.ctx-guard`'s `Bash`,
 * `keryx.security-check-output`'s `Write|Edit` — see
 * `docs/requirements/keryx-agent-platform-expansion/workstreams/
 * W6-shell-hooks.md`'s "Built-in Keryx hooks registered" table). A tool with
 * no entry here is aliased to itself unchanged (most builtin tools have no
 * Claude-Code equivalent and are matched by their own Keryx name).
 *
 * The original Keryx tool name always still reaches the hook as
 * `keryxToolName` in the payload (see `firePreToolUseHook` in `agent.ts`) —
 * this map only changes what a `matcher` regex is tested against.
 */
export const HOOK_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  shell_exec: "Bash",
  apply_patch: "Edit",
};

/** Map a Keryx tool name to the alias a hook `matcher` is tested against. */
export function aliasHookToolName(keryxToolName: string): string {
  return HOOK_TOOL_NAME_ALIASES[keryxToolName] ?? keryxToolName;
}

/**
 * Derive the `PolicyProfileId` a hook's `PreToolUse`/`UserPromptSubmit` fire
 * runs under, from the same two session-scoped signals `executeCall` already
 * reads for its own gate: `unattended` (SLATE-8/flow 290's `AgentDeps.
 * unattended`, mirrored here as `!interactive` since `HookRuntime.interactive
 * = deps.unattended !== true`, T9 rule 5) and the live `/plan` read-only
 * toggle (`AgentIO.readOnly`). Neither is cached — read fresh on every call,
 * exactly like `executeCall`'s own `mode`/`isReadOnly` locals, so a live
 * `/plan` toggle changes the very next tool call's hook profile too.
 */
export function derivePolicyProfileId(interactive: boolean, readOnly: boolean): PolicyProfileId {
  if (!interactive) return "unattended-untrusted";
  if (readOnly) return "read-only-review";
  return "monitored-trusted-local";
}

/**
 * A `HookRuntime` bundled with the session/run identity fields every fired
 * payload needs (`HookPayloadBase.sessionId`/`.runId`) but that `HookRuntime`
 * itself does not expose publicly (`src/harness/hooks/runtime.ts` is off
 * limits for this task — it keeps them private). `AgentDeps.hooks` carries
 * this shape rather than a bare `HookRuntime` for exactly that reason.
 */
export interface ShellHookContext {
  runtime: HookRuntime;
  sessionId: string;
  runId: string;
}

/**
 * A `HookRuntime` whose every gate-capable `fire()` (`PreToolUse`/
 * `UserPromptSubmit`/`Stop`/`SubagentStart`) denies with reason
 * `hook-config-invalid`, and whose observe/context events return no
 * decision/context. Used by {@link buildShellHookRuntime} when
 * `loadHookConfig` reports `ok: false`: the spec is explicit that an invalid
 * config must never be silently dropped down to "hooks disabled" (that would
 * let a broken/tampered project file silently weaken enforcement to nothing)
 * — instead every gate a hook COULD have covered now fails closed until the
 * config is fixed, and the diagnostics are surfaced loudly by the caller
 * (`keryx hooks validate` / a startup warning), not swallowed here.
 */
function createInvalidConfigRuntime(interactive: boolean): HookRuntime {
  const denyRecord = {
    hookId: "keryx.hook-config-invalid",
    class: "gate" as const,
    scope: "builtin" as const,
    outcome: "deny" as const,
    failure: "malformed" as const,
    reason: "hooks.json failed to load; every PreToolUse/UserPromptSubmit is denied until it is fixed (see `keryx hooks validate`).",
    durationMs: 0,
    changedOutcome: true,
  };
  const self: HookRuntime = {
    interactive,
    registrations: () => [],
    inheritedHookIds: () => [],
    // T13: a child of an invalid-config runtime stays fail-closed too — there
    // is nothing safe to inherit from a config that never loaded. `ids` is
    // accepted (interface conformance) but unused: every `fire()` on this
    // runtime denies purely from the event name, never from session/run
    // identity.
    forChild: (_ids) => createInvalidConfigRuntime(false),
    async fire(event, _payload, _ctx) {
      const isGate = event === "PreToolUse" || event === "UserPromptSubmit" || event === "Stop" || event === "SubagentStart";
      return {
        decisions: isGate ? [{ hookId: denyRecord.hookId, decision: "deny" }] : [],
        ...(isGate ? { tightened: "deny" as const, denyReason: "hook-config-invalid" } : {}),
        additionalContext: [],
        records: isGate ? [{ ...denyRecord, event }] : [],
        warnings: [{ name: "hook-malformed-output", hookId: denyRecord.hookId, detail: "hooks.json invalid" }],
        anomalies: [],
      };
    },
  };
  return self;
}

export interface BuildShellHookRuntimeOptions {
  projectRoot: string;
  sessionId: string;
  runId: string;
  interactive: boolean;
  profileId: PolicyProfileId;
  /** Injectable clock (tests); defaults to `() => new Date().toISOString()`. */
  clock?: () => string;
  /** Injectable home dir (tests); defaults to `os.homedir()`. */
  homeDir?: string;
  /** Injectable env (tests); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Surfaced diagnostics sink for a config-load failure (tests / callers that want to log it). */
  onConfigError?: (diagnostics: readonly { code: string; message: string }[]) => void;
}

/**
 * Build the production `HookRuntime` for one `keryx shell` session/run —
 * loads both config files via `loadHookConfig`, merges over the built-ins,
 * and spawns real hook commands via `createRealHookRunner`.
 *
 * Opt-out: `KERYX_HOOKS=off` (checked against the injected/real env) disables
 * the runtime entirely — returns `undefined`, byte-identical to
 * `AgentDeps.hooks` never having been wired at all. Every existing test/call
 * site that predates hooks already omits `AgentDeps.hooks`, so this is purely
 * additive.
 */
export function buildShellHookRuntime(opts: BuildShellHookRuntimeOptions): ShellHookContext | undefined {
  const env = opts.env ?? process.env;
  if (env.KERYX_HOOKS === "off") {
    return undefined;
  }
  const clock = opts.clock ?? (() => new Date().toISOString());
  const homeDir = opts.homeDir ?? os.homedir();
  const loaded = loadHookConfig({ projectRoot: opts.projectRoot, homeDir });
  let registrations: readonly HookRegistration[] | undefined;
  let runtime: HookRuntime;
  if (loaded.ok) {
    registrations = loaded.registrations;
    runtime = createHookRuntime({
      registrations,
      runner: createRealHookRunner({ projectRoot: opts.projectRoot }),
      clock,
      profileId: opts.profileId,
      interactive: opts.interactive,
      sessionId: opts.sessionId,
      runId: opts.runId,
      projectRoot: opts.projectRoot,
    });
  } else {
    opts.onConfigError?.(loaded.diagnostics);
    runtime = createInvalidConfigRuntime(opts.interactive);
  }
  return { runtime, sessionId: opts.sessionId, runId: opts.runId };
}
