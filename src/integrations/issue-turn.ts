import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOwnerOnlyFileExclusive, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { ASK_USER_CANCEL, type AskUserAnswer, type AskUserRequest } from "../lib/ask-user-contract";
import { issueDigest } from "./issue-checkouts";
import { privateJson, type BoundIssue } from "./issue-session";
import type { IssueLaunch } from "./issues-contract";

interface Receipt { launchId: string; turnId: string; prompt: string; settled?: boolean }
interface Question { id: string; request: AskUserRequest; answer?: AskUserAnswer }

export function issuePreparationPrompt(launch: IssueLaunch): string {
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
  try { return privateJson<Receipt>(path.join(dir, "issue-preparation-turn.json")); }
  catch { return { launchId: "", turnId: "", prompt: "" }; } // A torn exclusive write leaves an unknown outcome.
}

/** Called by the receiver after taking the session lease. An ambiguous prior write is never retried. */
export function acceptIssueTurn(dir: string, bound: BoundIssue | undefined, launchId: string, prompt: string): boolean {
  if (!bound || !bound.launch.flow || bound.launch.launchId !== launchId || issuePreparationPrompt(bound.launch) !== prompt)
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

export function issueQuestion(dir: string): Question | undefined {
  return privateJson<Question>(path.join(dir, "issue-question.json"));
}

export function rememberIssueQuestion(dir: string, bound: BoundIssue, request: AskUserRequest): Question {
  const id = issueDigest(JSON.stringify([bound.launch.launchId, bound.updatedAt, request.question.trim(), request.options, request.irreversible]));
  const old = issueQuestion(dir);
  if (old?.id === id) return old;
  const question = { id, request };
  writeOwnerOnlyFileAtomic(path.join(dir, "issue-question.json"), JSON.stringify(question));
  return question;
}

export function answerIssueQuestion(dir: string, question: Question, answer: AskUserAnswer): void {
  if (answer === ASK_USER_CANCEL || issueQuestion(dir)?.id !== question.id) return;
  writeOwnerOnlyFileAtomic(path.join(dir, "issue-question.json"), JSON.stringify({ ...question, answer }));
}
