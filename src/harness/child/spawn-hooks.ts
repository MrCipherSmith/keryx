// `spawnChild()` wrapped with `SubagentStart`/`SubagentStop` hook firing (flow
// 306, W6, task T6).
//
// `spawnChild` (`./spawn.ts`) is deliberately synchronous and pure; T6's plan
// asks for an ASYNC wrapper rather than making `spawnChild`/`spawnSubagent`
// themselves async, because `spawnSubagent` (`./orchestrate.ts`) has exactly
// one production call site (`src/harness/tool/builtin/spawn-subagent-tool.ts`)
// that is already async and free to fire hooks around it directly — making
// the pure primitive itself async would only churn every one of its ~35
// existing synchronous test call sites (`spawn.test.ts`) for no behavioural
// gain. This module is the internal-child analogue of that same tool file's
// external-path hook wiring: `SubagentStart` fires BEFORE `spawnChild` is ever
// called (a tightened `deny` — or an `ask` under a non-interactive runtime,
// which reads as `deny` here since there is no interactive approver at this
// layer — refuses the spawn with no partial extension, matching `spawnChild`'s
// own fail-closed "no denial produces a partial result" contract); `stop()`
// fires the observe-only `SubagentStop` once the caller knows the child's
// outcome.
import type { HookRuntime } from "../hooks";
import { spawnChild } from "./spawn";
import type { ChildSpawnResult, SpawnChildDeps, SpawnChildInput } from "./spawn";

/** Identifiers `spawnChildWithHooks` needs to shape the `SubagentStart`/`SubagentStop` payloads. */
export interface SpawnChildWithHooksMeta {
  subagentId: string;
  parentSessionId: string;
  parentRunId: string;
}

export type SpawnChildWithHooksResult =
  | (Extract<ChildSpawnResult, { ok: true }> & {
      /** Fire the observe-only `SubagentStop` for this child. No-op when no `hooks` was supplied. */
      stop: (outcome: string) => Promise<void>;
    })
  | { ok: false; reason: string };

/**
 * Spawn a bounded internal child, gated by an optional `SubagentStart` hook
 * fired BEFORE `spawnChild` is invoked at all. `hooks` absent ⇒ byte-identical
 * to calling `spawnChild(input, deps)` directly (D1), plus a `stop()` that is
 * simply a no-op.
 *
 * A composed `deny` (or a tightened `ask` when `hooks.interactive` is
 * `false`, since there is no interactive approver at this layer to resolve
 * an `ask` — the same headless fail-closed posture `composeDecision`/
 * `tightenOutcome` apply everywhere else) returns `{ok:false}` and NEVER
 * calls `spawnChild` — no partial extension, session entry, or provenance
 * escapes, matching `spawnChild`'s own guard-order contract.
 */
export async function spawnChildWithHooks(
  input: SpawnChildInput,
  deps: SpawnChildDeps,
  hooks: HookRuntime | undefined,
  meta: SpawnChildWithHooksMeta,
): Promise<SpawnChildWithHooksResult> {
  if (hooks !== undefined) {
    const fire = await hooks.fire("SubagentStart", {
      sessionId: meta.parentSessionId,
      runId: meta.parentRunId,
      subagentId: meta.subagentId,
      parentSessionId: meta.parentSessionId,
      spawnKind: "internal",
      inheritedHookIds: hooks.inheritedHookIds(),
    });
    const denied = fire.tightened === "deny" || (fire.tightened === "ask" && !hooks.interactive);
    if (denied) {
      return {
        ok: false,
        reason: `subagent spawn denied by hook <${fire.denyReason ?? "SubagentStart"}>: composed outcome ${fire.tightened}`,
      };
    }
  }

  const spawned = spawnChild(input, deps);
  if (!spawned.ok) {
    return spawned;
  }

  const stop = async (outcome: string): Promise<void> => {
    if (hooks === undefined) return;
    await hooks.fire("SubagentStop", {
      sessionId: meta.parentSessionId,
      runId: meta.parentRunId,
      subagentId: meta.subagentId,
      outcome,
    });
  };

  return { ...spawned, stop };
}
