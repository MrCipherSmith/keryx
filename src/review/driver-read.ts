import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readSliceIds } from "./retry-plan";

/** Flow 458 AC12: reading a package's `drivers/*.json`, shared by `ledger build` and `review next` (a core module, so neither imports the command layer). */

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** `wave` and `model` are what `review slice --package` writes and the dispatcher completes: the model the reviewer runs on. */
export type DriverFile = { reviewer?: unknown; slices?: unknown; definition?: unknown; skill_path?: unknown; payload?: unknown; result?: unknown; toolLog?: unknown; wave?: unknown; model?: unknown };

/** Where a driver file names the reviewer's rule file: a top-level `definition` or `skill_path`, or the same keys inside the dispatch `payload`. */
export function definitionCandidates(driver: DriverFile): string[] {
  const payload = driver.payload !== null && typeof driver.payload === "object" ? (driver.payload as DriverFile) : {};
  return [driver.definition, driver.skill_path, payload.definition, payload.skill_path].filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

export async function jsonFiles(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).filter((n) => n.endsWith(".json")).sort().map((n) => path.join(dir, n)) : [];
}

export type ReplyNames = { files: ReadonlySet<string>; reviewers: readonly string[] };

export type DriverRecords = {
  payloadSlices: Record<string, string[]>;
  payloadDispatchCounts: Record<string, number>;
  ruleFiles: Record<string, string>;
  /** Reviewer → the tool-call log path its driver names. */
  toolLogs: Record<string, string>;
  /** Reviewer → the model its drivers record (the last one written wins). */
  models: Record<string, string>;
  assignments: Map<string, string[][]>;
  replies: ReplyNames;
  /** Drivers whose `slices` held an entry with no usable id: that dispatch's slices are not counted as handed out. */
  dropped: Array<{ file: string; reviewer: string; unusable: number }>;
};

/** Reads `<input-dir>/drivers/*.json`: what each dispatch handed a reviewer, the file its reply goes to, and the rule file it ran under. */
export async function readDrivers(inputDir: string, root: string): Promise<DriverRecords> {
  const payloadSlices: Record<string, string[]> = {};
  const payloadDispatchCounts: Record<string, number> = {};
  const ruleFiles: Record<string, string> = {};
  const toolLogs: Record<string, string> = {};
  const models: Record<string, string> = {};
  const assignments = new Map<string, string[][]>();
  const replyFiles = new Set<string>();
  const replyReviewers = new Set<string>();
  const dropped: DriverRecords["dropped"] = [];
  for (const file of await jsonFiles(path.join(inputDir, "drivers"))) {
    const driver = await readJson<DriverFile>(file);
    if (typeof driver?.reviewer !== "string") continue;
    payloadDispatchCounts[driver.reviewer] = (payloadDispatchCounts[driver.reviewer] ?? 0) + 1;
    replyReviewers.add(driver.reviewer);
    const slices = readSliceIds(driver.slices, "assigned");
    const complete = Array.isArray(driver.slices) && slices.unusable === 0;
    if (slices.unusable > 0) dropped.push({ file: path.basename(file), reviewer: driver.reviewer, unusable: slices.unusable });
    if (complete) (payloadSlices[driver.reviewer] ??= []).push(...slices.ids);
    if (typeof driver.result === "string") {
      replyFiles.add(path.basename(driver.result));
      if (complete) {
        const key = `${driver.reviewer}\0${driver.result}`;
        const matches = assignments.get(key) ?? [];
        matches.push(slices.ids);
        assignments.set(key, matches);
      }
    }
    if (typeof driver.toolLog === "string" && driver.toolLog.trim() !== "") toolLogs[driver.reviewer] = driver.toolLog;
    if (typeof driver.model === "string" && driver.model.trim() !== "") models[driver.reviewer] = driver.model.trim();
    for (const candidate of definitionCandidates(driver)) {
      const definition = path.resolve(root, candidate);
      if (existsSync(definition)) { ruleFiles[driver.reviewer] = path.relative(root, definition); break; }
    }
  }
  return { payloadSlices, payloadDispatchCounts, ruleFiles, toolLogs, models, assignments, replies: { files: replyFiles, reviewers: [...replyReviewers] }, dropped };
}

