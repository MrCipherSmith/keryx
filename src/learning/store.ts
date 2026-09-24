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

/**
 * R2-F5: whitelist of `LearnedPattern` fields `updatePattern` allows to
 * change on a record whose STORED (pre-update) status is already
 * `"accepted"`, without holding the accept capability. Everything else —
 * `domain`, `status`, `supersededBy`, `reviewerProfile`, `redaction`,
 * `provenance`, `schemaVersion` — must round-trip unchanged (checked below);
 * `id`/`scope`/`project`/`createdAt`/`trigger`/`action` have their own,
 * more specific refusal reasons already and are excluded from this list so
 * they are not checked twice. `ttl` is intentionally absent from both this
 * list and the checked-fields list below — an accepted record never carries
 * one, enforced by its own explicit check.
 */
const ACCEPTED_IMMUTABLE_CHECK_FIELDS = [
  "domain",
  "status",
  "supersededBy",
  "reviewerProfile",
  "redaction",
  "provenance",
  "schemaVersion",
] as const satisfies readonly (keyof LearnedPattern)[];

/** Plain structural equality over JSON-shaped values (strings/numbers/booleans/null/arrays/plain objects) — every field this compares (`ACCEPTED_IMMUTABLE_CHECK_FIELDS`) is exactly that shape. */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualJson(item, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqualJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
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

/**
 * Reads and validates one record. Returns `undefined` when it does not
 * exist. Throws `learning-record-invalid` for a stored-but-corrupt record.
 *
 * R1-F1: the path is derived from `id`+`scope`, but the file's own CONTENT is
 * not otherwise checked to agree with them — a file at `candidates/p2.json`
 * could hold `id: "p2other"`, or a file planted directly inside the
 * project-scope store could hold `scope: "user"`. Either lets a caller that
 * trusts the returned record's own `id`/`scope` fields (every store writer
 * does) act on, or overwrite, a different identity than the one it asked
 * for — `keryx learn accept p2` would accept whatever id the file's content
 * claims, not `"p2"`; `writePattern`'s "already accepted" exemption would
 * read a project-store plant as proof a *user-scope* record is accepted.
 * Both are refused here, once, for every reader (`listPatterns` too, since
 * it calls this): `record.id !== id || record.scope !== scope` throws
 * `learning-record-identity-mismatch` instead of returning the record under
 * an identity it does not actually have.
 */
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
  const record = parsed as LearnedPattern;
  if (record.id !== id || record.scope !== scope) {
    throw new LearningStoreError(
      "learning-record-identity-mismatch",
      `stored file for "${id}" (${scope}) actually holds id ${JSON.stringify(record.id)} scope ${JSON.stringify(record.scope)} — refusing to return it under the requested identity`,
    );
  }
  return record;
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

/** Lists records across one or both scopes, filtered by `status`/`domain`. Skips ids that fail id-pattern validation rather than throwing; a filename/content identity mismatch (see `readPattern`) is skipped too, with a warning — never returned under the filename's id/scope. */
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
      } catch (error) {
        if (error instanceof LearningStoreError && error.reason === "learning-record-identity-mismatch") {
          console.error(`keryx learn: WARNING — skipping stored file for "${id}" (${scope}): ${error.message}`);
        }
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

/** True when the record currently on disk for `id`+`scope` has `status: "accepted"`. A missing or corrupt stored record reads as `false` — never treated as "already accepted" by default. */
async function isStoredAsAccepted(
  root: string,
  id: string,
  scope: LearningScope,
  options: StoreEnvOptions,
): Promise<boolean> {
  try {
    const stored = await readPattern(root, id, scope, options);
    return stored?.status === "accepted";
  } catch {
    return false;
  }
}

export interface WritePatternOptions extends StoreEnvOptions {
  /** Required when `record.status === "accepted"` — see `accept-capability.ts`. */
  capability?: AcceptCapability;
}

/**
 * The validate/capability-check/path-bound/write steps, WITHOUT acquiring
 * the scope's lock — only ever called from inside a callback already
 * holding it (`writePattern` below, and `updatePattern`/`createPattern`).
 * `withFileLock` is not reentrant (it is a plain `mkdir` exclusion), so
 * nothing in this module may call `writePattern` (or `withFileLock` on the
 * same lock path) again from inside one of these callbacks — that would
 * deadlock against itself.
 *
 * Refuses (throws `LearningStoreError`):
 *  - an invalid record (`learning-record-invalid`);
 *  - a target outside its scope's learning root (`learning-path-outside-root`,
 *    from `assertInsideLearningRoot`);
 *  - `status: "accepted"` without the accept capability
 *    (`learning-accept-capability-required`) — UNLESS the record already
 *    stored under the same scope+id also has `status: "accepted"`. That case
 *    is not a `candidate -> accepted` transition (only `keryx learn accept`,
 *    holding the capability, may ever produce that transition — AC4/AC11); it
 *    is an already-accepted record picking up new evidence (`extract.ts`'s
 *    reinforcement/decay passes, which run on candidate AND accepted records
 *    alike and must not need the capability to touch the latter). Read
 *    failure/absence is treated as "not already accepted", so a forged first
 *    write still requires the capability.
 *  - `learning-accepted-text-immutable` (R2-F4) — the record currently
 *    stored on disk at `record.id`+`record.scope` is ALREADY `status:
 *    "accepted"` and `record` carries a different `trigger`/`action` than
 *    that stored copy. `updatePattern` already refuses this (comparing its
 *    own before/after), but that check is enforced only for callers that go
 *    through the choke point; this is the same refusal pushed down into the
 *    one function every write (`writePattern` included) funnels through, so
 *    a caller that reaches `writePattern` directly (bypassing
 *    `updatePattern`) cannot silently rewrite an accepted record's text
 *    either. Deliberately NOT extended to the other immutable fields
 *    (`project.identity`/`identityKind`/`createdAt`) `updatePattern` also
 *    checks: those are legitimate to differ here — `createPattern` replacing
 *    a terminal (`rejected`/`superseded`/`expired`) record (e.g. `promote.ts`
 *    re-promoting after an earlier promotion was rejected) intentionally
 *    writes a fresh `createdAt`, and a terminal record is never `"accepted"`
 *    so this check never fires for that path.
 */
async function writeRecordUnlocked(root: string, record: LearnedPattern, options: WritePatternOptions): Promise<void> {
  assertValidLearningId(record.id);
  const validation = validateLearnedPattern(record);
  if (!validation.ok) {
    throw new LearningStoreError(
      "learning-record-invalid",
      `refusing to write invalid record ${record.id}: ${validation.errors.join("; ")}`,
    );
  }
  if (record.status === "accepted" && !isAcceptCapability(options.capability)) {
    const alreadyAccepted = await isStoredAsAccepted(root, record.id, record.scope, options);
    if (!alreadyAccepted) {
      throw new LearningStoreError(
        "learning-accept-capability-required",
        `refusing to write status:"accepted" for ${record.id} without the accept capability`,
      );
    }
  }
  let storedExisting: LearnedPattern | undefined;
  try {
    storedExisting = await readPattern(root, record.id, record.scope, options);
  } catch {
    storedExisting = undefined;
  }
  if (
    storedExisting !== undefined &&
    storedExisting.status === "accepted" &&
    (record.trigger !== storedExisting.trigger || record.action !== storedExisting.action)
  ) {
    throw new LearningStoreError(
      "learning-accepted-text-immutable",
      `refusing to change the trigger/action text of already-accepted record "${record.id}" (${record.scope})`,
    );
  }
  const target = patternPathFor(root, record.id, record.scope, options);
  assertInsideLearningRoot(target, [allowedRootFor(root, record.scope, options)]);
  await writeFileAtomic(target, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Validates, path-bounds, locks and atomically writes `record` to its own
 * scope's store. Low-level primitive: this module's OWN tests
 * (`store.test.ts`) exercise it directly, but no other module under
 * `src/learning` may call it (a source-audit guard test —
 * `store-choke-point.test.ts` — enforces this over every non-test `.ts` file
 * except this one). Every other writer in this workstream goes through
 * `updatePattern` (an existing record) or `createPattern` (a brand new one),
 * which layer the identity/immutability checks R1-F1/R1-F7 need on top of
 * this function's own validation/capability/path/lock/atomicity guarantees —
 * guarantees this function keeps providing them.
 */
export async function writePattern(
  root: string,
  record: LearnedPattern,
  options: WritePatternOptions = {},
): Promise<void> {
  const lockPath = lockPathFor(root, record.scope, options);
  await withFileLock(lockPath, () => writeRecordUnlocked(root, record, options));
}

export type PatternMutator = (existing: LearnedPattern) => LearnedPattern;

/**
 * Read-modify-write choke point for an EXISTING record (R1-F1 + R1-F7): the
 * only way any module besides `store.ts` may change a stored record. Runs
 * entirely under ONE acquisition of the scope's file lock — the read, the
 * mutator, and the write — so a concurrent pass (another `extract`, an
 * `accept`) can never interleave between this call's read and its write
 * (R1-F7: `extract`'s reinforcement/decay pass used to read-modify-write
 * outside any lock and could revert a concurrent accept).
 *
 * Refuses (`LearningStoreError`):
 *  - `learning-record-not-found` — no record stored at `id`+`scope`.
 *  - `learning-record-identity-mismatch` — bubbled up from the locked read
 *    (see `readPattern`) when the stored file's own `id`/`scope` does not
 *    match the ones requested, OR when `mutator`'s return value changes
 *    `id`/`scope` itself.
 *  - `learning-record-immutable-field-changed` — `mutator` changed
 *    `project.identity`, `project.identityKind`, or `createdAt`.
 *  - `learning-accepted-text-immutable` — the record stored on disk is
 *    ALREADY `status: "accepted"` and `mutator` changed `trigger` or
 *    `action`. Only `keryx learn accept`'s own candidate -> accepted
 *    transition may ever set that text, and that transition never reaches
 *    this branch (the record it reads is still `status: "candidate"`).
 *  - whatever the underlying write refuses (`learning-record-invalid`,
 *    `learning-accept-capability-required`, `learning-path-outside-root`).
 */
export async function updatePattern(
  root: string,
  id: string,
  scope: LearningScope,
  mutator: PatternMutator,
  options: WritePatternOptions = {},
): Promise<LearnedPattern> {
  assertValidLearningId(id);
  const lockPath = lockPathFor(root, scope, options);
  return withFileLock(lockPath, async () => {
    const existing = await readPattern(root, id, scope, options);
    if (existing === undefined) {
      throw new LearningStoreError("learning-record-not-found", `no ${scope}-scope learned-pattern record "${id}" to update`);
    }
    const next = mutator(existing);
    if (next.id !== existing.id || next.scope !== existing.scope) {
      throw new LearningStoreError(
        "learning-record-identity-mismatch",
        `refusing to change id/scope of "${id}" (${scope}) via an update`,
      );
    }
    if (
      next.project.identity !== existing.project.identity ||
      next.project.identityKind !== existing.project.identityKind ||
      next.createdAt !== existing.createdAt
    ) {
      throw new LearningStoreError(
        "learning-record-immutable-field-changed",
        `refusing to change project identity/createdAt of "${id}" (${scope}) via an update`,
      );
    }
    if (existing.status === "accepted" && (next.trigger !== existing.trigger || next.action !== existing.action)) {
      throw new LearningStoreError(
        "learning-accepted-text-immutable",
        `refusing to change the trigger/action text of already-accepted record "${id}" (${scope})`,
      );
    }
    if (existing.status === "accepted") {
      // R2-F5: an accepted record routes `domain`/`reviewerProfile` into
      // `apply.ts`'s proposal target and `reviewer-profile.ts`'s rendered
      // output — either one silently changing without a fresh human accept
      // would re-route an already-consented record. Whitelist what MAY
      // change on an accepted record instead of only blacklisting
      // trigger/action: everything not in `ACCEPTED_MUTABLE_FIELDS` (and not
      // already covered by the id/scope/project-identity/createdAt/
      // trigger/action checks above) must come back unchanged, and `ttl`
      // must stay absent (an accepted record never carries one).
      if (next.ttl !== undefined) {
        throw new LearningStoreError(
          "learning-accepted-field-immutable",
          `refusing to add a ttl to already-accepted record "${id}" (${scope})`,
        );
      }
      for (const key of ACCEPTED_IMMUTABLE_CHECK_FIELDS) {
        if (!deepEqualJson(next[key], existing[key])) {
          throw new LearningStoreError(
            "learning-accepted-field-immutable",
            `refusing to change "${key}" of already-accepted record "${id}" (${scope}) via an update`,
          );
        }
      }
    }
    await writeRecordUnlocked(root, next, options);
    return next;
  });
}

export interface CreatePatternOptions extends WritePatternOptions {
  /**
   * R2-F3: the ONLY statuses an existing stored record at `record.id`+
   * `record.scope` may have for this call to replace it. Defaults to none —
   * an existing record of ANY status (active or terminal) refuses the
   * create — so every caller must say explicitly what it intends to
   * overwrite rather than relying on "terminal is always replaceable":
   *  - `extract.ts` passes nothing (the default): a rejected/superseded/
   *    expired record is never resurfaced by extraction, matching "extract
   *    never re-drafts a decided pattern" — `upsertDraft` already skips
   *    terminal records it read before the lock, and this default closes the
   *    race the old unconditional-terminal-replace left open (a record
   *    rejected concurrently, after that read, could still be overwritten).
   *  - `promote.ts` passes `["rejected", "expired", "superseded"]`: promotion
   *    may replace an earlier, no-longer-active promotion attempt at the
   *    same id in the user-scope store.
   * `"accepted"` must never appear in this list for any caller — a
   * `createPattern` replacing an accepted record would bypass the
   * accept-capability transition entirely; nothing in this codebase does.
   */
  replaceableStatuses?: readonly LearningStatus[];
}

/**
 * Write choke point for a BRAND NEW record (R1-F1 + R1-F7's sibling case):
 * refuses, under the scope's lock, when a record already exists at
 * `record.id`+`record.scope` whose status is not explicitly listed in
 * `options.replaceableStatuses` (R2-F3; see that option's own doc) —
 * `learning-record-already-exists` — rather than silently overwriting it.
 * The rejected/replaceable check happens on the read taken UNDER the lock,
 * not any snapshot the caller read beforehand, so a concurrent write
 * landing between the caller's own pre-check and this call cannot resurface
 * a decided record.
 */
export async function createPattern(root: string, record: LearnedPattern, options: CreatePatternOptions = {}): Promise<void> {
  assertValidLearningId(record.id);
  const replaceable = new Set(options.replaceableStatuses ?? []);
  const lockPath = lockPathFor(root, record.scope, options);
  await withFileLock(lockPath, async () => {
    const existing = await readPattern(root, record.id, record.scope, options);
    if (existing !== undefined && !replaceable.has(existing.status)) {
      throw new LearningStoreError(
        "learning-record-already-exists",
        `refusing to create "${record.id}" (${record.scope}): a (${existing.status}) record already exists there and is not in the caller's replaceable-status list`,
      );
    }
    await writeRecordUnlocked(root, record, options);
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

/** The validate/path-bound/write steps, WITHOUT acquiring the user lock — only called from inside a callback that already holds it (`writeIndex`, `updateIndex`). Same non-reentrancy rule as `writeRecordUnlocked`. */
async function writeIndexUnlocked(index: LearningIndex, options: StoreEnvOptions): Promise<void> {
  for (const [id, entries] of Object.entries(index)) {
    if (!entries.every(isIndexEntry)) {
      throw new LearningStoreError("learning-index-invalid", `refusing to write malformed index entry for "${id}"`);
    }
  }
  const target = userIndexPath(envOf(options), options.homeDir);
  assertInsideLearningRoot(target, [userLearningDir(envOf(options), options.homeDir)]);
  await writeFileAtomic(target, `${JSON.stringify(index, null, 2)}\n`);
}

/** Validates every entry has exactly the four documented fields, then atomically writes the whole index under the user lock. Low-level primitive — a caller changing existing entries (rather than replacing the whole index wholesale, as tests do) should prefer `updateIndex` (R1-F7: a read-then-write split outside any lock can drop a concurrent writer's entry). */
export async function writeIndex(index: LearningIndex, options: StoreEnvOptions = {}): Promise<void> {
  const lockPath = userLockPath(envOf(options), options.homeDir);
  await withFileLock(lockPath, () => writeIndexUnlocked(index, options));
}

/**
 * Read-modify-write choke point for `~/.keryx/learning/index.json` (R1-F7's
 * index sibling): reads the current index, applies `mutator`, and writes the
 * result back — all under ONE acquisition of the user lock, so two concurrent
 * `accept`s (or an `accept` and a `refresh`) can never interleave their own
 * read and write and drop one another's entry.
 */
export async function updateIndex(
  mutator: (index: LearningIndex) => LearningIndex,
  options: StoreEnvOptions = {},
): Promise<LearningIndex> {
  const lockPath = userLockPath(envOf(options), options.homeDir);
  return withFileLock(lockPath, async () => {
    const current = await readIndex(options);
    const next = mutator(current);
    await writeIndexUnlocked(next, options);
    return next;
  });
}
