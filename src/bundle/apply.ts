// Flow 313 (W4 portability), T6 — `keryx bundle import`'s Apply stage: write
// only `new` and forced-`conflict`/`update` entries, atomically (tmp+rename),
// with a TOCTOU re-check (sha256 AND symlink chain) right before each write
// and a full rollback — files, directories `mkdir -p` created, and a
// newly-created private-dir `.gitignore` — if any single write, or the
// ledger update that follows it, fails. Identical entries are recorded in
// the ledger too, so a later re-export/re-import recognizes them as
// Keryx-managed, but ONLY when this bundle already owns that ledger record
// (R1-F1): an `identical` match against a user's own pre-existing file, or
// against a file another bundle's ledger record already claims, is never
// claimed into this bundle's ownership.

import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { ensurePrivateDirGitignore } from "../lib/private-dir";
import { userStorePaths } from "../lib/keryx-home";
import { readAppliedState, writeAppliedState, type AppliedState } from "./applied-state";
import { sha256Hex } from "./checksum";
import { refuseSymlinkChain, scopeRoot, type PathCtx } from "./paths";
import type { PlanEntry, BundlePlan } from "./plan";
import type { AuditBundlePlanResult } from "./audit";
import { BUNDLE_REFUSAL, type BundleRefusal } from "./types";

/** Thrown mid-apply to carry a SPECIFIC refusal reason through to the rollback handler, instead of the generic "apply failed and was rolled back" catch-all. */
class ApplyAbort extends Error {
  constructor(readonly refusal: BundleRefusal) {
    super(refusal.message);
  }
}

export interface ApplyBundlePlanOptions {
  now?: (() => Date) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
}

export interface ApplyBundlePlanResult {
  written: string[];
  unchanged: string[];
  refusals: BundleRefusal[];
}

function writableEntries(plan: BundlePlan): PlanEntry[] {
  return plan.entries.filter((e) => e.bucket === "new" || e.bucket === "update" || (e.bucket === "conflict" && e.forced));
}

async function currentFileSha(absolutePath: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(absolutePath);
    return sha256Hex(bytes);
  } catch {
    return undefined;
  }
}

async function atomicWrite(absolutePath: string, bytes: Buffer): Promise<void> {
  const dir = path.dirname(absolutePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(absolutePath)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmpPath, bytes);
  try {
    await rename(tmpPath, absolutePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function applyBundlePlan(
  plan: BundlePlan,
  auditResult: AuditBundlePlanResult,
  opts: ApplyBundlePlanOptions = {},
): Promise<ApplyBundlePlanResult> {
  if (!plan.ok) {
    return { written: [], unchanged: [], refusals: plan.refusals.length > 0 ? plan.refusals : [{ reason: BUNDLE_REFUSAL.unresolvedConflict, message: "plan is not ok" }] };
  }
  if (!auditResult.ok) {
    return { written: [], unchanged: [], refusals: auditResult.refusals };
  }

  const now = opts.now ?? (() => new Date());
  const toWrite = writableEntries(plan);
  const identical = plan.entries.filter((e) => e.bucket === "identical");

  // TOCTOU re-check: every target's current sha256 must still match what
  // planning observed, or the whole apply refuses before writing anything.
  // Run BEFORE the private-dir `.gitignore` ensure below, so a refusal here
  // still means zero bytes were written anywhere, .gitignore included.
  const toctouRefusals: BundleRefusal[] = [];
  for (const entry of toWrite) {
    const nowSha = await currentFileSha(entry.targetPath);
    if (nowSha !== entry.currentSha256) {
      toctouRefusals.push({
        reason: BUNDLE_REFUSAL.unresolvedConflict,
        path: entry.path,
        message: `${entry.displayId} changed on disk since planning; refusing the whole apply`,
      });
    }
  }
  if (toctouRefusals.length > 0) {
    return { written: [], unchanged: [], refusals: toctouRefusals };
  }

  type RollbackItem =
    | { kind: "file"; absolutePath: string; previousBytes: Buffer | null }
    | { kind: "dir"; absolutePath: string }
    | { kind: "gitignore"; absolutePath: string };

  const rollback: RollbackItem[] = [];
  const written: string[] = [];

  try {
    // Private-dir `.gitignore` fail-closed rule for user-scope memory
    // entries. Moved here (past the TOCTOU re-check, and inside the same
    // try/rollback block as the writes) so it is treated as the FIRST
    // rolled-back write rather than a side effect that survives a refusal
    // or a later failure elsewhere in this apply (R1-F21): the docs promise
    // "a refusal at any stage means zero bytes were written".
    const checkedGitignoreRoots = new Set<string>();
    for (const entry of toWrite) {
      if (entry.targetScope === "user" && entry.kind === "memory-entry") {
        const memoryRoot = userStorePaths(opts.env ?? process.env, opts.homeDir).memory;
        if (!checkedGitignoreRoots.has(memoryRoot)) {
          checkedGitignoreRoots.add(memoryRoot);
          const createdDirs = await mkdirRecordingCreated(memoryRoot);
          const check = await ensurePrivateDirGitignore(memoryRoot);
          if (!check.ok) {
            throw new ApplyAbort({ reason: BUNDLE_REFUSAL.privateGitignoreConflict, message: check.message });
          }
          // Pushed shallowest-first so the OVERALL rollback (which processes
          // the whole array in reverse, LIFO) removes them deepest-first —
          // an rmdir of a still-populated parent is a silent no-op.
          for (const dir of [...createdDirs].reverse()) rollback.push({ kind: "dir", absolutePath: dir });
          if (check.action === "create") {
            rollback.push({ kind: "gitignore", absolutePath: path.join(memoryRoot, ".gitignore") });
          }
        }
      }
    }

    for (const entry of toWrite) {
      // R1-I1: re-run the symlink-chain check (scope root included)
      // immediately before this write. The W8 audit ran between plan and
      // this apply; a parent directory (or the scope root itself) swapped
      // for a symlink in that window must not be silently followed by
      // `mkdir -p`/`rename`.
      const ctx: PathCtx = { projectRoot: plan.projectRoot, env: opts.env, homeDir: opts.homeDir };
      const root = scopeRoot(entry.targetScope, ctx);
      const symlinkCheck = await refuseSymlinkChain(root, entry.targetRelative);
      if (!symlinkCheck.ok) {
        throw new ApplyAbort(symlinkCheck.refusal);
      }

      let previousBytes: Buffer | null = null;
      try {
        previousBytes = await readFile(entry.targetPath);
      } catch {
        previousBytes = null;
      }
      const createdDirs = await mkdirRecordingCreated(path.dirname(entry.targetPath));
      for (const dir of [...createdDirs].reverse()) rollback.push({ kind: "dir", absolutePath: dir });
      rollback.push({ kind: "file", absolutePath: entry.targetPath, previousBytes });
      await atomicWrite(entry.targetPath, entry.bytes);
      written.push(entry.displayId);
    }

    // Update the ledger(s):
    //   - every WRITTEN path (new/update/forced) is recorded under this
    //     bundle's id unconditionally — this bundle really did write it.
    //   - an `identical` entry is recorded ONLY when a ledger record for it
    //     already exists AND already belongs to this bundle (a re-import
    //     refreshing its own record). An `identical` match against a file
    //     that predates any Keryx bundle (no ledger record), or against a
    //     file another bundle's ledger already owns, is left untouched —
    //     claiming it would let a later `uninstall` of THIS bundle delete a
    //     file it never wrote, and would steal ownership from whichever
    //     bundle (if any) actually did write it (R1-F1).
    const byScope = new Map<string, { ledgerPath: string; state: AppliedState }>();
    async function ledgerFor(scope: string, ledgerPath: string): Promise<{ ledgerPath: string; state: AppliedState }> {
      const existing = byScope.get(scope);
      if (existing) return existing;
      const read = await readAppliedState(ledgerPath);
      if (!read.ok) {
        // R1-F29: an unreadable/corrupt ledger must refuse, not be silently
        // treated as empty — that would overwrite every other bundle's
        // records with only this apply's own entries.
        throw new ApplyAbort({ reason: BUNDLE_REFUSAL.corruptLedger, message: read.message });
      }
      const entry = { ledgerPath, state: read.state };
      byScope.set(scope, entry);
      return entry;
    }

    for (const entry of toWrite) {
      const bucket = await ledgerFor(entry.targetScope, resolveLedgerPathForEntry(entry, opts));
      bucket.state.entries[entry.targetRelative] = {
        bundleId: plan.bundleId,
        sha256: entry.incomingSha256,
        kind: entry.kind,
        appliedAt: now().toISOString(),
      };
    }
    for (const entry of identical) {
      const bucket = await ledgerFor(entry.targetScope, resolveLedgerPathForEntry(entry, opts));
      const existingRecord = bucket.state.entries[entry.targetRelative];
      if (existingRecord === undefined || existingRecord.bundleId !== plan.bundleId) {
        continue; // not ours to claim — see comment above.
      }
      bucket.state.entries[entry.targetRelative] = {
        bundleId: plan.bundleId,
        sha256: entry.incomingSha256,
        kind: entry.kind,
        appliedAt: now().toISOString(),
      };
    }

    // R1-F29: if a ledger write itself throws (disk full, permissions), roll
    // back the files already written above too — they must not be left on
    // disk unrecorded, which would defeat uninstall/no-clobber for them.
    for (const { ledgerPath, state } of byScope.values()) {
      await writeAppliedState(ledgerPath, state);
    }
  } catch (err) {
    for (const item of rollback.reverse()) {
      try {
        if (item.kind === "file") {
          if (item.previousBytes === null) {
            await unlink(item.absolutePath).catch(() => undefined);
          } else {
            await writeFile(item.absolutePath, item.previousBytes);
          }
        } else if (item.kind === "gitignore") {
          await unlink(item.absolutePath).catch(() => undefined);
        } else {
          await rmdir(item.absolutePath).catch(() => undefined); // best-effort; only removes if now-empty
        }
      } catch {
        // best-effort rollback
      }
    }
    const refusal: BundleRefusal =
      err instanceof ApplyAbort ? err.refusal : { reason: BUNDLE_REFUSAL.applyFailed, message: `apply failed and was rolled back: ${err instanceof Error ? err.message : String(err)}` };
    return { written: [], unchanged: [], refusals: [refusal] };
  }

  return { written, unchanged: identical.map((e) => e.displayId), refusals: [] };
}

/**
 * `mkdir(dir, { recursive: true })`, but also returns every directory that
 * did NOT already exist (deepest first), so a caller can roll them back —
 * `rmdir` is a no-op if something else has since populated them, which is
 * exactly the best-effort behavior rollback wants (R1-F21).
 */
async function mkdirRecordingCreated(dir: string): Promise<string[]> {
  const missing: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    try {
      await stat(current);
      break;
    } catch {
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (missing.length > 0) {
    await mkdir(dir, { recursive: true });
  }
  return missing; // deepest-first (the order `rmdir` needs); callers pushing onto the LIFO `rollback` array must reverse this first.
}

// `appliedStatePath` needs a `PathCtx` (a `projectRoot`), but apply's
// `PlanEntry` only carries an absolute target path. Since every entry in one
// plan shares one project root (the plan's own `opts.projectRoot`), the
// ledger path is derived once per scope from `userStorePaths`/the fixed
// `.metaproject` layout directly, sidestepping the need to thread
// `projectRoot` through `PlanEntry`.
function resolveLedgerPathForEntry(entry: PlanEntry, opts: ApplyBundlePlanOptions): string {
  if (entry.targetScope === "user") {
    return userStorePaths(opts.env ?? process.env, opts.homeDir).appliedState;
  }
  // project/team: walk up from the target path to the `.metaproject` root.
  const metaprojectIdx = entry.targetPath.indexOf(`${path.sep}.metaproject${path.sep}`);
  const metaprojectRoot =
    metaprojectIdx === -1 ? path.join(path.dirname(entry.targetPath), ".metaproject") : entry.targetPath.slice(0, metaprojectIdx + `${path.sep}.metaproject`.length);
  return path.join(metaprojectRoot, "data", "bundles", "applied-state.json");
}
