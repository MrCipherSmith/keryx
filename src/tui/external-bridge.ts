// External-agent bridge: `runExternal` factory → mounted TUI (flow 176, T18).
// Package: docs/requirements/keryx-external-agent-runtime §7.5, §8.2; prd R17, R25.
//
// Structural twin of `subagent-bridge.ts` and `job-bridge.ts`, and for the same
// reason: `commands/shell.ts` builds the agent's tools — including the
// `runExternal` hook — BEFORE any renderer exists, while the thing that wants
// the run signals (the `ExternalRunStore`, the sidebar, the inspector) is
// created when the TUI mounts. A module-level listener is what lets the two meet
// without threading a store reference through `makeAgentDeps`, and it degrades
// to a no-op in a readline session that never mounts a TUI.
//
// This module carries TWO channels, and they are separate on purpose.
//
//   1. RUN SIGNALS — start, spawned, event, warning, outcome, result. One
//      listener, fire-and-forget, and a throwing listener can never break the
//      run it is watching (a broken sidebar must not kill a paid vendor run).
//   2. THE SPAWN APPROVER — a REQUEST/RESPONSE channel, so it cannot use the
//      same one-way shape. It exists because `externalAgents.spawnDecision`
//      defaults to `"ask"` and `createRunExternal` fails closed when no approver
//      is wired: with nothing registered here, the shipped default denies every
//      model-initiated external spawn, so the feature cannot run at all without
//      the operator editing their config. The default answer stays a REFUSAL
//      WITH A NAMED REASON — a host that cannot ask must never self-approve
//      (package security-policy §6).
//
// No `@opentui/core` import, direct or indirect: this file is loaded by
// `commands/shell.ts` on the readline path too.

import type {
  ExternalRunAnnouncement,
  ExternalRunObserver,
  ExternalSpawnApproval,
  ExternalSpawnApprovalRequest,
} from "../harness/run-external-factory";
import type { ExternalChildOutcome } from "../harness/external/runtime";
import type { ExternalRunHandle } from "../harness/external/supervise";
import type { ExternalEvent } from "../harness/external/types";
import type { StructuredSubagentResult } from "../harness/tool/builtin/spawn-subagent-tool";

/**
 * One thing that happened to one external run.
 *
 * Every variant leads with the run id because two external children can be live
 * at once; a signal without one would append a second run's transcript to the
 * first run's record.
 */
export type ExternalRunSignal =
  /** Launch facts. May arrive more than once per run as facts are resolved. */
  | { readonly kind: "start"; readonly id: string; readonly run: ExternalRunAnnouncement }
  /** The live handle — the ONLY route to `kill()` and `writeStdin()` (§7.5, §7.6). */
  | { readonly kind: "spawned"; readonly id: string; readonly handle: ExternalRunHandle }
  | { readonly kind: "event"; readonly id: string; readonly event: ExternalEvent }
  | { readonly kind: "warning"; readonly id: string; readonly warning: string }
  | { readonly kind: "outcome"; readonly id: string; readonly outcome: ExternalChildOutcome }
  /** The final result, INCLUDING refusals that happened before any process existed. */
  | { readonly kind: "result"; readonly id: string; readonly result: StructuredSubagentResult };

let listener: ((signal: ExternalRunSignal) => void) | undefined;

/** Register (or clear) the mounted TUI's run-signal sink. */
export function setExternalRunListener(fn: ((signal: ExternalRunSignal) => void) | undefined): void {
  listener = fn;
}

/**
 * Deliver one signal. A safe no-op when no TUI is mounted, and a throwing
 * listener is swallowed: a broken sidebar must never abort a vendor run the
 * operator is paying for.
 */
export function emitExternalRun(signal: ExternalRunSignal): void {
  try {
    listener?.(signal);
  } catch {
    // never break the run being observed
  }
}

/**
 * The {@link ExternalRunObserver} to hand `createRunExternal`. Every callback
 * routes through {@link emitExternalRun}, so the factory needs no knowledge of
 * whether a TUI exists.
 */
export const externalRunBridgeObserver: ExternalRunObserver = {
  onStart: (run) => emitExternalRun({ kind: "start", id: run.runId, run }),
  onSpawned: (id, handle) => emitExternalRun({ kind: "spawned", id, handle }),
  onEvent: (id, event) => emitExternalRun({ kind: "event", id, event }),
  onWarning: (id, warning) => emitExternalRun({ kind: "warning", id, warning }),
  onOutcome: (id, outcome) => emitExternalRun({ kind: "outcome", id, outcome }),
  onResult: (id, result) => emitExternalRun({ kind: "result", id, result }),
};

// ---------------------------------------------------------------------------
// The spawn approver (R25, security-policy §6)
// ---------------------------------------------------------------------------

/** What a registered host answers a `spawnDecision: "ask"` question with. */
export type ExternalSpawnApprover = (
  request: ExternalSpawnApprovalRequest,
) => Promise<ExternalSpawnApproval>;

/**
 * The refusal returned when nothing is registered.
 *
 * Named, not a bare `false`. "Nobody could be asked" and "the operator said no"
 * are different facts and an operator who sees the second when the first
 * happened goes looking for a decision they never made.
 */
export const NO_EXTERNAL_APPROVER_REASON =
  "this keryx host has no way to ask: `externalAgents.spawnDecision` is \"ask\" and no interactive " +
  "approver is attached (a non-interactive or headless session cannot prompt). Start the spawn " +
  "yourself with `/delegate`, or set `externalAgents.spawnDecision` to \"allow\" to permit " +
  "unattended model-initiated spawns.";

let approver: ExternalSpawnApprover | undefined;

/** Register (or clear) the interactive approver. The TUI installs one when it mounts. */
export function setExternalSpawnApprover(fn: ExternalSpawnApprover | undefined): void {
  approver = fn;
}

/** Whether a host is currently able to ask. Exposed so a surface can say so honestly. */
export function hasExternalSpawnApprover(): boolean {
  return approver !== undefined;
}

/**
 * Ask the registered host. Never throws, and never self-approves.
 *
 * A missing host, or an approver that throws, both resolve to a NAMED refusal:
 * approval that cannot be obtained is approval that was not given
 * (security-policy §6). This is deliberately the only function
 * `createRunExternal`'s `approve` option is wired to, so there is exactly one
 * place where the fail-closed answer is decided.
 */
export async function approveExternalSpawn(
  request: ExternalSpawnApprovalRequest,
): Promise<ExternalSpawnApproval> {
  const host = approver;
  if (host === undefined) return { ok: false, reason: NO_EXTERNAL_APPROVER_REASON };
  try {
    return await host(request);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `the approval prompt failed (${message}); nothing was approved` };
  }
}
