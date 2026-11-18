// `_keryx/tasks/*` (Keryx Desktop Client M2a, specification §3.9.5): the Tasks tab of the
// activity panel — a session's background shell tasks as requests and one notification.
//
// The session's job registry is the same one `shell_exec` supervises; nothing here is a second
// supervisor. `taskEventSink` is its `onEvent`, narrowed to what a panel needs: a task starting,
// reaching the background phase and exiting, as `_keryx/tasks/event { sessionId, event }`. Output
// chunks are never pushed — the panel polls `_keryx/tasks/output` with its own cursor, and the
// registry's `readOutputSince` keeps no shared one. Private tasks (trusted local infrastructure,
// `visibility: "private"`) are never sent, listed, read or killed: for these requests an id that
// names one answers exactly as an unknown id does.

import type { BackgroundJobEvent, BackgroundJobInfo, JobRegistry } from "../harness/tool/builtin/background-job-registry";
import { AcpError, invalidParams, JSON_RPC_ERROR_CODES } from "./jsonrpc";
import { KERYX_ACP_EXTENSION_METHODS } from "./profile";
import { requireObjectParams, requireStringField } from "./protocol";

export interface AcpTasksHost {
  readonly requireInitialized: (method: string) => void;
  /** The session's job registry, or `undefined` for a session this connection does not hold. */
  readonly jobsOf: (sessionId: string) => JobRegistry | undefined;
}

export type AcpTaskHandler = (params: unknown) => Promise<unknown>;

/**
 * The `onEvent` of one session's job registry: forwards `start`, `phase` and `exit` of visible
 * tasks. `registry` is read at event time (it does not exist yet when the sink is built).
 */
export function taskEventSink(
  sessionId: string,
  registry: () => JobRegistry | undefined,
  notify: (method: string, params: unknown) => void,
): (event: BackgroundJobEvent) => void {
  return (event) => {
    if (event.type === "output") return;
    // `get` without the private opt-in is the one definition of "visible".
    if (registry()?.get(event.jobId) === undefined) return;
    notify(KERYX_ACP_EXTENSION_METHODS.tasksEvent, { sessionId, event });
  };
}

function unknownSession(method: string, sessionId: string): never {
  throw new AcpError(JSON_RPC_ERROR_CODES.resourceNotFound, `Unknown ACP session: ${sessionId}`, { sessionId, method });
}

function unknownTask(method: string, taskId: string): never {
  const error = invalidParams(`${method}: unknown task ${taskId}`, { taskId });
  throw new AcpError(error.code, error.message, error.data);
}

export function createTasksHandlers(host: AcpTasksHost): { readonly requests: Readonly<Record<string, AcpTaskHandler>> } {
  /** The session's registry and the visible task `taskId` names, or the refusal. */
  function resolve(method: string, params: unknown, withTask: true): { jobs: JobRegistry; taskId: string; obj: Record<string, unknown> };
  function resolve(method: string, params: unknown, withTask: false): { jobs: JobRegistry; obj: Record<string, unknown> };
  function resolve(method: string, params: unknown, withTask: boolean): { jobs: JobRegistry; taskId?: string; obj: Record<string, unknown> } {
    host.requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const sessionId = requireStringField(obj, "sessionId", method);
    const jobs = host.jobsOf(sessionId);
    if (jobs === undefined) unknownSession(method, sessionId);
    if (!withTask) return { jobs, obj };
    const taskId = requireStringField(obj, "taskId", method);
    if (jobs.get(taskId) === undefined) unknownTask(method, taskId);
    return { jobs, taskId, obj };
  }

  async function handleList(params: unknown): Promise<{ tasks: BackgroundJobInfo[] }> {
    const { jobs } = resolve(KERYX_ACP_EXTENSION_METHODS.tasksList, params, false);
    return { tasks: jobs.list() };
  }

  async function handleOutput(params: unknown): Promise<{ output: string; nextCursor: number; missed: number; status: BackgroundJobInfo["status"] }> {
    const method = KERYX_ACP_EXTENSION_METHODS.tasksOutput;
    const { jobs, taskId, obj } = resolve(method, params, true);
    const since = obj["since"];
    if (since !== undefined && (typeof since !== "number" || !Number.isInteger(since) || since < 0)) {
      const error = invalidParams(`${method}: since must be a non-negative integer`, { since });
      throw new AcpError(error.code, error.message, error.data);
    }
    const read = jobs.readOutputSince(taskId, since ?? 0);
    if (!read.ok) unknownTask(method, taskId);
    return { output: read.output, nextCursor: read.nextCursor, missed: read.missed, status: read.status };
  }

  async function handleKill(params: unknown): Promise<{ status: BackgroundJobInfo["status"] }> {
    const { jobs, taskId } = resolve(KERYX_ACP_EXTENSION_METHODS.tasksKill, params, true);
    // A task that already ended is not an error: the panel asked for it to be stopped, and it is.
    await jobs.kill(taskId, "operator");
    return { status: jobs.get(taskId)?.status ?? "killed" };
  }

  return {
    requests: {
      [KERYX_ACP_EXTENSION_METHODS.tasksList]: handleList,
      [KERYX_ACP_EXTENSION_METHODS.tasksOutput]: handleOutput,
      [KERYX_ACP_EXTENSION_METHODS.tasksKill]: handleKill,
    },
  };
}
