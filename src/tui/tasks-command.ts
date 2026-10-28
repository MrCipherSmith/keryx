import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";

export const TASKS_USAGE = "Usage: /tasks [output <task_id> [cursor] | kill <task_id>]\n";
export type ParsedTasksCommand =
  | { kind: "list" }
  | { kind: "output"; taskId: string; cursor?: number }
  | { kind: "kill"; taskId: string }
  | { kind: "invalid"; usage: string };
/** The one `/tasks` grammar, shared by this command and the native terminal adapter. */
export function parseTasksArgs(args: string): ParsedTasksCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "list" };
  const [action, id, rawCursor] = parts;
  if (id === undefined) return { kind: "invalid", usage: TASKS_USAGE };
  if (action === "output" && parts.length <= 3) {
    if (rawCursor !== undefined && !/^\d+$/.test(rawCursor)) return { kind: "invalid", usage: TASKS_USAGE };
    if (rawCursor === undefined) return { kind: "output", taskId: id };
    const cursor = Number(rawCursor);
    return Number.isSafeInteger(cursor) ? { kind: "output", taskId: id, cursor } : { kind: "invalid", usage: TASKS_USAGE };
  }
  if (action === "kill" && parts.length === 2) return { kind: "kill", taskId: id };
  return { kind: "invalid", usage: TASKS_USAGE };
}

/** Session-local output uses an explicit cursor, never consuming the agent's reader. */
export async function runTasksCommand(args: string, registry: JobRegistry | undefined): Promise<string> {
  if (registry === undefined) return "This session tracks no shell tasks.\n";
  const parsed = parseTasksArgs(args);
  if (parsed.kind === "list") {
    const tasks = registry.list();
    return tasks.length === 0 ? "No shell tasks.\n" : tasks.map((task) =>
      `${task.jobId} · ${task.status} · ${task.phase} · ${task.description ?? task.command}`,
    ).join("\n") + "\n";
  }
  if (parsed.kind === "invalid") return parsed.usage;
  const id = parsed.taskId;
  if (parsed.kind === "output") {
    const result = registry.readOutputSince(id, parsed.cursor ?? 0);
    if (!result.ok) return `${result.error}\n`;
    return `${id} · ${result.status} · next_cursor=${result.nextCursor}${result.missed > 0 ? ` · missed=${result.missed}` : ""}\n${result.output}\n`;
  }
  const result = await registry.kill(id, "operator");
  if (!result.ok) return `${result.error}\n`;
  return `${id} · ${registry.get(id)?.status ?? "unknown"}\n`;
}
