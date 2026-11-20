import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { assignedReviewerWave } from "../../../review/reviewer-activity";
import { resolveActiveReview } from "../../../review/active-review";
import { isReviewerResult, parseReviewResult } from "../../../review/ledger";
import type { StructuredSubagentResult } from "./spawn-subagent-tool";

type Outcome = "completed" | "cancelled" | "failed" | "partial";
type Step =
  | { activity: "started" }
  | { activity: "tool_start"; tool: string }
  | { activity: "tool_end"; tool: string; ok: boolean }
  | { activity: "finished"; outcome: Outcome };

export type ReviewerActivityEvent = Step & {
  type: "reviewer_activity";
  sessionId: string;
  reviewer: string;
  wave: number;
  at: string;
};

/** Per-invocation observer. Only the validated raw result path identifies a reviewer assignment. */
export class ReviewerActivity {
  private identity?: { sessionId: string; reviewer: string; wave: number };
  private closed = false;
  private incompleteResult = false;

  constructor(private readonly emit: (event: ReviewerActivityEvent) => void, private readonly clock: () => string) {}

  async start(project: string, file: string | undefined): Promise<void> {
    if (this.closed || !file || path.basename(path.dirname(file)) !== "raw") return;
    const active = await resolveActiveReview(project);
    if (!active || path.dirname(file) !== path.join(active.dir, "raw")) return;
    try {
      const queue = JSON.parse(await readFile(path.join(active.dir, "desktop-dispatch.json"), "utf8")) as
        { calls?: Array<{ label?: unknown; save_result_to?: unknown } | null> } | null;
      if (!Array.isArray(queue?.calls)) return;
      const call = queue.calls.find(call =>
        typeof call?.save_result_to === "string" && path.resolve(project, call.save_result_to) === file);
      if (typeof call?.label !== "string") return;
      const wave = assignedReviewerWave(call.label, path.basename(file));
      if (wave === undefined) return;
      this.identity = { sessionId: randomUUID(), reviewer: call.label, wave };
    } catch { return; } // A missing or unreadable plan cannot identify a reviewer session.
    this.record({ activity: "started" });
  }

  get reviewer(): string | undefined { return this.identity?.reviewer; }
  get sessionId(): string | undefined { return this.identity?.sessionId; }

  record(step: Step): void {
    if (!this.closed && this.identity) this.emit({ type: "reviewer_activity", ...this.identity, at: this.clock(), ...step });
  }

  observeResult(text: string): void {
    if (!this.identity || this.closed) return;
    const report = parseReviewResult(text);
    this.incompleteResult = isReviewerResult(report) && report.reviewer === this.identity.reviewer &&
      (report.status === "BLOCKED" || report.status === "NEEDS_CONTEXT");
  }

  finish(result: StructuredSubagentResult | undefined, aborted: boolean): void {
    let outcome: Outcome = "failed";
    if (aborted || result?.status === "Interrupted") outcome = "cancelled";
    else if (result?.status === "Completed") outcome = this.incompleteResult ? "partial" : "completed";
    else if (result?.status === "NoProgress" || result?.status === "BudgetExhausted") outcome = "partial";
    this.record({ activity: "finished", outcome });
    this.closed = true;
  }
}
