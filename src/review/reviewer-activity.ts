// Project host events into a public session timeline. Tool arguments, outputs,
// prompts and private reasoning never enter a checkpoint or a Desktop response.
import type { DeskReviewerSession } from "./desk-run-types";
import { UsageRanges, usageCounts, validUsageCounts } from "./run-usage";

const maxActivity = 24;
export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9./_:-]{0,127}$/.test(value);
}
export function reviewerName(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value);
}
export function waveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A queue label and the recorded raw filename must agree before they identify a wave. */
export function assignedReviewerWave(reviewer: string, filename: string): number | undefined {
  if (!reviewerName(reviewer)) return;
  if (filename === `${reviewer}.txt`) return 1;
  const match = /^-w([1-9]\d*)\.txt$/.exec(filename.slice(reviewer.length));
  if (!filename.startsWith(reviewer) || !match) return;
  const wave = Number(match[1]);
  return waveNumber(wave) ? wave : undefined;
}

interface SessionRecord {
  session: DeskReviewerSession;
  requests: Map<string, number>;
  usage: UsageRanges;
}

/** Each shell event is observed once by the existing incremental tail. */
export class ReviewerActivityRecorder {
  private readonly records = new Map<string, SessionRecord>();

  observe(event: Record<string, unknown>): void {
    const id = event.sessionId;
    if (!identifier(id)) return;
    const record = this.records.get(id);
    if (event.type === "request_start" || event.type === "request_usage") {
      if (!record || event.participant !== "reviewer" || event.reviewer !== record.session.reviewer) return;
      if (identifier(event.provider)) record.session.provider = event.provider;
      if (identifier(event.model)) record.session.model = event.model;
      if (!identifier(event.requestId)) return;
      const prior = record.requests.get(event.requestId);
      if (event.type === "request_start" && prior !== undefined) return;
      const receipt = event.type === "request_usage" && validUsageCounts(event.usage) ? event.usage : undefined;
      if (event.type === "request_usage" && !receipt) return;
      const index = prior ?? record.requests.size;
      const counts = receipt ? usageCounts(receipt) : {};
      const partial = event.partial === true || counts.inputTokens === undefined || counts.outputTokens === undefined;
      record.requests.set(event.requestId, index);
      record.usage.set(index, { first: index, counts, partial });
      const total = record.usage.total!;
      if (receipt) record.session.usage = total.counts;
      if (total.partial) record.session.usagePartial = true;
      else delete record.session.usagePartial;
      return;
    }
    if (event.type !== "reviewer_activity" || !reviewerName(event.reviewer) || !waveNumber(event.wave)) return;
    if (typeof event.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at) || !Number.isFinite(Date.parse(event.at))) return;
    const session: DeskReviewerSession = record?.session ?? { id, reviewer: event.reviewer, wave: event.wave, state: "unknown" };
    if (session.reviewer !== event.reviewer || session.wave !== event.wave || session.finishedAt) return;
    let label: string;
    if (event.activity === "started" && !session.startedAt) {
      label = "Reviewer started";
      session.startedAt = event.at;
      session.state = "running";
    } else if ((event.activity === "tool_start" || event.activity === "tool_end") && reviewerName(event.tool)) {
      label = event.activity === "tool_start" ? `Started ${event.tool}` : `${event.tool} ${event.ok === false ? "failed" : "finished"}`;
    } else if (event.activity === "finished") {
      const outcome = event.outcome;
      if (outcome !== "completed" && outcome !== "partial" && outcome !== "failed" && outcome !== "cancelled") return;
      label = `Reviewer ${outcome}`;
      session.state = outcome;
      session.finishedAt = event.at;
    } else return;
    if (!record) this.records.set(id, { session, requests: new Map(), usage: new UsageRanges() });
    const activity = session.activity ??= [];
    activity.push({ at: event.at, label });
    if (activity.length > maxActivity) {
      activity.shift();
      session.truncated = true;
    }
  }

  sessions(): DeskReviewerSession[] {
    return Array.from(this.records.values(), ({ session }) => session);
  }
}
