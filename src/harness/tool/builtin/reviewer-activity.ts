import { randomUUID } from "node:crypto";
import path from "node:path";
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

  constructor(private readonly emit: (event: ReviewerActivityEvent) => void, private readonly clock: () => string) {}

  start(file: string | undefined): void {
    if (this.closed || !file || path.basename(path.dirname(file)) !== "raw") return;
    const match = /^([a-z][a-z0-9-]{0,63}?)(?:-w([1-9]\d*))?\.txt$/.exec(path.basename(file));
    if (!match?.[1]) return;
    const wave = Number(match[2] ?? 1);
    if (!Number.isSafeInteger(wave)) return;
    this.identity = { sessionId: randomUUID(), reviewer: match[1], wave };
    this.record({ activity: "started" });
  }

  get sessionId(): string | undefined { return this.identity?.sessionId; }

  record(step: Step): void {
    if (!this.closed && this.identity) this.emit({ type: "reviewer_activity", ...this.identity, at: this.clock(), ...step });
  }

  finish(result: StructuredSubagentResult | undefined, aborted: boolean): void {
    let outcome: Outcome = "failed";
    if (aborted || result?.status === "Interrupted") outcome = "cancelled";
    else if (result?.status === "Completed") outcome = "completed";
    else if (result?.status === "NoProgress" || result?.status === "BudgetExhausted") outcome = "partial";
    this.record({ activity: "finished", outcome });
    this.closed = true;
  }
}
