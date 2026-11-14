import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FlowTask } from "../flow/service";

export type TaskDetails = { description: string | null; criteria: string | null; criteriaScope: "task" | "flow"; results: string | null };
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
/** Optional documents are not errors; unreadable/oversized documents remain observable. */
async function document(file: string, issues: string[]): Promise<string> {
  try {
    if ((await stat(file)).size > 128_000) throw new Error("document exceeds 128 KB state detail limit");
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") issues.push(`${file}: ${errorText(e)}`);
    return "";
  }
}
function taskSection(markdown: string, id: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, "").match(/^T\d+(?=\s|:|[.·—–-]|$)/)?.[0] === id);
  if (start < 0) return null;
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex((line, i) => i > start && (line.match(/^#+(?=\s)/)?.[0].length ?? Infinity) <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim() || null;
}
/** Shared summary budget bounds detail payloads independently of the consumer transport. */
export function detailBudget(bytes = 300_000): (value: string | null) => string | null {
  return value => {
    if (!value) return null;
    const limit = Math.min(2400, Math.floor(bytes / 4));
    if (limit <= 0) return "[Детали не включены: лимит снимка]";
    const text = value.length > limit ? `${value.slice(0, limit)}\n[Сокращено; полный текст в документах Flow]` : value;
    bytes -= Buffer.byteLength(text);
    return text;
  };
}
export async function flowTaskDetails(root: string, tasks: FlowTask[], issues: string[], bounded: ReturnType<typeof detailBudget>): Promise<TaskDetails[]> {
  const [markdown, ac] = await Promise.all([document(path.join(root, "tasks.md"), issues), document(path.join(root, "acceptance-criteria.md"), issues)]);
  const criteria = ac.match(/^\s*[-*]\s*AC\d+\s*:.*(?:\n[ \t]+[^\n]+)*/gmi) ?? [];
  return Promise.all(tasks.map(async task => {
    let result: Record<string, unknown> = {};
    if (/^T\d+$/.test(task.id)) {
      const file = path.join(root, "results", `${task.id}.json`);
      const raw = await document(file, issues);
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected result object");
          result = parsed as Record<string, unknown>;
        } catch (e) { issues.push(`${file}: ${errorText(e)}`); }
      }
    }
    const linked = task.acRefs?.length ? task.acRefs.map(id => criteria.find(text => text.match(/AC\d+/i)?.[0].toUpperCase() === id.toUpperCase())?.trim() ?? `${id}: текст критерия не найден`) : criteria.map(text => text.trim());
    const recorded = [task.dispositionReason, ...Object.entries(result).filter(([key, value]) => typeof value === "string" && ["status", "description", "test_result", "lint_result", "type_check_result", "acceptance_criteria_met", "notes"].includes(key)).map(([key, value]) => `${key}: ${value}`), ...(task.evidenceRefs ?? []).map(ref => `Источник: ${ref}`)].filter(Boolean).join("\n");
    return {
      description: bounded(taskSection(markdown, task.id) ?? (typeof result.description === "string" ? result.description : null)),
      criteria: bounded(linked?.join("\n") || null), criteriaScope: task.acRefs?.length ? "task" : "flow",
      results: bounded(recorded || null),
    };
  }));
}
