// Flow 389 (AC8): what the operator sees of a digest, on every surface.
//
// `keryx schedule list|show` and the `/schedule` modal both ask for the same four facts,
// so they are computed once, here, from the schedule summary (flow 295) and the digest's own
// delivery file: the digest itself, its next run, the last run's status and the last delivery.
// Pause and resume are not here; both surfaces call `pauseStoredSchedule` and
// `resumeStoredSchedule` from `../trigger/schedules`, which know a digest has no OS timer.

import type { AgentTaskAction } from "../trigger/config";
import type { ScheduleSummary } from "../trigger/schedules";
import { readDeliveryState, type DeliveryState, type LastDelivery } from "./digest-delivery";

export interface DigestStatus {
  readonly name: string;
  readonly repos: readonly string[];
  readonly topic: string;
  readonly memoryLimitMb: number;
  readonly ceilingUsd: number;
  readonly maxSeconds: number;
  readonly enabled: boolean;
  readonly nextRun: Date | undefined;
  readonly lastRun: { readonly at: string; readonly outcome: string; readonly detail: string } | undefined;
  readonly lastDelivery: LastDelivery | undefined;
  readonly pending: number;
}

/** True for a schedule that is a digest. */
export function isDigestSummary(summary: ScheduleSummary): boolean {
  return summary.entry.action.digest !== undefined;
}

/** What the status needs of one stored schedule; the CLI and the TUI both build this from what they already loaded. */
export interface DigestStatusInput {
  readonly name: string;
  readonly action: AgentTaskAction;
  readonly enabled: boolean;
  readonly nextRun: Date | undefined;
  readonly last: { readonly at: string; readonly outcome: string; readonly detail: string } | undefined;
}

/** The digest facts of one schedule, or undefined when it is not a digest. */
export async function digestStatusOf(projectRoot: string, input: DigestStatusInput): Promise<DigestStatus | undefined> {
  const digest = input.action.digest;
  if (digest === undefined) return undefined;
  const delivery: DeliveryState = await readDeliveryState(projectRoot, input.name);
  return {
    name: input.name,
    repos: input.action.grants.repos,
    topic: digest.topic,
    memoryLimitMb: digest.memoryLimitMb,
    ceilingUsd: input.action.dispatch.ceilingUsd,
    maxSeconds: input.action.dispatch.maxSeconds,
    enabled: input.enabled,
    nextRun: input.nextRun,
    lastRun: input.last === undefined ? undefined : { at: input.last.at, outcome: input.last.outcome, detail: input.last.detail },
    lastDelivery: delivery.last,
    pending: delivery.pending.length,
  };
}

/** The same, from a `listSchedules` row. */
export function digestStatus(projectRoot: string, summary: ScheduleSummary): Promise<DigestStatus | undefined> {
  return digestStatusOf(projectRoot, {
    name: summary.name,
    action: summary.entry.action,
    enabled: summary.enabled,
    nextRun: summary.nextRun,
    last: summary.last === undefined ? undefined : { at: summary.last.at, outcome: summary.last.outcome, detail: summary.last.detail },
  });
}

function describeDelivery(last: LastDelivery | undefined, pending: number): string {
  const queued = pending > 0 ? ` (${pending} waiting to be sent)` : "";
  if (last === undefined) return `none yet${queued}`;
  const where = last.target === "session" ? "the project's remote session topic" : `the "${last.topic ?? "Digest"}" topic`;
  return `${last.status} at ${last.at} — ${last.detail} [${where}]${queued}`;
}

/** The lines shown under a digest in `keryx schedule list|show` and in the `/schedule` modal. */
export function digestStatusLines(status: DigestStatus): string[] {
  return [
    `digest: GitHub (read-only) and the product board for ${status.repos.join(", ") || "no repository"}; topic "${status.topic}"; ` +
      `limits $${status.ceilingUsd}, ${status.maxSeconds}s, ${status.memoryLimitMb} MiB`,
    `next run: ${status.enabled ? (status.nextRun?.toISOString() ?? "—") : "paused"}`,
    `last run: ${status.lastRun === undefined ? "never ran" : `${status.lastRun.outcome} at ${status.lastRun.at} — ${status.lastRun.detail}`}`,
    `last delivery: ${describeDelivery(status.lastDelivery, status.pending)}`,
  ];
}
