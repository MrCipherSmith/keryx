// review-jev-triage — flow 340's opt-in gate: `review.jev.triage` in
// `.metaproject/tasks.config.json`, the same shape and same fail-closed
// reading (absent/unparsable -> false, never throws, never defaults on) as
// `src/review/jev-contract-config.ts`'s `readJevContractEnabled` and every
// sibling `readJevXEnabled` reader of the same config block.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";

export async function readJevTriageEnabled(cwd: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const review = (parsed as Record<string, unknown>)["review"];
    if (typeof review !== "object" || review === null) return false;
    const jev = (review as Record<string, unknown>)["jev"];
    if (typeof jev !== "object" || jev === null) return false;
    return (jev as Record<string, unknown>)["triage"] === true;
  } catch {
    return false;
  }
}
