// Append-only decision log (W3 spec, "Cross-project evidence" + AC11):
// every human action that changes a record's status appends one line here,
// so `auditAcceptedRecords` can prove "no learned pattern reaches `accepted`
// without a recorded human accept action".
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../lib/fs";
import { decisionsLogPath, projectLockPath, userDecisionsLogPath, userLockPath } from "./paths";
import { listPatterns } from "./store";
import type { LearningScope } from "./types";

export type DecisionAction = "accept" | "reject" | "refresh" | "promote" | "graduate-apply";

export interface Decision {
  schemaVersion: 1;
  action: DecisionAction;
  id: string;
  scope: LearningScope;
  actor: string;
  /** Whether the action ran in an interactive terminal (accept/promote require it — see `paths.ts`/`store.ts` callers). */
  tty: boolean;
  at: string;
}

export interface AppendDecisionInput {
  action: DecisionAction;
  id: string;
  actor: string;
  tty: boolean;
  /** Defaults to `new Date().toISOString()`. */
  at?: string;
}

export interface DecisionLogOptions {
  scope: LearningScope;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function envOf(options: DecisionLogOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function logPathFor(root: string, options: DecisionLogOptions): string {
  return options.scope === "project" ? decisionsLogPath(root) : userDecisionsLogPath(envOf(options), options.homeDir);
}

function lockPathFor(root: string, options: DecisionLogOptions): string {
  return options.scope === "project" ? projectLockPath(root) : userLockPath(envOf(options), options.homeDir);
}

/** Appends one `{schemaVersion:1, action, id, scope, actor, tty, at}` line to the project or user decisions log, under that scope's lock. */
export async function appendDecision(root: string, decision: AppendDecisionInput, options: DecisionLogOptions): Promise<void> {
  const record: Decision = {
    schemaVersion: 1,
    action: decision.action,
    id: decision.id,
    scope: options.scope,
    actor: decision.actor,
    tty: decision.tty,
    at: decision.at ?? new Date().toISOString(),
  };
  const logPath = logPathFor(root, options);
  const lockPath = lockPathFor(root, options);
  await withFileLock(lockPath, async () => {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  });
}

async function readExistingLog(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

/** Reads every well-formed decision line for `scope` (a malformed line is skipped, not thrown). */
export async function readDecisions(
  root: string,
  scope: LearningScope,
  options: Omit<DecisionLogOptions, "scope"> = {},
): Promise<Decision[]> {
  const logPath = logPathFor(root, { ...options, scope });
  const raw = await readExistingLog(logPath);
  const decisions: Decision[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isDecision(parsed)) decisions.push(parsed);
    } catch {
      // Skip a malformed line rather than failing the whole read.
    }
  }
  return decisions;
}

const DECISION_ACTIONS: readonly DecisionAction[] = ["accept", "reject", "refresh", "promote", "graduate-apply"];

function isDecision(value: unknown): value is Decision {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.action === "string" &&
    DECISION_ACTIONS.includes(record.action as never) &&
    typeof record.id === "string" &&
    (record.scope === "project" || record.scope === "user") &&
    typeof record.actor === "string" &&
    typeof record.tty === "boolean" &&
    typeof record.at === "string"
  );
}

/** Accepted records (either scope) with no matching `action: "accept"` decision entry for that id+scope — the W3-AC11 exit guard. */
export async function auditAcceptedRecords(
  root: string,
  options: Omit<DecisionLogOptions, "scope"> = {},
): Promise<{ id: string; scope: LearningScope }[]> {
  const accepted = await listPatterns(root, { status: "accepted" }, options);
  const flagged: { id: string; scope: LearningScope }[] = [];
  for (const scope of ["project", "user"] as const) {
    const scopedAccepted = accepted.filter((record) => record.scope === scope);
    if (scopedAccepted.length === 0) continue;
    const decisions = await readDecisions(root, scope, options);
    const acceptedIds = new Set(decisions.filter((d) => d.action === "accept").map((d) => d.id));
    for (const record of scopedAccepted) {
      if (!acceptedIds.has(record.id)) flagged.push({ id: record.id, scope });
    }
  }
  return flagged;
}
