// Project + user record stores for `learned-pattern` records (W3 spec,
// "Cross-project evidence" + AC4/AC11): every write is validated, path-
// bounded, file-locked, and a `status: "accepted"` write is refused unless
// the caller holds the accept capability minted by `accept-capability.ts`
// (only `accept.ts`, T8, is meant to hold one).
import { readdir, readFile } from "node:fs/promises";
import { isAcceptCapability, type AcceptCapability } from "./accept-capability";
import { pathExists, withFileLock, writeFileAtomic } from "../lib/fs";
import {
  assertInsideLearningRoot,
  assertValidLearningId,
  candidatesDir,
  learningDataDir,
  projectLockPath,
  projectPatternPath,
  userIndexPath,
  userLearningDir,
  userLockPath,
  userPatternPath,
  userPatternsDir,
} from "./paths";
import { validateLearnedPattern } from "./schema";
import type {
  IndexEntry,
  LearnedPattern,
  LearningDomain,
  LearningIndex,
  LearningScope,
  LearningStatus,
  ProjectIdentityKind,
} from "./types";

export class LearningStoreError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningStoreError";
  }
}

export interface StoreEnvOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function envOf(options: StoreEnvOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function patternPathFor(root: string, id: string, scope: LearningScope, options: StoreEnvOptions): string {
  return scope === "project" ? projectPatternPath(root, id) : userPatternPath(id, envOf(options), options.homeDir);
}

function lockPathFor(root: string, scope: LearningScope, options: StoreEnvOptions): string {
  return scope === "project" ? projectLockPath(root) : userLockPath(envOf(options), options.homeDir);
}

function allowedRootFor(root: string, scope: LearningScope, options: StoreEnvOptions): string {
  return scope === "project" ? learningDataDir(root) : userLearningDir(envOf(options), options.homeDir);
}

/** Reads and validates one record. Returns `undefined` when it does not exist. Throws `learning-record-invalid` for a stored-but-corrupt record. */
export async function readPattern(
  root: string,
  id: string,
  scope: LearningScope,
  options: StoreEnvOptions = {},
): Promise<LearnedPattern | undefined> {
  assertValidLearningId(id);
  const target = patternPathFor(root, id, scope, options);
  if (!(await pathExists(target))) return undefined;
  const raw = await readFile(target, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const result = validateLearnedPattern(parsed);
  if (!result.ok) {
    throw new LearningStoreError(
      "learning-record-invalid",
      `stored record ${id} (${scope}) failed validation: ${result.errors.join("; ")}`,
    );
  }
  return parsed as LearnedPattern;
}

export interface ListPatternsFilter {
  scope?: LearningScope;
  status?: LearningStatus;
  domain?: LearningDomain;
}

async function listIds(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/** Lists records across one or both scopes, filtered by `status`/`domain`. Skips ids that fail id-pattern validation rather than throwing. */
export async function listPatterns(
  root: string,
  filter: ListPatternsFilter = {},
  options: StoreEnvOptions = {},
): Promise<LearnedPattern[]> {
  const scopes: LearningScope[] = filter.scope !== undefined ? [filter.scope] : ["project", "user"];
  const records: LearnedPattern[] = [];
  for (const scope of scopes) {
    const dir = scope === "project" ? candidatesDir(root) : userPatternsDir(envOf(options), options.homeDir);
    for (const id of await listIds(dir)) {
      let record: LearnedPattern | undefined;
      try {
        record = await readPattern(root, id, scope, options);
      } catch {
        continue;
      }
      if (record === undefined) continue;
      if (filter.status !== undefined && record.status !== filter.status) continue;
      if (filter.domain !== undefined && record.domain !== filter.domain) continue;
      records.push(record);
    }
  }
  return records;
}

export interface WritePatternOptions extends StoreEnvOptions {
  /** Required when `record.status === "accepted"` — see `accept-capability.ts`. */
  capability?: AcceptCapability;
}

/**
 * Validates, path-bounds, locks and atomically writes `record` to its own
 * scope's store. Refuses (throws `LearningStoreError`):
 *  - an invalid record (`learning-record-invalid`);
 *  - a target outside its scope's learning root (`learning-path-outside-root`,
 *    from `assertInsideLearningRoot`);
 *  - `status: "accepted"` without the accept capability
 *    (`learning-accept-capability-required`).
 */
export async function writePattern(
  root: string,
  record: LearnedPattern,
  options: WritePatternOptions = {},
): Promise<void> {
  assertValidLearningId(record.id);
  const validation = validateLearnedPattern(record);
  if (!validation.ok) {
    throw new LearningStoreError(
      "learning-record-invalid",
      `refusing to write invalid record ${record.id}: ${validation.errors.join("; ")}`,
    );
  }
  if (record.status === "accepted" && !isAcceptCapability(options.capability)) {
    throw new LearningStoreError(
      "learning-accept-capability-required",
      `refusing to write status:"accepted" for ${record.id} without the accept capability`,
    );
  }
  const target = patternPathFor(root, record.id, record.scope, options);
  assertInsideLearningRoot(target, [allowedRootFor(root, record.scope, options)]);
  const lockPath = lockPathFor(root, record.scope, options);
  await withFileLock(lockPath, async () => {
    await writeFileAtomic(target, `${JSON.stringify(record, null, 2)}\n`);
  });
}

// --- Cross-project index (~/.keryx/learning/index.json) --------------------

const INDEX_ENTRY_KEYS = "acceptedAt,confidence,identityKind,projectIdentity";
const IDENTITY_KINDS: readonly ProjectIdentityKind[] = ["remote-hash", "path-hash"];

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  return (
    keys === INDEX_ENTRY_KEYS &&
    typeof record.projectIdentity === "string" &&
    IDENTITY_KINDS.includes(record.identityKind as never) &&
    typeof record.confidence === "number" &&
    typeof record.acceptedAt === "string"
  );
}

/** Reads `~/.keryx/learning/index.json`, or `{}` when it does not exist yet. Throws `learning-index-invalid` for a malformed file. */
export async function readIndex(options: StoreEnvOptions = {}): Promise<LearningIndex> {
  const target = userIndexPath(envOf(options), options.homeDir);
  if (!(await pathExists(target))) return {};
  const raw = await readFile(target, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LearningStoreError("learning-index-invalid", "index.json must be an object");
  }
  const index: LearningIndex = {};
  for (const [id, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries) || !entries.every(isIndexEntry)) {
      throw new LearningStoreError("learning-index-invalid", `index.json entry for "${id}" is malformed`);
    }
    index[id] = entries;
  }
  return index;
}

/** Validates every entry has exactly the four documented fields, then atomically writes the whole index under the user lock. */
export async function writeIndex(index: LearningIndex, options: StoreEnvOptions = {}): Promise<void> {
  for (const [id, entries] of Object.entries(index)) {
    if (!entries.every(isIndexEntry)) {
      throw new LearningStoreError("learning-index-invalid", `refusing to write malformed index entry for "${id}"`);
    }
  }
  const target = userIndexPath(envOf(options), options.homeDir);
  assertInsideLearningRoot(target, [userLearningDir(envOf(options), options.homeDir)]);
  const lockPath = userLockPath(envOf(options), options.homeDir);
  await withFileLock(lockPath, async () => {
    await writeFileAtomic(target, `${JSON.stringify(index, null, 2)}\n`);
  });
}
