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
// called (a tightened `deny` — or an `ask` with no `requestApproval` given,
// or one that answers no — refuses the spawn with no partial extension,
// matching `spawnChild`'s own fail-closed "no denial produces a partial
// result" contract); `stop()` fires the observe-only `SubagentStop` once the
// caller knows the child's outcome.
//
// Flow 306 fix (review round 1, finding 9): this wrapper still has NO
// production call site — `spawn-subagent-tool.ts`'s own internal-child path
// fires its `SubagentStart`/`SubagentStop` bracket directly (its
// `fireSubagentStart`/`fireSubagentStop` closures), AFTER `spawnSubagent`'s
// MAE admission (ledger reservation + depth/child caps) has already run,
// not before it the way this module's own doc comment above describes.
// Reordering that tool's admission-then-hook sequence to match this module
// exactly would mean moving a security-relevant gate (MAE admission) around
// inside an already deeply-nested, heavily fail-path-tested 1300+ line
// function for a purely structural unification — out of proportion to this
// fix round, and risking exactly the kind of admission/ledger regression
// findings 1-3 and 10 in this same review round were about. Kept as-is,
// deliberately: this module remains the tested REFERENCE shape for a future
// internal-child call site that genuinely needs "hook before admission"
// (e.g. a lighter-weight child spawn path that does not go through MAE at
// all), while `spawn-subagent-tool.ts` keeps its own bracket and gets its
// OWN regression coverage for the ask-fail-closed fix in this same round
// (`spawn-subagent-tool.hooks.test.ts`, "SubagentStart ask ALSO prevents
// runAgentTurn"/"...runExternal"). The `ask`-without-an-approver fail-closed
// fix below still applies to this module regardless — it is public, tested
// API surface with its own correctness contract independent of whether
// anything calls it in production today.
import type { HookRuntime } from "../hooks";
import { spawnChild } from "./spawn";
import type { ChildSpawnResult, SpawnChildDeps, SpawnChildInput } from "./spawn";

/** Identifiers `spawnChildWithHooks` needs to shape the `SubagentStart`/`SubagentStop` payloads. */
export interface SpawnChildWithHooksMeta {
  subagentId: string;
  parentSessionId: string;
  parentRunId: string;
  /**
   * Resolve a tightened `SubagentStart` `ask` to a live yes/no (flow 306, W6,
   * fix round 1, finding 4/9). Absent ⇒ an `ask` is refused exactly like a
   * `deny` — there is no default approver at this layer, so "no one answered"
   * must fail closed, never fail open to "allow". When given, it is awaited
   * ONLY when the composed outcome is actually `ask` (never for a plain
   * `allow`/`deny`), and its return value is the sole thing that decides the
   * spawn: `true` proceeds, anything else (including a rejection, which the
   * caller must handle — this function does not swallow it) refuses it.
   */
  requestApproval?: () => Promise<boolean>;
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
 * A composed `deny` returns `{ok:false}` and NEVER calls `spawnChild` — no
 * partial extension, session entry, or provenance escapes, matching
 * `spawnChild`'s own guard-order contract. A composed `ask` (flow 306, W6,
 * fix round 1, finding 4/9) is resolved via `meta.requestApproval` when one
 * is supplied — its answer decides the spawn — and refused exactly like
 * `deny` otherwise, regardless of `hooks.interactive`: `interactive` alone
 * is not an approval mechanism, only a signal about the SESSION, and this
 * function has no default UI to ask through. (Previously an `ask` on an
 * interactive runtime with no approver silently proceeded as `allow` — a
 * gate hook's `ask` failing OPEN.)
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
    let denied = fire.tightened === "deny";
    if (!denied && fire.tightened === "ask") {
      denied = meta.requestApproval === undefined ? true : !(await meta.requestApproval());
    }
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
