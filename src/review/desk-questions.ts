import path from "node:path";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ASK_USER_CANCEL, type AskUserAnswer, type AskUserRequest } from "../lib/ask-user-contract";
import type { DeskQuestionReviewer } from "./desk-run-types";
import { DeskRunStore } from "./desk-run-store";
import { publicReviewText } from "./desk-public-text";
import { identifier, reviewerName, waveNumber } from "./reviewer-activity";

export async function askDesktopOperator(
  runId: string, request: AskUserRequest, owner?: DeskQuestionReviewer | { reviewContext: true } | DeskRunStore, signal?: AbortSignal, injected?: DeskRunStore,
): Promise<AskUserAnswer> {
  const scope = owner && "reviewerSessionId" in owner ? owner : undefined;
  const reviewContext = !!owner && "reviewContext" in owner;
  const store = owner instanceof DeskRunStore ? owner : injected ?? new DeskRunStore();
  const id = randomUUID();
  try {
    if (signal?.aborted) return ASK_USER_CANCEL;
    if (scope && (!identifier(scope.reviewerSessionId) || (scope.reviewer !== undefined && !reviewerName(scope.reviewer)) ||
        (scope.wave !== undefined && !waveNumber(scope.wave)))) throw new Error("invalid: Unknown reviewer session.");
    const reviewer = scope ? {
      reviewerSessionId: scope.reviewerSessionId,
      ...(scope.reviewer && { reviewer: scope.reviewer }),
      ...(scope.wave !== undefined && { wave: scope.wave }),
    } : undefined;
    const publish = (type: "desktop_question" | "desktop_answer", text: string) => {
      try {
        appendFileSync(path.join(store.directory(runId), "run", "events.ndjson"), JSON.stringify({ type, questionId: id, ...reviewer, text: publicReviewText(text, 2000) }) + "\n");
      } catch { /* A lost transcript event must never drop the operator’s answer. */ }
    };
    if (request.options.length > 32) throw new Error("Offer fewer review choices.");
    const options = request.options.map(option => ({
      // The renderer only needs an opaque choice key. Original IDs can contain model-provided free text.
      id: randomUUID(), label: publicReviewText(option.label, 240), description: publicReviewText(option.description, 500),
      ...(option.recommended ? { recommended: true } : {}),
    }));
    store.openQuestion(runId, { id, ...reviewer, ...(reviewContext && { reviewContext: true }),
      question: publicReviewText(request.question, 2000), options, allowFreeform: request.allowFreeform === true });
    publish("desktop_question", request.question);
    for (;;) {
      const answer = store.questionAnswer(runId, id);
      if (answer === undefined) return ASK_USER_CANCEL;
      if (answer !== null) {
        const index = options.findIndex(option => option.id === answer);
        publish("desktop_answer", options[index]?.label ?? answer);
        const option = request.options[index];
        return option ? option.id : { kind: "own", text: answer };
      }
      try { await delay(400, undefined, { signal }); }
      catch (error) {
        if (signal?.aborted) return ASK_USER_CANCEL;
        throw error;
      }
    }
  } finally {
    try { store.clearQuestion(runId, id); } finally { store.close(); }
  }
}
