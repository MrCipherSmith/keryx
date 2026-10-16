// `arbiter.log`: every question the arbiter was given, what it said, which rule, which model and what it cost.
//
// One JSON object per line, append-only, kept with the review package it belongs to. A run's own copy (the
// autonomous runner points the child at its run directory with `KERYX_ARBITER_LOG`) is copied into the package
// when the run ends, so the package carries the whole record even for questions asked before it was opened.
// Losing a line never stops a question: the log is an observation.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { reviewsRoot } from "./package-location";

/** Set by the runner on the child shell: where this run's arbiter log goes. */
export const ENV_ARBITER_LOG = "KERYX_ARBITER_LOG";

export const ARBITER_LOG_NAME = "arbiter.log";

/** Why a verdict is what it is: `model` is a validated model answer, everything else is the arbiter's own refusal to ask or to trust. */
export const ARBITER_REASONS = [
  "model",
  "cache",
  "floor",
  "invalid-kind",
  "invalid-facts",
  "no-recommendation",
  "cap",
  "timeout",
  "model-error",
  "invalid-output",
  "model-refused",
  "config-invalid",
  "rules-invalid",
  "no-model",
] as const;
export type ArbiterReason = (typeof ARBITER_REASONS)[number];

export interface ArbiterLogRecord {
  readonly at: string;
  /** The question kind as the model named it, or `none` when it named none. Never free text from the question. */
  readonly kind: string;
  readonly facts?: Readonly<Record<string, number | boolean>>;
  readonly verdict: "allow" | "deny" | "escalate";
  /** The rule the verdict cites, or `none`. */
  readonly rule: string;
  readonly reason: ArbiterReason;
  /** The floor class or the validation problem, in the arbiter's own words. */
  readonly detail?: string;
  /** `provider/model` that answered, or that would have. */
  readonly model?: string;
  readonly modelSource?: string;
  /** Option id taken on `allow`. */
  readonly answer?: string;
  readonly cached: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly ms: number;
  readonly rulesVersion?: number;
  readonly rulesHash?: string;
}

export function appendArbiterLog(file: string, record: ArbiterLogRecord): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // an observation; losing a line must not stop the question
  }
}

export function readArbiterLog(file: string): ArbiterLogRecord[] {
  if (!existsSync(file)) return [];
  const records: ArbiterLogRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as ArbiterLogRecord;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.verdict === "string") records.push(parsed);
    } catch {
      // a torn last line of a killed run
    }
  }
  return records;
}

/**
 * The newest review package under `.metaproject/reviews` that is not closed: the one a question belongs to while a
 * review is under way. `undefined` when none is open.
 */
export function openReviewPackageDir(cwd: string): string | undefined {
  const root = reviewsRoot(cwd);
  if (!existsSync(root)) return undefined;
  let best: { dir: string; at: number } | undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
        status?: unknown;
        updatedAt?: unknown;
        createdAt?: unknown;
      };
      if (manifest.status === "closed") continue;
      const stamp = Date.parse(String(manifest.updatedAt ?? manifest.createdAt ?? ""));
      const at = Number.isNaN(stamp) ? 0 : stamp;
      if (best === undefined || at > best.at) best = { dir, at };
    } catch {
      // not a package
    }
  }
  return best?.dir;
}

/** Where a question's record goes: the runner's file, else the open package, else a project-level fallback for questions asked before a package exists. */
export function resolveArbiterLogFile(cwd: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[ENV_ARBITER_LOG];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const pkg = openReviewPackageDir(cwd);
  if (pkg !== undefined) return path.join(pkg, ARBITER_LOG_NAME);
  return path.join(cwd, ".metaproject", "data", "review-arbiter", ARBITER_LOG_NAME);
}

/** Copies a run's log into the package it ended with. Best effort: returns whether a file was written. */
export function copyArbiterLogToPackage(runLog: string, packageDir: string): boolean {
  try {
    if (!existsSync(runLog)) return false;
    mkdirSync(packageDir, { recursive: true });
    copyFileSync(runLog, path.join(packageDir, ARBITER_LOG_NAME));
    return true;
  } catch {
    return false;
  }
}

/** One short line for a surface: `scope allow R-01` / `budget escalate (cap)`. */
export function describeArbiterRecord(record: ArbiterLogRecord): string {
  const rule = record.rule === "none" ? `(${record.reason})` : record.rule;
  return `${record.kind} ${record.verdict} ${rule}${record.cached ? " cached" : ""}`;
}
