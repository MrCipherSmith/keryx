import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { publicReadFile, publicReviewText, publicReviewerOutput, reviewerContextRequest } from "../../../review/desk-public-text";
import { assignedReviewerWave } from "../../../review/reviewer-activity";
import { resolveActiveReview } from "../../../review/active-review";
import { isReviewerResult, parseReviewResult } from "../../../review/ledger";
import type { AskReviewerContext } from "../../../review/desk-reviewer-question";
import type { StructuredSubagentResult } from "./spawn-subagent-tool";

type Outcome = "completed" | "cancelled" | "failed" | "partial";
type Step =
  | { activity: "started" }
  | { activity: "message" | "answer"; text: string }
  | { activity: "tool_start"; tool: string; file?: string }
  | { activity: "tool_end"; tool: string; ok: boolean }
  | { activity: "finished"; outcome: Outcome; reason?: string; finalOutput?: string; needsContext?: true };

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

/** Resolve one host-prepared assignment without accepting overrides from the coordinator. */
export async function preparedDesktopReviewer(project: string, input: Record<string, unknown>) {
  const target = input.assignment;
  if (Object.keys(input).length !== 1 || typeof target !== "string" || target.length > 512 ||
      !/^\.metaproject\/reviews\/[\w.-]+\/raw\/[\w.-]+$/.test(target)) return;
  const file = path.resolve(project, target);
  const relativeDir = path.dirname(path.dirname(target));
  const dir = path.join(project, relativeDir);
  const canonicalProject = await realpath(project);
  if (await realpath(dir).catch(() => null) !== path.join(canonicalProject, relativeDir)) return;
  const plan = await activeReviewerPlan(project, file);
  const matches = plan?.calls.filter(call => call?.save_result_to === target);
  if (matches?.length !== 1) return;
  const call = matches[0] as Record<string, unknown>;
  if (call.mode !== "read_only" || typeof call.task !== "string" ||
      !Object.keys(call).every(key => ["label", "mode", "expected_model", "review_wave", "context_files", "save_result_to", "task"].includes(key))) return;
  return call;
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

/** A deadline counts execution time. Only an authenticated operator question can suspend it. */
export function reviewerDeadline(ms: number, activity?: ReviewerActivity) {
  let started = performance.now(), remaining = Math.min(ms, 2 ** 31 - 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire!: () => void;
  const expired = new Promise<"timeout">(resolve => { expire = () => resolve("timeout"); });
  const update = (waiting: boolean) => {
    if (timer !== undefined) {
      clearTimeout(timer);
      remaining -= performance.now() - started;
      timer = undefined;
    }
    if (!waiting) {
      started = performance.now();
      timer = setTimeout(expire, Math.max(0, remaining));
    }
  };
  const unsubscribe = activity?.onWait(update);
  update(false);
  return { expired, dispose() { unsubscribe?.(); clearTimeout(timer); } };
}

/** Per-invocation observer. Only the validated raw result path identifies a reviewer assignment. */
export class ReviewerActivity {
  private identity?: { sessionId: string; reviewer: string; wave: number };
  private closed = false;
  private readonly waits = new Set<(waiting: boolean) => void>();
  private readonly questions = new Set<string>();
  private incompleteResult = false;
  private result?: ReturnType<typeof publicReviewerOutput>;
  operatorWaitMs = 0;

  onWait(listener: (waiting: boolean) => void): () => void {
    this.waits.add(listener);
    return () => { this.waits.delete(listener); };
  }

  async requestContext(text: string, ask: AskReviewerContext, signal: AbortSignal): Promise<string | undefined> {
    if (!this.identity || this.closed || signal.aborted) return;
    const result = parseReviewResult(text);
    if (!isReviewerResult(result) || result.reviewer !== this.identity.reviewer || result.status !== "NEEDS_CONTEXT") return;
    const question = reviewerContextRequest(result);
    const key = question?.toLowerCase().replace(/\s+/g, " ").trim();
    if (!question || !key || this.questions.has(key)) return;
    this.questions.add(key);
    const { sessionId: reviewerSessionId, reviewer, wave } = this.identity;
    const started = performance.now();
    for (const listener of this.waits) listener(true);
    try {
      this.record({ activity: "message", text: question });
      const answer = await ask(question, { reviewerSessionId, reviewer, wave }, signal);
      if (signal.aborted || this.closed) return;
      if (answer === undefined) return;
      if (answer === null) {
        this.record({ activity: "answer", text: "Continue with the available evidence." });
        return;
      }
      this.record({ activity: "answer", text: publicReviewText(answer, 1200) });
      return "The operator supplied this context for the same review assignment. Recheck available evidence and return your updated REVIEW_RESULT.\n\n" + answer;
    } finally {
      this.operatorWaitMs += performance.now() - started;
      for (const listener of this.waits) listener(false);
    }
  }
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

  message(text: string): void {
    if (!this.identity || this.closed || !text.trim()) return;
    const report = parseReviewResult(text);
    // A structured final answer is published separately on this session's completion.
    if (!isReviewerResult(report)) this.record({ activity: "message", text: publicReviewText(text.trim(), 1200) });
  }

  toolStart(tool: string, input: string): void {
    if (!this.identity || this.closed) return;
    const file = tool === "read_file" ? publicReadFile(input) : undefined;
    this.record({ activity: "tool_start", tool, ...(file ? { file } : {}) });
  }

  submissionSummary(summary: string): void {
    if (this.identity && !this.closed && summary.trim()) this.result = { finalOutput: publicReviewText(summary.trim(), 4800) };
  }

  observeResult(text: string): void {
    if (!this.identity || this.closed) return;
    const report = parseReviewResult(text);
    if (!isReviewerResult(report) || report.reviewer !== this.identity.reviewer) return;
    this.incompleteResult = report.status === "BLOCKED" || report.status === "NEEDS_CONTEXT";
    this.result = publicReviewerOutput(report);
  }

  finish(result: StructuredSubagentResult | undefined, aborted: boolean): void {
    let outcome: Outcome = "failed";
    if (result?.status === "Completed") outcome = this.incompleteResult ? "partial" : "completed";
    else if (aborted || result?.status === "Interrupted") outcome = "cancelled";
    else if (result?.status === "NoProgress" || result?.status === "BudgetExhausted") outcome = "partial";
    const reason = this.result?.outcomeReason ?? (result?.status === "BudgetExhausted" ? "The reviewer reached its execution budget."
      : result?.status === "NoProgress" ? "The reviewer stopped after repeated tool calls without progress."
      : result?.status === "Timeout" ? "The reviewer reached its time limit."
      : result?.status === "Denied" ? "The reviewer was denied permission to run." : undefined);
    this.record({ activity: "finished", outcome, ...(this.result?.needsContext ? { needsContext: true } : {}), ...(reason ? { reason } : {}), ...(this.result?.finalOutput ? { finalOutput: this.result.finalOutput } : {}) });
    this.closed = true;
  }
}
