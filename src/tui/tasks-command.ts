import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";

/** Session-local output uses an explicit cursor, never consuming the agent's reader. */
export async function runTasksCommand(args: string, registry: JobRegistry | undefined): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const usage = "Usage: /tasks [output <task_id> [cursor] | kill <task_id>]\n";
  if (registry === undefined) return "This session tracks no shell tasks.\n";
  if (parts.length === 0) {
    const tasks = registry.list();
    return tasks.length === 0 ? "No shell tasks.\n" : tasks.map((task) =>
      `${task.jobId} · ${task.status} · ${task.phase} · ${task.description ?? task.command}`,
    ).join("\n") + "\n";
  }
  const [action, id, rawCursor] = parts;
  if (id === undefined) return usage;
  if (action === "output" && parts.length <= 3) {
    if (rawCursor !== undefined && !/^\d+$/.test(rawCursor)) return usage;
    const cursor = Number(rawCursor ?? 0);
    if (!Number.isSafeInteger(cursor)) return usage;
    const result = registry.readOutputSince(id, cursor);
    if (!result.ok) return `${result.error}\n`;
    return `${id} · ${result.status} · next_cursor=${result.nextCursor}${result.missed > 0 ? ` · missed=${result.missed}` : ""}\n${result.output}\n`;
  }
  if (action === "kill" && parts.length === 2) {
    const result = await registry.kill(id, "operator");
    if (!result.ok) return `${result.error}\n`;
    return `${id} · ${registry.get(id)?.status ?? "unknown"}\n`;
  }
  return usage;
}
