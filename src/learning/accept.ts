// `keryx learn accept` / `keryx learn reject` (W3 spec, "Review / Consent" +
// "Cross-project evidence"; plan decisions D2/D4; T8). `acceptPattern` is the
// ONLY code path that produces `status: "accepted"` (AC4/AC11): it is the one
// caller (besides `store.ts` itself and test files — see
// `accept-capability.test.ts`'s import audit) allowed to mint the accept
// capability `store.writePattern` requires for that transition.
import { spawnSync } from "node:child_process";
import { createAcceptCapability } from "./accept-capability";
import { appendDecision } from "./decisions";
import { scanLearnedText } from "./scan";
import { LearningStoreError, readIndex, readPattern, writeIndex, writePattern, type StoreEnvOptions } from "./store";
import type { IndexEntry, LearnedPattern, LearningIndex, LearningScope } from "./types";

export class LearningAcceptError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningAcceptError";
  }
}

const GIT_SPAWN_TIMEOUT_MS = 2000;

/** Best-effort `git config user.email` in `root`. Never throws — git absence or a non-repo directory both read as "no git identity". */
function tryGitUserEmail(root: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", root, "config", "user.email"], {
      timeout: GIT_SPAWN_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const email = result.stdout.trim();
      return email.length > 0 ? email : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Actor resolution: an explicit value (e.g. a future `--actor` flag), else
 * `KERYX_ACTOR`, else `git config user.email` in `root`, else `"unknown"`.
 * Same priority `src/flow/identity.ts` and `src/forgetting/journal.ts` use for
 * their own actor resolution, duplicated here rather than imported — this is
 * a two-line pure lookup, not a shared dependency worth an edge between
 * unrelated feature modules (same reasoning `paths.ts` already states for its
 * own duplicated `resolveHookHomeDir`).
 */
function resolveActor(root: string, explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const stated = explicit?.trim();
  if (stated) return stated;
  const fromEnv = env.KERYX_ACTOR?.trim();
  if (fromEnv) return fromEnv;
  return tryGitUserEmail(root) ?? "unknown";
}

export interface AcceptOptions {
  /** Defaults to `"project"`. */
  scope?: LearningScope;
  /** Overwrite only the current project's index entry with the source record's live confidence, without changing status. Still requires a terminal. */
  refresh?: boolean;
  actor?: string;
  /** No bypass flag or environment variable (plan D2) — accept and refresh both refuse without this. */
  isTerminal: boolean;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface RejectOptions {
  scope?: LearningScope;
  actor?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface AcceptResult {
  id: string;
  scope: LearningScope;
  status: "accepted";
  /** True when this call wrote or refreshed the project-scope index entry (`scope: "project"` only). */
  indexUpdated: boolean;
}

export interface RejectResult {
  id: string;
  scope: LearningScope;
  status: "rejected";
}

function storeOptionsOf(opts: { env?: NodeJS.ProcessEnv; homeDir?: string }): StoreEnvOptions {
  return {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
}

/** Reads the record for `id`+`scope`. Never silently falls back to the other scope — a project-scope miss that exists at user scope is reported with a `--scope user` hint, not resolved for the caller. */
async function resolveRecord(root: string, id: string, scope: LearningScope, storeOptions: StoreEnvOptions): Promise<LearnedPattern> {
  const record = await readPattern(root, id, scope, storeOptions);
  if (record !== undefined) return record;
  if (scope === "project") {
    const atUserScope = await readPattern(root, id, "user", storeOptions);
    if (atUserScope !== undefined) {
      throw new LearningAcceptError(
        "learning-record-not-found",
        `no project-scope record "${id}"; a user-scope record with this id exists here — pass --scope user`,
      );
    }
  }
  throw new LearningAcceptError("learning-record-not-found", `no ${scope}-scope learned-pattern record "${id}"`);
}

function withoutTtl(record: LearnedPattern): LearnedPattern {
  const { ttl, ...rest } = record;
  void ttl;
  return rest;
}

function indexEntryFor(record: LearnedPattern, acceptedAtIso: string): IndexEntry {
  return {
    projectIdentity: record.project.identity,
    identityKind: record.project.identityKind,
    confidence: record.confidence,
    acceptedAt: acceptedAtIso,
  };
}

/** Appends, or (if this identity already has an entry under `id`) replaces, the project's index entry. Returns true — always writes something for a project-scope accept. */
async function upsertIndexEntry(id: string, entry: IndexEntry, storeOptions: StoreEnvOptions): Promise<void> {
  const index = await readIndex(storeOptions);
  const entries = index[id] ?? [];
  const existingIdx = entries.findIndex((e) => e.projectIdentity === entry.projectIdentity);
  const nextEntries = existingIdx >= 0 ? entries.map((e, i) => (i === existingIdx ? entry : e)) : [...entries, entry];
  const nextIndex: LearningIndex = { ...index, [id]: nextEntries };
  await writeIndex(nextIndex, storeOptions);
}

async function doRefresh(
  root: string,
  id: string,
  storeOptions: StoreEnvOptions,
  actor: string,
  nowIso: string,
): Promise<AcceptResult> {
  const record = await resolveRecord(root, id, "project", storeOptions);
  if (record.status !== "accepted") {
    throw new LearningAcceptError(
      "learning-not-accepted",
      `record "${id}" (project) is status "${record.status}", not "accepted"; only an accepted record can be refreshed`,
    );
  }
  const index = await readIndex(storeOptions);
  const entries = index[id];
  const existingIdx = entries?.findIndex((e) => e.projectIdentity === record.project.identity) ?? -1;
  if (entries === undefined || existingIdx < 0) {
    throw new LearningAcceptError(
      "learning-refresh-not-indexed",
      `no index entry for "${id}" under the current project's identity; run \`keryx learn accept ${id}\` first`,
    );
  }
  const refreshed = indexEntryFor(record, nowIso);
  const nextEntries = entries.map((e, i) => (i === existingIdx ? refreshed : e));
  await writeIndex({ ...index, [id]: nextEntries }, storeOptions);
  await appendDecision(root, { action: "refresh", id, actor, tty: true, at: nowIso }, { ...storeOptions, scope: "project" });
  return { id, scope: "project", status: "accepted", indexUpdated: true };
}

/**
 * `status: candidate -> accepted` (W3 "Review / Consent"). Refuses without a
 * terminal (plan D2, no bypass), refuses a target that is not currently a
 * candidate, and rescans `trigger`/`action` before writing (Safety: "Security
 * scan of learned text"). For a `scope: "project"` record only, writes (or,
 * with `refresh`, overwrites only the current project's) entry in
 * `~/.keryx/learning/index.json` (W3 "Cross-project evidence").
 *
 * Every target this function touches is one `store.ts`/`paths.ts` already
 * assert lies inside `.metaproject/data/learning/` or `~/.keryx/learning/`
 * (`writePattern`/`writeIndex` call `assertInsideLearningRoot` themselves) —
 * this function never opens a file outside that boundary.
 */
export async function acceptPattern(root: string, id: string, opts: AcceptOptions): Promise<AcceptResult> {
  if (!opts.isTerminal) {
    throw new LearningAcceptError(
      "accept-requires-terminal",
      "keryx learn accept needs an interactive terminal; there is no bypass flag or environment variable.",
    );
  }
  const scope: LearningScope = opts.scope ?? "project";
  const env = opts.env ?? process.env;
  const now = (opts.now ?? ((): Date => new Date()))();
  const nowIso = now.toISOString();
  const storeOptions = storeOptionsOf(opts);
  const actor = resolveActor(root, opts.actor, env);

  if (opts.refresh) {
    return doRefresh(root, id, storeOptions, actor, nowIso);
  }

  const record = await resolveRecord(root, id, scope, storeOptions);
  if (record.status !== "candidate") {
    throw new LearningAcceptError(
      "learning-not-a-candidate",
      `record "${id}" (${scope}) is status "${record.status}", not "candidate"; only a candidate can be accepted`,
    );
  }

  const scan = await scanLearnedText(root, [record.trigger, record.action]);
  if (scan.findings.length > 0) {
    throw new LearningAcceptError("learning-text-refused", `record "${id}" refused by the security scan: ${scan.findings.join(", ")}`);
  }

  const updated: LearnedPattern = { ...withoutTtl(record), status: "accepted", updatedAt: nowIso };
  await writePattern(root, updated, { ...storeOptions, capability: createAcceptCapability() });
  await appendDecision(root, { action: "accept", id, actor, tty: true, at: nowIso }, { ...storeOptions, scope });

  let indexUpdated = false;
  if (scope === "project") {
    await upsertIndexEntry(id, indexEntryFor(updated, nowIso), storeOptions);
    indexUpdated = true;
  }

  return { id, scope, status: "accepted", indexUpdated };
}

/** `status: candidate -> rejected` (W3 "Review / Consent"). No terminal requirement — rejecting only narrows what can later be accepted. */
export async function rejectPattern(root: string, id: string, opts: RejectOptions = {}): Promise<RejectResult> {
  const scope: LearningScope = opts.scope ?? "project";
  const env = opts.env ?? process.env;
  const now = (opts.now ?? ((): Date => new Date()))();
  const nowIso = now.toISOString();
  const storeOptions = storeOptionsOf(opts);
  const actor = resolveActor(root, opts.actor, env);

  const record = await resolveRecord(root, id, scope, storeOptions);
  if (record.status !== "candidate") {
    throw new LearningAcceptError(
      "learning-not-a-candidate",
      `record "${id}" (${scope}) is status "${record.status}", not "candidate"; only a candidate can be rejected`,
    );
  }

  const updated: LearnedPattern = { ...withoutTtl(record), status: "rejected", updatedAt: nowIso };
  await writePattern(root, updated, storeOptions);
  await appendDecision(root, { action: "reject", id, actor, tty: false, at: nowIso }, { ...storeOptions, scope });

  return { id, scope, status: "rejected" };
}

// Re-exported so a caller catching a store failure alongside an accept
// failure can narrow on one class if it wants to; not required by anything
// in this file.
export { LearningStoreError };
