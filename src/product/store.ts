// The product index on disk. `.metaproject/data/product/` is disposable: it is
// written only by `product index`, read only by `product open` and the TUI, and
// deleting it then rebuilding gives an equivalent index.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { flowsDir, listFlowPackages } from "./corpus";
import type { IndexRead, IntentIndex, Staleness } from "./types";

const SOURCE_FILES = ["flow.json", "description.md", "acceptance-criteria.md", "journal.md"];

export function productDataRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "product");
}

export function indexPath(cwd: string): string {
  return path.join(productDataRoot(cwd), "index.json");
}

export function serializeIndex(index: IntentIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export async function writeIntentIndex(cwd: string, index: IntentIndex): Promise<string> {
  const file = indexPath(cwd);
  await writeFileAtomic(file, serializeIndex(index));
  return file;
}

function looksLikeIndex(value: unknown): value is IntentIndex {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IntentIndex>;
  return candidate.schemaVersion === 1 && Array.isArray(candidate.intents) && typeof candidate.counts === "object" && candidate.counts !== null;
}

export async function readIntentIndex(cwd: string): Promise<IndexRead> {
  const file = indexPath(cwd);
  let text: string;
  let mtimeMs: number;
  try {
    [text, mtimeMs] = await Promise.all([readFile(file, "utf8"), stat(file).then((info) => info.mtimeMs)]);
  } catch {
    return { state: "absent" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return looksLikeIndex(parsed)
      ? { state: "present", index: parsed, mtimeMs }
      : { state: "malformed", reason: "index.json is missing schemaVersion, intents or counts" };
  } catch (error) {
    return { state: "malformed", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function newestSourceMtime(cwd: string, packages: readonly string[]): Promise<number> {
  let newest = 0;
  for (const name of packages) {
    for (const file of SOURCE_FILES) {
      try {
        newest = Math.max(newest, (await stat(path.join(flowsDir(cwd), name, file))).mtimeMs);
      } catch {
        // an absent optional file has no mtime
      }
    }
  }
  return newest;
}

/**
 * Stale when the flows changed after the index was written: a flow file newer
 * than the index, a flow added or removed, or a different newest flow. This
 * only reports; it refuses nothing but `product open`'s own read.
 */
export async function checkStaleness(cwd: string, index: IntentIndex, indexMtimeMs: number): Promise<Staleness> {
  const packages = await listFlowPackages(cwd);
  if (packages.length !== index.counts.flows + index.failures.length) {
    return { stale: true, reason: `the index holds ${index.counts.flows + index.failures.length} flows, the tree ${packages.length}` };
  }
  if ((await newestSourceMtime(cwd, packages)) > indexMtimeMs) {
    return { stale: true, reason: "a flow changed after the index was written" };
  }
  return { stale: false };
}
