import type { DeskRunKey, DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import { invoke } from "./backend";

export type ReviewRunAction =
  | { kind: "status"; id?: string }
  | { kind: "start"; baseSha: string; headSha: string }
  | { kind: "cancel"; id: string };

export async function reviewRun(cwd: string, key: DeskRunKey, action: ReviewRunAction): Promise<DeskRunSnapshot> {
  const result = await invoke<DeskRunSnapshot>("review_run", { cwd, target: key, action });
  if (result?.version !== 1 || !Array.isArray(result.runs)) {
    throw new Error("configuration: Check that your selected Keryx CLI supports Desktop review runs.");
  }
  return result;
}
