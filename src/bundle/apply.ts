// Flow 313 (W4 portability), T6 — `keryx bundle import`'s Apply stage: write
// only `new` and forced-`conflict`/`update` entries, atomically (tmp+rename),
// with a TOCTOU re-check right before each write and a full rollback if any
// single write fails. Identical entries are recorded in the ledger too, so a
// later re-export/re-import recognizes them as Keryx-managed.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { ensurePrivateDirGitignore } from "../lib/private-dir";
import { userStorePaths } from "../lib/keryx-home";
import { readAppliedState, writeAppliedState, type AppliedState } from "./applied-state";
import { sha256Hex } from "./checksum";
import type { PlanEntry, BundlePlan } from "./plan";
import type { AuditBundlePlanResult } from "./audit";
import { BUNDLE_REFUSAL, type BundleRefusal } from "./types";

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

  // Private-dir `.gitignore` fail-closed rule for user-scope memory entries.
  const checkedGitignoreRoots = new Set<string>();
  for (const entry of toWrite) {
    if (entry.targetScope === "user" && entry.kind === "memory-entry") {
      const memoryRoot = userStorePaths(opts.env ?? process.env, opts.homeDir).memory;
      if (!checkedGitignoreRoots.has(memoryRoot)) {
        checkedGitignoreRoots.add(memoryRoot);
        const check = await ensurePrivateDirGitignore(memoryRoot);
        if (!check.ok) {
          return { written: [], unchanged: [], refusals: [{ reason: BUNDLE_REFUSAL.privateGitignoreConflict, message: check.message }] };
        }
      }
    }
  }

  // TOCTOU re-check: every target's current sha256 must still match what
  // planning observed, or the whole apply refuses before writing anything.
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

  const rollback: Array<{ absolutePath: string; previousBytes: Buffer | null }> = [];
  const written: string[] = [];

  try {
    for (const entry of toWrite) {
      let previousBytes: Buffer | null = null;
      try {
        previousBytes = await readFile(entry.targetPath);
      } catch {
        previousBytes = null;
      }
      rollback.push({ absolutePath: entry.targetPath, previousBytes });
      await atomicWrite(entry.targetPath, entry.bytes);
      written.push(entry.displayId);
    }
  } catch (err) {
    for (const item of rollback.reverse()) {
      try {
        if (item.previousBytes === null) {
          await unlink(item.absolutePath).catch(() => undefined);
        } else {
          await writeFile(item.absolutePath, item.previousBytes);
        }
      } catch {
        // best-effort rollback
      }
    }
    return {
      written: [],
      unchanged: [],
      refusals: [{ reason: BUNDLE_REFUSAL.unresolvedConflict, message: `apply failed and was rolled back: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  // Update the ledger(s) — every written path, plus every identical entry so
  // it is recognized as Keryx-managed on a future update.
  const byScope = new Map<string, { ledgerPath: string; state: AppliedState }>();
  async function ledgerFor(scope: string, ledgerPath: string): Promise<{ ledgerPath: string; state: AppliedState }> {
    const existing = byScope.get(scope);
    if (existing) return existing;
    const read = await readAppliedState(ledgerPath);
    const state: AppliedState = read.ok ? read.state : { schemaVersion: 1, entries: {} };
    const entry = { ledgerPath, state };
    byScope.set(scope, entry);
    return entry;
  }

  for (const entry of [...toWrite, ...identical]) {
    const bucket = await ledgerFor(entry.targetScope, resolveLedgerPathForEntry(entry, opts));
    bucket.state.entries[entry.targetRelative] = {
      bundleId: plan.bundleId,
      sha256: entry.incomingSha256,
      kind: entry.kind,
      appliedAt: now().toISOString(),
    };
  }

  for (const { ledgerPath, state } of byScope.values()) {
    await writeAppliedState(ledgerPath, state);
  }

  return { written, unchanged: identical.map((e) => e.displayId), refusals: [] };
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
