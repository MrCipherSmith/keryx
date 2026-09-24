// Path helpers for `src/learning/`'s two stores (project: `.metaproject/data/learning/`;
// user: `<home>/.keryx/learning/`), plus the shared boundary assertion every
// writer in this workstream reuses (W3 spec, "Safety" > "Path boundaries").
import os from "node:os";
import path from "node:path";
import { isPathInside } from "../lib/fs";

/**
 * Mirrors `resolveHookHomeDir` (`src/harness/hooks/config.ts`) byte-for-byte —
 * deliberately NOT imported from there: `src/harness` is zone `client` and
 * `src/learning` is zone `core` (`src/lib/import-zones.ts`), and "a core owner
 * never imports a client or adapter module" has no exception
 * (`src/lib/import-policy.ts`). This is a two-line pure function of
 * `env`/`homeDir` with no other dependency, so duplicating it here keeps the
 * boundary intact rather than asking for one.
 */
function resolveLearningHomeDir(env: NodeJS.ProcessEnv, homeDir?: string): string {
  if (homeDir !== undefined) return homeDir;
  const fromEnv = env.KERYX_HOME;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : os.homedir();
}

/** Same pattern as `learned-pattern.schema.json`'s `id` property — reject anything that could escape a directory (`..`, `/`). */
export const LEARNING_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export class LearningPathError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningPathError";
  }
}

/** Throws `LearningPathError` (reason `learning-invalid-id`) unless `id` matches the schema's `id` pattern. */
export function assertValidLearningId(id: string): void {
  if (!LEARNING_ID_PATTERN.test(id)) {
    throw new LearningPathError("learning-invalid-id", `invalid learned-pattern id: ${JSON.stringify(id)}`);
  }
}

/**
 * Throws `LearningPathError` (reason `learning-path-outside-root`) unless
 * `target` is inside at least one of `allowedRoots`. Every writer in this
 * workstream calls this before touching disk (W3 spec: accept refuses any
 * target outside `.metaproject/data/learning/` or `~/.keryx/learning/`; apply
 * and reviewer-profile apply refuse outside their own roots the same way).
 */
export function assertInsideLearningRoot(target: string, allowedRoots: readonly string[]): void {
  const inside = allowedRoots.some((root) => isPathInside(root, target));
  if (!inside) {
    throw new LearningPathError(
      "learning-path-outside-root",
      `refusing write outside learning root(s) [${allowedRoots.join(", ")}]: ${target}`,
    );
  }
}

// --- Project scope: `.metaproject/data/learning/` -------------------------

export function learningDataDir(root: string): string {
  return path.join(root, ".metaproject", "data", "learning");
}

export function observationsDir(root: string): string {
  return path.join(learningDataDir(root), "observations");
}

/** `date` is a `YYYY-MM-DD` UTC day string. */
export function observationFilePath(root: string, date: string): string {
  return path.join(observationsDir(root), `${date}.jsonl`);
}

export function candidatesDir(root: string): string {
  return path.join(learningDataDir(root), "candidates");
}

/** Every project-scope record (any status) lives here — D1: `candidates/` is the record's own store, not just pre-review candidates. */
export function projectPatternPath(root: string, id: string): string {
  assertValidLearningId(id);
  return path.join(candidatesDir(root), `${id}.json`);
}

export function projectLockPath(root: string): string {
  return path.join(learningDataDir(root), "learn.lock");
}

export function decisionsLogPath(root: string): string {
  return path.join(learningDataDir(root), "decisions.jsonl");
}

export function graduationDir(root: string): string {
  return path.join(learningDataDir(root), "graduation");
}

// --- User scope: `<home>/.keryx/learning/` ---------------------------------

export function userLearningDir(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  return path.join(resolveLearningHomeDir(env, homeDir), ".keryx", "learning");
}

export function userPatternsDir(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  return path.join(userLearningDir(env, homeDir), "patterns");
}

export function userPatternPath(id: string, env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  assertValidLearningId(id);
  return path.join(userPatternsDir(env, homeDir), `${id}.json`);
}

export function userIndexPath(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  return path.join(userLearningDir(env, homeDir), "index.json");
}

export function userLockPath(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  return path.join(userLearningDir(env, homeDir), "learn.lock");
}

export function userDecisionsLogPath(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  return path.join(userLearningDir(env, homeDir), "decisions.jsonl");
}
