// The product index on disk. `.metaproject/data/product/` is disposable: it is
// written only by `product index`, read only by `product open` and the TUI, and
// deleting it then rebuilding gives an equivalent index.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { corpusFingerprint, listFlowPackages } from "./corpus";
import { OUTCOME_VERDICTS } from "./types";
import type { IndexRead, IntentIndex, Staleness } from "./types";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COUNT_KEYS = ["intents", "flows", "docpacks", "closed", "noCriterion", "notObserved", "observed", "helped", "noEffect", "harmed", "inconclusive"] as const;

/** Why a parsed value is not an index the readers can use, or `null` when it is one. Checks every field they touch. */
function indexProblem(value: unknown): string | null {
  if (!isRecord(value)) return "index.json is not an object";
  if (value.schemaVersion !== 1) return "index.json has no schemaVersion 1";
  if (typeof value.fingerprint !== "string") return "index.json has no fingerprint";
  if (!Array.isArray(value.failures) || !value.failures.every((failure) => typeof failure === "string")) return "index.json has no failures list";
  if (typeof value.unusable !== "number") return "index.json has no unusable count";
  if (!isRecord(value.counts) || !COUNT_KEYS.every((key) => typeof (value.counts as Record<string, unknown>)[key] === "number")) {
    return "index.json has incomplete counts";
  }
  if (!Array.isArray(value.intents)) return "index.json has no intents list";
  for (const intent of value.intents) {
    if (!isRecord(intent)) return "index.json holds an intent that is not an object";
    if (typeof intent.id !== "string" || typeof intent.title !== "string" || typeof intent.path !== "string") return "index.json holds an intent without id, title or path";
    if (intent.source !== "flow" && intent.source !== "docpack") return "index.json holds an intent with an unknown source";
    if (intent.status !== "open" && intent.status !== "closed") return "index.json holds an intent with an unknown status";
    const outcome = intent.outcome;
    if (!isRecord(outcome) || typeof outcome.observed !== "boolean" || (outcome.criterion !== null && typeof outcome.criterion !== "string")) {
      return "index.json holds an intent without a usable outcome";
    }
    if (outcome.verdict !== null && !OUTCOME_VERDICTS.includes(outcome.verdict as (typeof OUTCOME_VERDICTS)[number])) return "index.json holds an intent with an unknown verdict";
    if (outcome.note !== null && typeof outcome.note !== "string") return "index.json holds an intent with an unusable note";
    if (outcome.observed === true && outcome.verdict === null) return "index.json holds an observed intent without a verdict";
  }
  return null;
}

export async function readIntentIndex(cwd: string): Promise<IndexRead> {
  let text: string;
  try {
    text = await readFile(indexPath(cwd), "utf8");
  } catch {
    return { state: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "malformed", reason: "index.json is not valid JSON" };
  }
  const problem = indexProblem(parsed);
  return problem === null ? { state: "present", index: parsed as IntentIndex } : { state: "malformed", reason: problem };
}

/**
 * Stale when the flows or requirements the index was read from are not what they
 * are now: the content fingerprint differs. Time plays no part, so a restored or
 * replaced directory with older modification times still reads as stale and a
 * bare `touch` does not. This only reports; it refuses nothing but `product
 * open`'s own read.
 */
export async function checkStaleness(cwd: string, index: IntentIndex): Promise<Staleness> {
  if ((await corpusFingerprint(cwd)) === index.fingerprint) return { stale: false };
  const packages = await listFlowPackages(cwd);
  // A failure that names a flow the index also holds as an intent (a malformed observation line) is one flow, not two.
  const held = new Set(index.intents.map((intent) => intent.path));
  const failedFlows = new Set(
    index.failures.flatMap((failure) => {
      const flow = /^(\.metaproject\/flows\/[^/:]+)/.exec(failure)?.[1];
      return flow === undefined || held.has(flow) ? [] : [flow];
    }),
  );
  const indexed = index.counts.flows + failedFlows.size;
  if (packages.length !== indexed) return { stale: true, reason: `the index holds ${indexed} flows, the tree ${packages.length}` };
  return { stale: true, reason: "the flows or requirements changed after the index was built" };
}
