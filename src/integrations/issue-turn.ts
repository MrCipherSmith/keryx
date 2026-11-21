import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOwnerOnlyFileExclusive, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { ASK_USER_CANCEL, type AskUserAnswer, type AskUserRequest } from "../lib/ask-user-contract";
import { issueDigest } from "./issue-key";
import { privateJson, type BoundIssue } from "./issue-session";

interface Receipt { launchId: string; turnId: string; prompt: string; settled?: boolean }
export interface IssueQuestion { id: string; request: AskUserRequest; answer?: AskUserAnswer; awaitingDelivery?: true }

export function issuePreparationPrompt(bound: BoundIssue): string {
  if (bound.preparationPrompt) return bound.preparationPrompt;
  const { launch } = bound;
  if (!launch.flow) throw new Error("Bind a Flow before preparing it.");
  return [
    `Prepare existing Flow ${launch.flow.id} (${launch.flow.flowDir}) for ${launch.issue.url} in this session.`,
    "Use the project flow-orchestrator in prepare-only mode. Read the existing discussion, issue context, project instructions and skills.",
    `Use the verified source in context.md for every worker. For additional GitHub issue reads use keryx issues detail/comments with --login ${launch.viewer.login} and the confirmed issue ref. Never use ambient gh identity for this source.`,
    "Verify the source, collect relevant project context, write the concrete plan and verifiable acceptance criteria and register implementation tasks through the Flow CLI.",
    "Act as the coordinator. Consolidate reviewer questions, reuse earlier answers, and ask the operator in this session only if essential.",
    "Stop after preparing the package for operator inspection. Leave Freeze, Start, implementation and publication to the operator.",
  ].join("\n");
}

export function issueTurnReceipt(dir: string): Receipt | undefined {
  try {
    const receipt = privateJson<Receipt>(path.join(dir, "issue-preparation-turn.json"));
    if (receipt === undefined || receipt?.launchId && receipt.turnId && typeof receipt.prompt === "string") return receipt;
  } catch {
    // A torn exclusive write or inaccessible receipt leaves an unknown outcome.
  }
  return { launchId: "", turnId: "", prompt: "" };
}

/** Called by the receiver after taking the session lease. An ambiguous prior write is never retried. */
export function acceptIssueTurn(dir: string, bound: BoundIssue | undefined, launchId: string, prompt: string): boolean {
  if (!bound || !bound.launch.flow || bound.launch.launchId !== launchId || issuePreparationPrompt(bound) !== prompt)
    throw new Error("Issue preparation does not match this session and Flow. Refresh the issue.");
  const file = path.join(dir, "issue-preparation-turn.json");
  const receipt: Receipt = { launchId, turnId: randomUUID(), prompt };
  if (createOwnerOnlyFileExclusive(file, JSON.stringify(receipt))) return true;
  const already = issueTurnReceipt(dir);
  if (already?.launchId !== launchId || already.prompt !== prompt) throw new Error("launch_outcome_unknown: Inspect the existing turn in Sessions.");
  return false;
}

export function settleIssueTurn(dir: string): void {
  const receipt = issueTurnReceipt(dir);
  if (receipt?.launchId && !receipt.settled) writeOwnerOnlyFileAtomic(path.join(dir, "issue-preparation-turn.json"), JSON.stringify({ ...receipt, settled: true }));
}

function questionQueue(dir: string): IssueQuestion[] {
  const queue = privateJson<IssueQuestion[]>(path.join(dir, "issue-questions.json"));
  if (queue !== undefined) return queue;
  const legacy = privateJson<IssueQuestion>(path.join(dir, "issue-question.json"));
  return legacy ? [legacy] : [];
}

function saveQuestions(dir: string, questions: IssueQuestion[]): void {
  writeOwnerOnlyFileAtomic(path.join(dir, "issue-questions.json"), JSON.stringify(questions));
}

export function issueQuestion(dir: string): IssueQuestion | undefined {
  return questionQueue(dir).find(q => q.answer === undefined);
}

export function issueQuestionsToRestore(dir: string): IssueQuestion[] {
  return questionQueue(dir).filter(q => q.answer === undefined || q.awaitingDelivery);
}

export function finishIssueQuestionRecovery(dir: string, delivered: ReadonlySet<string>): void {
  saveQuestions(dir, questionQueue(dir).filter(q => !(q.awaitingDelivery && delivered.has(q.id))));
}

export function rememberIssueQuestion(dir: string, bound: BoundIssue, request: AskUserRequest): IssueQuestion {
  const id = issueDigest(JSON.stringify([bound.launch.launchId, bound.updatedAt, request.question.trim(), request.options, request.action,
    request.irreversible, request.untrustedContent, request.allowFreeform]));
  const queue = questionQueue(dir);
  const reusable = !request.irreversible && !request.untrustedContent;
  const old = queue.find(q => q.id === id);
  if (old && (old.answer === undefined || reusable)) return old;
  const remembered = reusable ? privateJson<{ answer: AskUserAnswer }>(path.join(dir, `issue-answer-${id}.json`)) : undefined;
  if (remembered) return { id, request, ...remembered };
  const question: IssueQuestion = { id, request };
  saveQuestions(dir, [...queue.filter(q => q.id !== id && (q.answer === undefined || q.awaitingDelivery)), question]);
  return question;
}

export function answerIssueQuestion(dir: string, question: IssueQuestion, answer: AskUserAnswer, awaitingDelivery = false): void {
  if (answer === ASK_USER_CANCEL) return;
  const queue = questionQueue(dir);
  const index = queue.findIndex(q => q.id === question.id);
  if (index === -1) return;
  if (!question.request.irreversible && !question.request.untrustedContent) {
    writeOwnerOnlyFileAtomic(path.join(dir, `issue-answer-${question.id}.json`), JSON.stringify({ answer }));
  }
  queue[index] = { id: question.id, request: question.request, answer, ...(awaitingDelivery ? { awaitingDelivery: true } : {}) };
  saveQuestions(dir, queue);
}
