// Flow 300 T5 (AC5): the one place a trigger entry, a ledger record and an
// open spend reservation become a sentence.
//
// These lived as private helpers of `src/commands/trigger.ts` (`keryx trigger
// status/list`). The TUI's Triggers section and modal print the same facts, so
// they were moved here — CORE zone, next to the data they describe — and both
// surfaces import them. A copy in the TUI would drift from the CLI the first
// time either wording changed; AC5's test pins that they print the same thing.

import type { TriggerAction, TriggerDispatch, TriggerEntry, TriggerFire } from "./config";
import { isTriggerHookInstalled } from "./hooks";
import type { OpenReservation, TriggerRunCost, TriggerRunRecord } from "./record";

/**
 * What `dispatch.network: true` actually grants (flow 290 T14). The sandbox
 * then shares the host's network namespace: nothing is filtered. Printed by
 * `keryx trigger list`/`status`, the TUI's trigger modal, and in every such
 * run's record. The MODEL call is made by the dispatcher itself, outside the
 * sandbox, so talking to the provider — a local Ollama included — never needs this.
 */
export const NETWORK_ON_WARNING =
  "the agent's shell commands get the host's FULL network: the internet, every service on the host's loopback " +
  "(e.g. a local model server or database), and the host's abstract unix sockets. The model call does not need this.";

/** The unattended tool roster a dispatched run gets (flow 290 AC5). */
export const UNATTENDED_ROSTER_DESCRIPTION =
  "get_cwd, list_dir, read_file, shell_exec, apply_patch — no web, no MCP, no subagents, no ask_user";

/** `event:post-merge` / `schedule:"0 2 * * *"`. */
export function describeFire(fire: TriggerFire): string {
  return fire.kind === "event" ? `event:${fire.event}` : `schedule:"${fire.cron}"`;
}

/** One-line action descriptor, NETWORK ON warning included when it applies. */
export function describeAction(action: TriggerAction): string {
  if (action.kind === "open-flow") return `open-flow(${action.template}${action.skipIfOpen ? ", skipIfOpen" : ""})`;
  if (action.kind === "flow-next") {
    if (action.dispatch === undefined) return `flow-next(${action.flow}, report-only)`;
    const d = action.dispatch;
    return (
      `flow-next(${action.flow}, dispatch: ${d.provider}/${d.model}, mode ${d.permissionMode}, ` +
      `ceiling $${d.ceilingUsd}, max ${d.maxSeconds}s, ${d.maxAttempts} attempts` +
      (d.network ? `, NETWORK ON — ${NETWORK_ON_WARNING}` : ", network off") +
      ")"
    );
  }
  return action.kind;
}

/** The dispatch block of an entry, when it has one (a dispatching `flow-next`). */
export function entryDispatch(entry: TriggerEntry): TriggerDispatch | undefined {
  return entry.action.kind === "flow-next" ? entry.action.dispatch : undefined;
}

/** True when this entry's unattended agent gets the host network — the posture the NET marker flags. */
export function entryHasNetwork(entry: TriggerEntry): boolean {
  return entryDispatch(entry)?.network === true;
}

/** `cost: $0.0120` or `cost: not recorded (<reason>)` — an unrecorded cost is never shown as $0. */
export function describeCost(cost: TriggerRunCost): string {
  return cost.recorded ? `cost: $${cost.usd.toFixed(4)}` : `cost: not recorded (${cost.reason})`;
}

/** `keryx trigger status`'s per-trigger line. */
export function describeRecord(record: TriggerRunRecord): string {
  return `last: ${record.at} — ${record.outcome} — ${record.detail} [${describeCost(record.cost)}]`;
}

/** The exact command that closes a reservation a killed run left open. */
export function resolveReservationCommand(runId: string): string {
  return `keryx trigger resolve ${runId} --spent <usd>`;
}

/** `keryx trigger status`'s `! open spend reservation …` line (without its indent). */
export function describeOpenReservation(reservation: OpenReservation): string {
  return (
    `! open spend reservation: run ${reservation.runId} (trigger ${reservation.trigger}) holds $${reservation.usd.toFixed(4)} ` +
    `since ${reservation.at} — if that run is no longer alive, close it with \`${resolveReservationCommand(reservation.runId)}\``
  );
}

/** `keryx trigger list`'s hook column. */
export async function describeHookInstalled(cwd: string, entry: TriggerEntry): Promise<string> {
  if (entry.fire.kind === "schedule") {
    return `n/a (schedule — see \`keryx trigger schedule ${entry.name}\`)`;
  }
  if (entry.fire.event === "ci") {
    return "n/a (ci — fired by a CI job's own `keryx trigger run` call)";
  }
  return (await isTriggerHookInstalled(cwd, entry)) ? `installed (${entry.fire.event})` : `NOT installed (${entry.fire.event})`;
}

/** `keryx trigger list`/`status`'s entry line (without its `  - ` bullet). */
export function describeEntry(entry: TriggerEntry): string {
  return `${entry.name}  [${entry.enabled ? "enabled" : "disabled"}]  ${describeFire(entry.fire)}  -> ${describeAction(entry.action)}`;
}
