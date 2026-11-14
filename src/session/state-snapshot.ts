import path from "node:path";
import { flowsRoot, listFlowDirs, readFlow, resolveFlowDir } from "../flow/store";
import { getExecutionPlan, type ExecutionPlan } from "./execution-plan";
import { readSlate } from "./slate";
import { isOperatorMessage } from "./compact";
import { detailBudget, flowTaskDetails, type TaskDetails } from "./state-task-details";
import type { NormalizedMessage } from "../harness/provider/types";

export type StateExportSession = { cwd: string; dir: string; sessionId: string; messages?: readonly NormalizedMessage[] };
type TaskSummary = { id: string; title: string; status: string } & TaskDetails;
export type StateSnapshot = {
  version: 1; projectPath: string; sessionId: string;
  updatedAt: string; sourcePath: string; scope: "session" | "project";
  flows: { id: string; title: string; status: string; tasks: TaskSummary[] }[];
  request: { initial: string; current: string } | null;
  plan: ExecutionPlan | null; issues: string[];
};
function operatorRequest(messages: readonly NormalizedMessage[] = []): StateSnapshot["request"] {
  const requests = messages.filter(isOperatorMessage).map(m => m.content.trim()).filter(Boolean);
  if (!requests.length) return null;
  const bounded = (text: string): string => text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
  return { initial: bounded(requests[0]!), current: bounded(requests[requests.length - 1]!) };
}
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** Only canonical read paths; no Flow, Slate or plan mutation, nor session discovery. */
export async function buildStateSnapshot(session: StateExportSession): Promise<StateSnapshot> {
  const s: StateSnapshot = {
    version: 1, projectPath: session.cwd, sessionId: session.sessionId,
    updatedAt: new Date().toISOString(), sourcePath: flowsRoot(session.cwd),
    scope: "project", flows: [], request: operatorRequest(session.messages), plan: null, issues: [],
  };
  try { s.plan = await getExecutionPlan(session.dir) ?? null; }
  catch (e) { s.issues.push(`Plan: ${message(e)}`); }
  try {
    const slate = await readSlate(session.dir);
    const ref = slate?.course?.flowRef;
    s.scope = ref ? "session" : "project";
    const dirs = ref ? [await resolveFlowDir(session.cwd, ref)] : await listFlowDirs(session.cwd);
    const bounded = detailBudget();
    for (const dir of dirs) {
      try {
        const f = await readFlow(session.cwd, dir);
        if (s.scope === "project" && f.status === "done") continue;
        const details = await flowTaskDetails(path.join(flowsRoot(session.cwd), dir), f.tasks, s.issues, bounded);
        s.flows.push({ id: f.id, title: f.title, status: f.status,
          tasks: f.tasks.map((t, i) => ({ id: t.id, title: t.title, status: t.status,
            ...(details[i] ?? { description: null, criteria: null, criteriaScope: "flow" as const, results: null }) })) });
      } catch (e) { s.issues.push(`Flow ${dir}: ${message(e)}`); }
    }
  } catch (e) { s.issues.push(`Flow source: ${message(e)}`); }
  return s;
}

