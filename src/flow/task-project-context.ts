// The project-context check `keryx flow task done` runs for an `implement` or
// `test` task: the worker's recorded result is compared with the resolver output
// it was dispatched with, by the same function `contracts validate --resolved`
// uses, so a miss reads the same in both places.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readProjectContextConfig } from "../gdskills/project-context-config";
import {
  checkResolvedContext,
  formatResolvedHeadline,
  formatResolvedReport,
  readResolvedFile,
} from "../gdskills/resolved-context-check";
import type { TaskDisposition, TaskKind } from "./types";

export type TaskProjectContextInput = {
  /** The task's own kind and the disposition it is being closed with. */
  taskId: string;
  kind: TaskKind;
  disposition: TaskDisposition;
  projectRoot: string;
  resultFile?: string | undefined;
  resolvedFile?: string | undefined;
};

export type TaskProjectContextOutcome = {
  /** One line for the flow journal; absent when there is nothing to record. */
  journal?: string;
};

const CHECKED_KINDS: readonly TaskKind[] = ["implement", "test"];

export async function checkTaskProjectContext(input: TaskProjectContextInput): Promise<TaskProjectContextOutcome> {
  const hasResult = input.resultFile !== undefined;
  const hasResolved = input.resolvedFile !== undefined;
  if (hasResult !== hasResolved) {
    throw new Error("flow task done: --result and --resolved go together (the worker's result and the resolve-context output it was given).");
  }
  if (!CHECKED_KINDS.includes(input.kind) || input.disposition !== "completed") return {};

  const config = await readProjectContextConfig(input.projectRoot);
  if (!hasResult || !hasResolved) {
    if (config.enforcement !== "block") return {};
    throw new Error(
      `flow task done ${input.taskId}: refused — gdskills.projectContext.enforcement is "block" and this ${input.kind} task records no ` +
        "result to check. Pass --result <result.json> --resolved <resolved.json>, or close it with --disposition skipped --reason \"<why>\".",
    );
  }

  const report = await checkResolvedContext({
    projectRoot: input.projectRoot,
    resolved: await readResolvedFile(path.resolve(input.projectRoot, input.resolvedFile as string)),
    result: await readResultFile(path.resolve(input.projectRoot, input.resultFile as string)),
  });
  const lines = formatResolvedReport(report);
  if (lines.length === 0) return {};
  if (report.blocking) {
    throw new Error([`flow task done ${input.taskId}: refused — ${formatResolvedHeadline(report)}`, ...lines].join("\n"));
  }
  return { journal: `${formatResolvedHeadline(report)}: ${lines.map((line) => line.replace(/^- project context /, "")).join("; ")}` };
}

async function readResultFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`--result ${file}: cannot read it as JSON (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  }
}
