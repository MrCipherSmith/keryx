// review-jev-comments — flow 333, AC5's opt-in gate: `review.jev.comments` in
// `.metaproject/tasks.config.json`, same shape and same fail-closed reading
// (absent/unparsable -> false, never throws, never defaults on) as
// `src/review/conform-report.ts`'s `readConformEnabled` and
// `src/review/jev-rules-config.ts`'s `readJevRulesEnabled` read their own
// sibling keys of the same config block.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";

export async function readJevCommentsEnabled(cwd: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const review = (parsed as Record<string, unknown>)["review"];
    if (typeof review !== "object" || review === null) return false;
    const jev = (review as Record<string, unknown>)["jev"];
    if (typeof jev !== "object" || jev === null) return false;
    return (jev as Record<string, unknown>)["comments"] === true;
  } catch {
    return false;
  }
}
