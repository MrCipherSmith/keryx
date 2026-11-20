import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
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

async function activeReviewerPlan(project: string, file: string | undefined) {
  if (!file || path.basename(path.dirname(file)) !== "raw") return;
  const active = await resolveActiveReview(project);
  if (!active || path.dirname(file) !== path.join(active.dir, "raw")) return;
  try {
    const queueFile = path.join(active.dir, "desktop-dispatch.json");
    const stat = await lstat(queueFile);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return;
    const queue = JSON.parse(await readFile(queueFile, "utf8")) as
      { calls?: Array<{ label?: unknown; save_result_to?: unknown } | null> } | null;
    if (!Array.isArray(queue?.calls)) return;
    return { dir: active.dir, calls: queue.calls };
  } catch { return; } // A missing or unreadable plan cannot identify a reviewer assignment.
}

/** Only an unchanged native read-only call from the active Desktop plan can request review routing. */
export async function matchesDesktopReviewerDispatch(
  project: string, file: string | undefined, input: Record<string, unknown>,
): Promise<boolean> {
  if (!file || input.mode !== "read_only" || input.runtime !== undefined ||
      typeof input.label !== "string" || assignedReviewerWave(input.label, path.basename(file)) === undefined) return false;
  const plan = await activeReviewerPlan(project, file);
  if (!plan || typeof input.save_result_to !== "string" || path.resolve(project, input.save_result_to) !== file) return false;
  const wave = input.review_wave;
  if (!wave || typeof wave !== "object") return false;
  const pkg = Reflect.get(wave, "package");
  return typeof pkg === "string" && path.resolve(project, pkg) === plan.dir &&
    plan.calls.some(call => isDeepStrictEqual(call, input));
}

/** Per-invocation observer. Only the validated raw result path identifies a reviewer assignment. */
export class ReviewerActivity {
  private identity?: { sessionId: string; reviewer: string; wave: number };
  private closed = false;
  private incompleteResult = false;

  constructor(private readonly emit: (event: ReviewerActivityEvent) => void, private readonly clock: () => string) {}

  async start(project: string, file: string | undefined): Promise<void> {
    if (this.closed || !file) return;
    const plan = await activeReviewerPlan(project, file);
    const call = plan?.calls.find(call =>
      typeof call?.save_result_to === "string" && path.resolve(project, call.save_result_to) === file);
    if (this.closed || typeof call?.label !== "string") return;
    const wave = assignedReviewerWave(call.label, path.basename(file));
    if (wave === undefined) return;
    this.identity = { sessionId: randomUUID(), reviewer: call.label, wave };
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
    if (result?.status === "Completed") outcome = this.incompleteResult ? "partial" : "completed";
    else if (aborted || result?.status === "Interrupted") outcome = "cancelled";
    else if (result?.status === "NoProgress" || result?.status === "BudgetExhausted") outcome = "partial";
    this.record({ activity: "finished", outcome });
    this.closed = true;
  }
}
