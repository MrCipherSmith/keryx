/**
 * Persistence for `src/stack/detect.ts`'s output (flow 309, W1, Lane A) —
 * reads/writes `.metaproject/data/stack/stack.json`, and supplies the
 * fingerprint (`inputsSha256`) that lets a re-run on an unchanged tree write
 * a byte-identical file with the SAME `detectedAt` it already had.
 *
 * `keryx stack detect` (`src/commands/stack.ts`) is the only intended writer;
 * this module never mutates skills, rules, or install state — see the W1
 * spec's "Stack detection — output contract" §.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeContained } from "../lib/contained-write";
import { STACK_DETECTION_SCHEMA_VERSION, detectStack, type DetectStackOptions, type StackDetection } from "./detect";

export { STACK_DETECTION_SCHEMA_VERSION };
export type { StackDetection, StackDetectionCore, StackDetectFs, StackDirEntry, StackFamily, StackPerSignal } from "./detect";
export { STACK_DETECT_TAGS, defaultStackDetectFs, detectStack } from "./detect";

/** `<root>/.metaproject/data/stack/stack.json` — the one file this module writes. */
export function stackJsonPath(root: string): string {
  return path.join(root, ".metaproject", "data", "stack", "stack.json");
}

/**
 * Recursively sort every object's keys (arrays keep their given order — the
 * caller is responsible for that order already being deterministic/sorted).
 * This is what makes `serializeStackDetection`'s output byte-identical
 * across a re-run: `JSON.stringify` walks keys in insertion order for
 * string-keyed objects, so inserting them pre-sorted is sufficient.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

/** 2-space indent, trailing newline, every object's keys sorted — the exact bytes written to disk and printed by `--json`. */
export function serializeStackDetection(doc: StackDetection): string {
  return `${JSON.stringify(canonicalize(doc), null, 2)}\n`;
}

/** sha256 of the canonical JSON of everything EXCEPT `detectedAt`/`inputsSha256` — the fingerprint that decides whether `detectedAt` may be reused. */
function fingerprintOf(core: {
  schemaVersion: string;
  tags: Record<string, boolean>;
  uncertain: boolean;
  reason: string;
  matched: readonly string[];
  perSignal: readonly unknown[];
}): string {
  const canonical = JSON.stringify(canonicalize(core));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Read and parse the persisted `stack.json`, or `undefined` if it does not exist / does not parse. */
export async function readStackDetection(root: string): Promise<StackDetection | undefined> {
  try {
    const raw = await readFile(stackJsonPath(root), "utf8");
    const parsed = JSON.parse(raw) as StackDetection;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export interface RunStackDetectOptions extends DetectStackOptions {
  /** Persist to `stack.json`. Default `true`. */
  readonly write?: boolean;
  /** Injectable clock — no `Date` call anywhere else in this module or `detect.ts`. */
  readonly now?: () => Date;
}

/**
 * Run `detectStack` and produce the persisted document: fills in
 * `detectedAt` (kept from the existing `stack.json` when the fingerprint is
 * unchanged, so re-running on an unchanged tree is byte-identical) and
 * `inputsSha256`, then writes it (unless `write: false`).
 */
export async function runStackDetect(root: string, opts: RunStackDetectOptions = {}): Promise<StackDetection> {
  const write = opts.write ?? true;
  const now = opts.now ?? (() => new Date());

  const core = await detectStack(root, opts);
  const inputsSha256 = fingerprintOf(core);

  const existing = await readStackDetection(root);
  const detectedAt = existing !== undefined && existing.inputsSha256 === inputsSha256 ? existing.detectedAt : now().toISOString();

  const doc: StackDetection = {
    schemaVersion: STACK_DETECTION_SCHEMA_VERSION,
    detectedAt,
    inputsSha256,
    tags: core.tags,
    uncertain: core.uncertain,
    reason: core.reason,
    matched: core.matched,
    perSignal: core.perSignal,
  };

  if (write) {
    const target = stackJsonPath(root);
    await writeContained(root, path.relative(root, target), serializeStackDetection(doc));
  }

  return doc;
}
