import type { Control } from "../../remote-control/protocol";
import type { NativeCommandContribution } from "./handlers";
import type { SessionUserQuestionService } from "../user-questions";

const text = (maxLength: number): Extract<Control["ArgumentSchema"], { type: "string" }> => ({ type: "string", maxLength });
const closed = (properties: Record<string, Control["ArgumentSchema"]>, required = Object.keys(properties)): Control["ArgumentSchema"] => ({ type: "object", additionalProperties: false, properties, required });
export const questionAnswerSchema = closed({ questionId: text(200), runId: text(200), turnId: text(200), fingerprint: text(64),
  answers: closed({ kind: { ...text(16), enum: ["option", "own", "cancel"] }, choice: text(200), text: text(8000), reason: text(8000) }, ["kind"]) });
const questionSchema = closed({ questionId: text(200), sessionId: text(200), runId: text(200), turnId: text(200), fingerprint: text(64), policyDigest: text(64), expiresAt: text(64),
  question: text(8192), options: { type: "array", maxItems: 8, items: closed({ id: text(200), label: text(8192), description: text(8192), recommended: { type: "boolean" } }) },
  allowFreeform: { type: "boolean" }, action: text(8192), irreversible: { type: "boolean" } });
export interface SessionQuestionPort { pending: SessionUserQuestionService["pending"]; answer: SessionUserQuestionService["answer"] }
export function questionCommands(): NativeCommandContribution[] {
  return [
    { entry: { commandName: "questions.list", summary: "Read this session's pending human questions", handlerId: "native.questions.list", inputSchema: closed({}),
      resultSchema: { type: "array", maxItems: 32, items: questionSchema }, mutationClass: "read", states: ["idle", "busy", "paused"], busyPolicy: "read-only", confirmation: "none", availability: "available", reason: "session-scoped-question-service" },
    structuredResult: true, async execute(context) { return context.questions?.pending() ?? []; } },
    { entry: { commandName: "questions.answer", summary: "Answer one exact pending human question; grants no tool approval", handlerId: "native.questions.answer", inputSchema: questionAnswerSchema,
      resultSchema: closed({ status: { ...text(16), enum: ["applied", "rejected", "not-pending"] }, reason: text(200) }), mutationClass: "session", states: ["idle", "busy", "paused"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "exact-live-question-owned-control" },
    structuredResult: true, async execute(context, request) {
      if (context.questions === undefined || context.authorizeOwnedControl === undefined) throw new Error("question-authority-required");
      await context.authorizeOwnedControl("questions.answer", request.arguments as Record<string, Control["BoundedJson"]>);
      const args = request.arguments as unknown as Omit<Parameters<SessionUserQuestionService["answer"]>[0], "actorId">;
      const result = context.questions.answer({ ...args, actorId: context.actorId ?? "" });
      if (result.status !== "applied") throw new Error("question-answer-refused");
      return result;
    } },
  ];
}
