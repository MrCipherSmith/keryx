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

import { mkdir, rmdir, stat } from "node:fs/promises";
import path from "node:path";

import { removeContained, writeContained } from "../lib/contained-write";
import { ensurePrivateDirGitignore } from "../lib/private-dir";
import { userStorePaths } from "../lib/keryx-home";
import { readAppliedState, writeAppliedState, type AppliedState } from "./applied-state";
import { sha256Hex } from "./checksum";
import { canonicalBundleKey, readTargetFile, refuseSymlinkChain, scopeRoot, type PathCtx } from "./paths";
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

/**
 * Flow 313 re-plan, lane C2: apply's own writes now route through the
 * shared `writeContained` primitive (lane C1) rather than a locally
 * duplicated tmp+rename — `root`/`rel` re-derive the same containment
 * guarantee `targetFor`/`refuseSymlinkChain` already checked, so a symlink
 * planted between planning and this exact write is refused here too, not
 * only reported by the separate `refuseSymlinkChain` re-check just above
 * each call site.
 */
async function atomicWrite(root: string, rel: string, bytes: Buffer): Promise<void> {
  await writeContained(root, rel, bytes);
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
    // R2-F20: an unreadable target (permissions changed between plan and
    // apply) is a refusal in its own right, not silently "the file is now
    // absent" — which would otherwise agree with a `new`-bucket entry's
    // `currentSha256: undefined` and let apply write straight over/through
    // it without ever re-checking the TOCTOU condition for real.
    const nowFile = await readTargetFile(entry.targetPath);
    if (!nowFile.ok) {
      toctouRefusals.push({ ...nowFile.refusal, path: entry.path });
      continue;
    }
    const nowSha = nowFile.bytes === undefined ? undefined : sha256Hex(nowFile.bytes);
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
    | { kind: "file"; root: string; rel: string; previousBytes: Buffer | null }
    | { kind: "dir"; absolutePath: string }
    | { kind: "gitignore"; root: string; rel: string };

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
          // `root` bounds the check's own ancestor-symlink walk to the user
          // store root, matching plan.ts's `checkPrivateDirGitignore` call —
          // a symlink anywhere between the store root and `memoryRoot` that
          // escapes the store is refused, not only a symlinked `memory/`.
          const ctx: PathCtx = { projectRoot: plan.projectRoot, env: opts.env, homeDir: opts.homeDir };
          const check = await ensurePrivateDirGitignore(memoryRoot, scopeRoot("user", ctx));
          if (!check.ok) {
            throw new ApplyAbort({ reason: BUNDLE_REFUSAL.privateGitignoreConflict, message: check.message });
          }
          // Pushed shallowest-first so the OVERALL rollback (which processes
          // the whole array in reverse, LIFO) removes them deepest-first —
          // an rmdir of a still-populated parent is a silent no-op.
          for (const dir of [...createdDirs].reverse()) rollback.push({ kind: "dir", absolutePath: dir });
          if (check.action === "create") {
            rollback.push({ kind: "gitignore", root: memoryRoot, rel: ".gitignore" });
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

      // R2-F20: an EACCES (or similar) here is not "the file didn't exist" —
      // that misreading made rollback `unlink` a file that, in fact, still
      // existed but merely could not be read at the moment of the write.
      // Refuse before writing anything for this entry rather than guess.
      const previousFile = await readTargetFile(entry.targetPath);
      if (!previousFile.ok) {
        throw new ApplyAbort({ ...previousFile.refusal, path: entry.path });
      }
      const previousBytes: Buffer | null = previousFile.bytes ?? null;
      const createdDirs = await mkdirRecordingCreated(path.dirname(entry.targetPath));
      for (const dir of [...createdDirs].reverse()) rollback.push({ kind: "dir", absolutePath: dir });
      rollback.push({ kind: "file", root, rel: entry.targetRelative, previousBytes });
      await atomicWrite(root, entry.targetRelative, entry.bytes);
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
      // Choke point b (R3-F2): the ledger key is the CANONICAL form of the
      // path, not its own casing, so a case-variant path from a different
      // bundle collides with (and conflicts against) the same record.
      bucket.state.entries[canonicalBundleKey(entry.targetRelative)] = {
        bundleId: plan.bundleId,
        sha256: entry.incomingSha256,
        kind: entry.kind,
        appliedAt: now().toISOString(),
        path: entry.targetRelative,
        // R3-F18: recorded so a LATER import declaring the same bundleId
        // but a different provenance is caught as owned-by-other-bundle
        // instead of silently updating this bundle's files.
        ...(plan.bundleSourceProject !== undefined ? { sourceProject: plan.bundleSourceProject } : {}),
        contentDigest: plan.bundleContentDigest,
      };
    }
    for (const entry of identical) {
      const bucket = await ledgerFor(entry.targetScope, resolveLedgerPathForEntry(entry, opts));
      const canonicalKey = canonicalBundleKey(entry.targetRelative);
      const existingRecord = bucket.state.entries[canonicalKey];
      // R6-F(R3-F18 residual) (review round 6): this used to check ONLY
      // `bundleId`, so a same-id bundle whose `sourceProject` OMITTED or
      // MISMATCHED the recorded value — but whose bytes happened to be
      // byte-identical to what's already on disk — still passed this guard
      // and had its record rewritten below, which silently erased (spread is
      // skipped when `plan.bundleSourceProject` is `undefined`) or relabelled
      // the recorded `sourceProject`. A later import with different bytes and
      // that same omitted/forged `sourceProject` then updated in place with
      // no conflict and no `--force`, laundering a takeover through this
      // "safe, unchanged bytes" branch — exactly the ownership check
      // `plan.ts:456-458` exists to enforce for `conflict`/`update`. Ownership
      // for a same-bundleId record is `bundleId` AND `sourceProject` together
      // (mirroring `ledgerOwnedByOther`), so a mismatch here leaves the
      // existing record completely untouched rather than reclaiming it.
      if (
        existingRecord === undefined ||
        existingRecord.bundleId !== plan.bundleId ||
        existingRecord.sourceProject !== plan.bundleSourceProject
      ) {
        continue; // not ours to claim — see comment above.
      }
      bucket.state.entries[canonicalKey] = {
        bundleId: plan.bundleId,
        sha256: entry.incomingSha256,
        kind: entry.kind,
        appliedAt: now().toISOString(),
        path: entry.targetRelative,
        ...(plan.bundleSourceProject !== undefined ? { sourceProject: plan.bundleSourceProject } : {}),
        contentDigest: plan.bundleContentDigest,
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
            await removeContained(item.root, item.rel).catch(() => undefined);
          } else {
            await writeContained(item.root, item.rel, item.previousBytes).catch(() => undefined);
          }
        } else if (item.kind === "gitignore") {
          await removeContained(item.root, item.rel).catch(() => undefined);
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
