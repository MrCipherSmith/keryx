import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionUserQuestions, type UserQuestionContext, type SessionUserQuestion } from "./user-questions";
import { ASK_USER_CANCEL, type AskUserRequest } from "../harness/tool/builtin/ask-user-tool";

const request: AskUserRequest = { question: "Choose a format", options: [{ id: "plain", label: "Plain", description: "Plain text", recommended: true }, { id: "rich", label: "Rich", description: "Rich text" }],
  allowFreeform: true, recommendationReason: "private-recommendation-reason-never-display" };
function context(id: string, signal: AbortSignal): UserQuestionContext { return { runId: `run-${id}`, turnId: `turn-${id}`, actorId: "human", policyDigest: "a".repeat(64),
  controllerLeaseId: `controller-${id}`, controllerVersion: 1, controllerExpiresAt: Date.now() + 60_000, signal }; }

test("session question service isolates real waiters and consumes a bounded literal answer exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-user-questions-")); const abort = new AbortController();
  let qa!: SessionUserQuestion; let qb!: SessionUserQuestion;
  const a = createSessionUserQuestions({ dir: join(dir, "a"), sessionId: "session-a", context: () => context("a", abort.signal), deliver: (value) => { qa = value; } });
  const b = createSessionUserQuestions({ dir: join(dir, "b"), sessionId: "session-b", context: () => context("b", abort.signal), deliver: (value) => { qb = value; } });
  try {
    const pa = a.ask(request); const pb = b.ask(request);
    expect(a.pending().map((value) => value.questionId)).toEqual([qa.questionId]); expect(qa.questionId).not.toBe(qb.questionId);
    expect(JSON.stringify(qa)).not.toContain("private-recommendation");
    const answer = { questionId: qa.questionId, runId: qa.runId, turnId: qa.turnId, fingerprint: qa.fingerprint, answers: { kind: "option" as const, choice: "rich", reason: "human reason" }, actorId: "human" };
    expect(a.answer({ ...answer, questionId: qb.questionId }).status).toBe("not-pending");
    expect(a.answer({ ...answer, fingerprint: "b".repeat(64) }).status).toBe("rejected");
    expect(a.answer(answer).status).toBe("applied"); expect(await pa).toEqual({ kind: "option", choice: "rich", reason: "human reason" });
    expect(a.answer(answer).status).toBe("not-pending"); expect(b.pending()).toHaveLength(1);
    b.denyAll("test-end"); expect(await pb).toBe(ASK_USER_CANCEL);
    const ledger = await readFile(join(dir, "a", "user-questions.jsonl"), "utf8");
    expect(ledger).not.toContain("private-recommendation"); expect(ledger).not.toContain("human reason"); expect(ledger).toContain('"actorId":"human"');
  } finally { a.denyAll("test-end"); b.denyAll("test-end"); await rm(dir, { recursive: true, force: true }); }
});

test("question answers fail closed on controller changes, expiry and parent cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-question-authority-")); let clock = Date.now(); const abort = new AbortController();
  let current = context("a", abort.signal); let question!: SessionUserQuestion;
  const service = createSessionUserQuestions({ dir, sessionId: "session-a", now: () => clock, expiryMs: 1000, context: () => current, deliver(value) { question = value; } });
  const answer = () => ({ questionId: question.questionId, runId: question.runId, turnId: question.turnId, fingerprint: question.fingerprint, answers: { kind: "own" as const, text: "literal text" }, actorId: "human" });
  try {
    const changed = service.ask(request); current = { ...current, controllerVersion: 2 };
    expect(service.answer(answer()).status).toBe("rejected"); expect(await changed).toBe(ASK_USER_CANCEL);
    const expired = service.ask(request); clock += 1001;
    expect(service.answer(answer()).status).toBe("rejected"); expect(await expired).toBe(ASK_USER_CANCEL);
    const cancelled = service.ask(request); abort.abort(); expect(await cancelled).toBe(ASK_USER_CANCEL); expect(service.pending()).toHaveLength(0);
  } finally { service.denyAll("test-end"); await rm(dir, { recursive: true, force: true }); }
});

test("secret-bearing and oversized questions visibly refuse instead of publishing an altered choice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-question-limits-")); const abort = new AbortController(); let delivered = 0;
  const service = createSessionUserQuestions({ dir, sessionId: "session-a", context: () => context("a", abort.signal), deliver() { delivered++; } });
  try {
    expect(await service.ask({ ...request, question: "Use OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz?" })).toBe("__no_host__");
    expect(await service.ask({ ...request, question: "x".repeat(8193) })).toBe("__no_host__");
    expect(service.pending()).toHaveLength(0); expect(delivered).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("regression-33:F-001: a question linking a known document host is shown unchanged; an unknown host carrying the same id still refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-question-doc-hosts-")); const abort = new AbortController(); const delivered: SessionUserQuestion[] = [];
  const service = createSessionUserQuestions({ dir, sessionId: "session-a", context: () => context("a", abort.signal), deliver(value) { delivered.push(value); } });
  const sheets = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0";
  const notion = "https://www.notion.so/Keryx-Roadmap-8f3e2a1b4c5d6e7f8a9b0c1d2e3f4a5b";
  try {
    const shown = service.ask({ ...request, question: `Use the plan in ${sheets} or ${notion}?`, options: [{ id: "sheet", label: "Sheet", description: sheets }, { id: "notion", label: "Notion", description: notion }] });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.question).toBe(`Use the plan in ${sheets} or ${notion}?`);
    expect(delivered[0]?.options.map((option) => option.description)).toEqual([sheets, notion]);
    service.denyAll("test-end"); expect(await shown).toBe(ASK_USER_CANCEL);
    expect(await service.ask({ ...request, question: "Use https://files.example.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?" })).toBe("__no_host__");
    expect(await service.ask({ ...request, question: `Use ${sheets.replace("#gid=0", "?access_token=K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI")}?` })).toBe("__no_host__");
    expect(delivered).toHaveLength(1);
  } finally { service.denyAll("test-end"); await rm(dir, { recursive: true, force: true }); }
});
