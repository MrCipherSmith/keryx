import type { DeskQuestionReviewer } from "./desk-run-types";
import { desktopQuestionRun } from "./autonomous-answers";

/** An explicit null keeps the partial result. Undefined means the request was cancelled. */
export type AskReviewerContext = (question: string, reviewer: DeskQuestionReviewer, signal: AbortSignal) => Promise<string | null | undefined>;

/** Install a responder only for a manual Desktop run in its own private checkout. */
export function desktopReviewerQuestion(cwd: string, env: NodeJS.ProcessEnv = process.env): AskReviewerContext | undefined {
  const runId = desktopQuestionRun(cwd, env);
  if (!runId) return;
  return async (question, reviewer, signal) => {
    const { askDesktopOperator } = await import("./desk-questions");
    const answer = await askDesktopOperator(runId, { question, allowFreeform: true, options: [{
      id: "keep-partial", label: "Continue without this context", description: "Keep this assignment's partial result.",
    }] }, reviewer, signal);
    if (answer === "keep-partial") return null;
    return typeof answer === "object" && answer.kind === "own" ? answer.text : undefined;
  };
}
