import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendOwnerOnlyLine } from "../lib/config-dir";
import { canonicalDigest } from "../remote-control/protocol";
import { redactSensitiveText } from "../security/service";
import { ASK_USER_CANCEL, ASK_USER_NO_HOST, type AskUserAnswer, type AskUserFn, type AskUserRequest } from "../harness/tool/builtin/ask-user-tool";

export interface UserQuestionContext {
  runId: string; turnId: string; actorId: string; policyDigest: string;
  controllerLeaseId: string; controllerVersion: number; controllerExpiresAt: number; signal: AbortSignal;
}
export interface SessionUserQuestion {
  questionId: string; sessionId: string; runId: string; turnId: string; fingerprint: string; policyDigest: string; expiresAt: string;
  question: string; options: { id: string; label: string; description: string; recommended: boolean }[];
  allowFreeform: boolean; action: string; irreversible: boolean;
}
export type UserQuestionAnswers = { kind: "option"; choice: string; reason?: string } | { kind: "own"; text: string } | { kind: "cancel" };
export interface SessionUserAnswer { questionId: string; runId: string; turnId: string; fingerprint: string; answers: UserQuestionAnswers; actorId: string }
export interface UserQuestionOutcome { status: "applied" | "rejected" | "not-pending"; reason: string }
interface Waiter { view: SessionUserQuestion; context: UserQuestionContext; finish(answer: AskUserAnswer, reason: string, actorId?: string): void }

function publicRequest(request: AskUserRequest): Pick<SessionUserQuestion, "question" | "options" | "allowFreeform" | "action" | "irreversible"> | undefined {
  if (typeof request.question !== "string" || request.question.length === 0 || Buffer.byteLength(request.question) > 8192 || !Array.isArray(request.options) || request.options.length < 2 || request.options.length > 8) return undefined;
  const ids = new Set<string>();
  for (const option of request.options) {
    if (typeof option.id !== "string" || option.id.length === 0 || option.id.length > 200 || ids.has(option.id) || redactSensitiveText(option.id) !== option.id
      || typeof option.label !== "string" || typeof option.description !== "string") return undefined;
    ids.add(option.id);
  }
  const result = { question: redactSensitiveText(request.question), options: request.options.map((option) => ({ id: option.id, label: redactSensitiveText(option.label),
    description: redactSensitiveText(option.description), recommended: option.recommended === true })), allowFreeform: request.allowFreeform === true,
  action: redactSensitiveText(request.action ?? ""), irreversible: request.irreversible === true };
  const visible = [request.question, request.action ?? "", ...request.options.flatMap((option) => [option.label, option.description])];
  if (visible.some((value) => redactSensitiveText(value) !== value)) return undefined;
  return Buffer.byteLength(JSON.stringify(result)) <= 24_000 ? result : undefined;
}

/** Arbitrary human questions are independent of tool approvals. Answering one grants no tool, trust or policy capability. */
export function createSessionUserQuestions(options: { dir: string; sessionId: string; context(): UserQuestionContext | undefined; deliver(question: SessionUserQuestion): void; now?: () => number; expiryMs?: number }) {
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const now = options.now ?? Date.now; const expiryMs = Math.max(1, Math.min(120_000, options.expiryMs ?? 120_000));
  const pending = new Map<string, Waiter>(); const ledger = join(options.dir, "user-questions.jsonl");
  const evidence = (value: object) => appendOwnerOnlyLine(ledger, JSON.stringify({ at: new Date(now()).toISOString(), ...value }));
  const live = (entry: Waiter, actorId: string) => {
    const current = options.context();
    return current !== undefined && !current.signal.aborted && current.actorId === actorId && current.actorId === entry.context.actorId
      && current.runId === entry.view.runId && current.turnId === entry.view.turnId && current.policyDigest === entry.view.policyDigest
      && current.controllerLeaseId === entry.context.controllerLeaseId && current.controllerVersion === entry.context.controllerVersion && current.controllerExpiresAt > now();
  };
  const ask: AskUserFn = async (request) => {
    const context = options.context(); const safe = publicRequest(request);
    if (context === undefined || safe === undefined || pending.size >= 32 || context.signal.aborted || context.controllerExpiresAt <= now()) return ASK_USER_NO_HOST;
    if ([...pending.values()].reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry.view)), Buffer.byteLength(JSON.stringify(safe))) > 32000) return ASK_USER_NO_HOST;
    const view: SessionUserQuestion = { questionId: randomUUID(), sessionId: options.sessionId, runId: context.runId, turnId: context.turnId, policyDigest: context.policyDigest,
      fingerprint: canonicalDigest({ kind: "ask_user", request, runId: context.runId, turnId: context.turnId, policyDigest: context.policyDigest,
        controllerLeaseId: context.controllerLeaseId, controllerVersion: context.controllerVersion }), expiresAt: new Date(now() + expiryMs).toISOString(), ...safe };
    return new Promise<AskUserAnswer>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => finish(ASK_USER_CANCEL, "turn-cancelled");
      const finish = (answer: AskUserAnswer, reason: string, actorId?: string) => {
        if (!pending.has(view.questionId)) return;
        let recorded = true;
        try { evidence({ kind: "resolved", questionId: view.questionId, reason, ...(actorId === undefined ? {} : { actorId, answerDigest: canonicalDigest(answer) }) }); }
        catch { recorded = false; }
        pending.delete(view.questionId); if (timer !== undefined) clearTimeout(timer); context.signal.removeEventListener("abort", abort); resolve(recorded ? answer : ASK_USER_CANCEL);
        if (!recorded && actorId !== undefined) throw new Error("question-answer-evidence-failed");
      };
      try {
        evidence({ kind: "created", question: view }); pending.set(view.questionId, { view, context, finish });
        context.signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(() => finish(ASK_USER_CANCEL, "expired"), expiryMs); timer.unref();
        options.deliver(structuredClone(view)); if (context.signal.aborted) abort();
      } catch { pending.delete(view.questionId); if (timer !== undefined) clearTimeout(timer); context.signal.removeEventListener("abort", abort); resolve(ASK_USER_NO_HOST); }
    });
  };
  return { ask,
    pending: () => [...pending.values()].map((entry) => structuredClone(entry.view)),
    answer(input: SessionUserAnswer): UserQuestionOutcome {
      const entry = pending.get(input.questionId); if (entry === undefined) return { status: "not-pending", reason: "no-live-question" };
      if (input.runId !== entry.view.runId || input.turnId !== entry.view.turnId || input.fingerprint !== entry.view.fingerprint) return { status: "rejected", reason: "question-mismatch" };
      if (Date.parse(entry.view.expiresAt) <= now() || !live(entry, input.actorId)) { entry.finish(ASK_USER_CANCEL, "question-authority-expired"); return { status: "rejected", reason: "question-authority-expired" }; }
      const answer = input.answers;
      if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return { status: "rejected", reason: "invalid-answer" };
      let actual: AskUserAnswer;
      if (answer.kind === "option") {
        if (Object.keys(answer).some((key) => !["kind", "choice", "reason"].includes(key)) || !entry.view.options.some((option) => option.id === answer.choice)
          || (answer.reason !== undefined && (typeof answer.reason !== "string" || Buffer.byteLength(answer.reason) > 8000))) return { status: "rejected", reason: "invalid-answer" };
        actual = { kind: "option", choice: answer.choice, ...(answer.reason === undefined ? {} : { reason: answer.reason }) };
      } else if (answer.kind === "own") {
        if (!entry.view.allowFreeform || Object.keys(answer).some((key) => !["kind", "text"].includes(key)) || typeof answer.text !== "string" || answer.text.length === 0 || Buffer.byteLength(answer.text) > 8000) return { status: "rejected", reason: "invalid-answer" };
        actual = { kind: "own", text: answer.text };
      } else if (answer.kind === "cancel" && Object.keys(answer).length === 1) actual = ASK_USER_CANCEL;
      else return { status: "rejected", reason: "invalid-answer" };
      try { entry.finish(actual, "human-answered", input.actorId); } catch { return { status: "rejected", reason: "question-answer-evidence-failed" }; } return { status: "applied", reason: "live-question-consumed" };
    },
    denyAll(reason: string) { for (const entry of [...pending.values()]) entry.finish(ASK_USER_CANCEL, reason); },
  };
}
export type SessionUserQuestionService = ReturnType<typeof createSessionUserQuestions>;
