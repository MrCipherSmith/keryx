// Flow 313 (W4 portability), T6 — `keryx bundle import`'s Plan stage: verify
// checksums (fail closed on any mismatch, W4-AC3), then diff every entry
// against the target scope's disk state and the applied-state ledger to
// bucket it new / identical / update / conflict, applying the
// learned-pattern scope rule (W4-AC11) and the private-dir `.gitignore`
// fail-closed rule (W4-AC8) along the way.

import { readFile } from "node:fs/promises";

import { checkPrivateDirGitignore } from "../lib/private-dir";
import { userStorePaths } from "../lib/keryx-home";
import { readAppliedState, appliedStatePath } from "./applied-state";
import { sha256Hex } from "./checksum";
import type { BundleSource } from "./archive";
import { targetFor, type PathCtx } from "./paths";
import { verifyBundle } from "./verify";
import { BUNDLE_REFUSAL, type BundleContentKind, type BundleManifest, type BundleRefusal, type BundleScope } from "./types";

export type PlanBucket = "new" | "identical" | "update" | "conflict";
export type PlanConflictReason = "user-modified" | "unmanaged-differs";

export interface PlanEntry {
  path: string;
  kind: BundleContentKind;
  entryScope: BundleScope;
  targetScope: BundleScope;
  targetRelative: string;
  displayId: string;
  targetPath: string;
  bucket: PlanBucket;
  conflictReason?: PlanConflictReason;
  forced: boolean;
  incomingSha256: string;
  currentSha256?: string;
  ledgerSha256?: string;
  bytes: Buffer;
}

export interface BundlePlan {
  ok: boolean;
  bundleId: string;
  refusals: BundleRefusal[];
  entries: PlanEntry[];
}

export interface PlanBundleImportOptions {
  source: BundleSource;
  manifest: BundleManifest;
  projectRoot: string;
  targetScope?: BundleScope | undefined;
  force?: string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
}

// --- learned-pattern candidate rewrite -------------------------------------

interface LearnedPatternTtl {
  expiresAt: string;
}

/** Deterministic default TTL for a rewritten candidate: 30 days from now. */
function defaultLearnedPatternTtl(now: Date): LearnedPatternTtl {
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { expiresAt: expires.toISOString() };
}

/**
 * Rewrite a `scope: user` learned-pattern record to `status: "candidate"`,
 * adding a deterministic `ttl` only if it is absent. Stable JSON, 2-space
 * indent + trailing newline — these bytes are what `incomingSha256` covers.
 */
function rewriteLearnedPatternCandidate(record: Record<string, unknown>, now: Date): Buffer {
  const rewritten: Record<string, unknown> = { ...record, status: "candidate", supersededBy: null };
  if (rewritten.ttl === undefined || rewritten.ttl === null) {
    rewritten.ttl = defaultLearnedPatternTtl(now);
  }
  return Buffer.from(`${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
}

async function currentFileSha(absolutePath: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(absolutePath);
    return sha256Hex(bytes);
  } catch {
    return undefined;
  }
}

export async function planBundleImport(opts: PlanBundleImportOptions): Promise<BundlePlan> {
  const ctx: PathCtx = { projectRoot: opts.projectRoot, env: opts.env, homeDir: opts.homeDir };
  const now = new Date();

  // Step 1: checksums first. Any failure -> ok:false, no further work.
  const verified = verifyBundle(opts.source, opts.manifest);
  if (!verified.ok) {
    const refusals: BundleRefusal[] = [];
    for (const entry of verified.entries) {
      if (entry.status !== "ok") {
        refusals.push({
          reason: entry.status === "checksum-mismatch" ? BUNDLE_REFUSAL.checksumMismatch : entry.status === "size-mismatch" ? BUNDLE_REFUSAL.sizeMismatch : BUNDLE_REFUSAL.missingEntry,
          path: entry.path,
          message: `${entry.path}: ${entry.status}`,
        });
      }
    }
    for (const p of verified.unlisted) {
      refusals.push({ reason: BUNDLE_REFUSAL.unlistedFile, path: p, message: `${p} is present in the bundle but not listed in the manifest` });
    }
    return { ok: false, bundleId: opts.manifest.bundleId, refusals, entries: [] };
  }

  const refusals: BundleRefusal[] = [];
  const entries: PlanEntry[] = [];
  const gitignoreChecked = new Set<string>();

  for (const contentEntry of opts.manifest.contents) {
    const bytes = opts.source.files.get(contentEntry.path) as Buffer;
    const targetScope = opts.targetScope ?? contentEntry.scope;

    // Learned-pattern scope rule (W4-AC11): never retarget; scope is immutable.
    if (contentEntry.kind === "learned-pattern") {
      if (contentEntry.scope === "project" && targetScope !== "project" && targetScope !== "team") {
        refusals.push({
          reason: BUNDLE_REFUSAL.learnedPatternScope,
          path: contentEntry.path,
          message: `cannot import a project-scope learned-pattern at ${targetScope} scope; scope is immutable across import`,
        });
        continue;
      }
      if (contentEntry.scope === "user" && targetScope !== "user") {
        refusals.push({
          reason: BUNDLE_REFUSAL.learnedPatternScope,
          path: contentEntry.path,
          message: `cannot import a user-scope learned-pattern at ${targetScope} scope; scope is immutable across import`,
        });
        continue;
      }
    }
    // Retargeting for non-learned-pattern kinds (contentEntry.scope !==
    // targetScope) is allowed only when the same relative path is also valid
    // at the target scope; `targetFor` below enforces that
    // (path-not-valid-for-scope / kind-path-mismatch).

    let effectiveBytes = bytes;

    if (contentEntry.kind === "learned-pattern") {
      let record: unknown;
      try {
        record = JSON.parse(bytes.toString("utf8"));
      } catch {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: contentEntry.path, message: `${contentEntry.path} is not valid JSON` });
        continue;
      }
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: contentEntry.path, message: `${contentEntry.path} is not a JSON object` });
        continue;
      }
      const recordObj = record as Record<string, unknown>;
      if (recordObj.scope !== contentEntry.scope) {
        refusals.push({
          reason: BUNDLE_REFUSAL.learnedPatternScope,
          path: contentEntry.path,
          message: `${contentEntry.path}: record scope "${String(recordObj.scope)}" does not match manifest entry scope "${contentEntry.scope}"`,
        });
        continue;
      }
      if (contentEntry.scope === "user") {
        effectiveBytes = rewriteLearnedPatternCandidate(recordObj, now);
      }
    }

    const target = await targetFor(contentEntry, targetScope, ctx);
    if (!target.ok) {
      refusals.push(target.refusal);
      continue;
    }

    // Private-dir `.gitignore` fail-closed rule for user-scope memory entries.
    if (targetScope === "user" && contentEntry.kind === "memory-entry") {
      const memoryRoot = userStorePaths(opts.env ?? process.env, opts.homeDir).memory;
      if (!gitignoreChecked.has(memoryRoot)) {
        gitignoreChecked.add(memoryRoot);
        const check = await checkPrivateDirGitignore(memoryRoot);
        if (!check.ok) {
          refusals.push({ reason: BUNDLE_REFUSAL.privateGitignoreConflict, path: contentEntry.path, message: check.message });
          continue;
        }
      }
    }

    const targetRelative = contentEntry.path;
    const displayId = `${targetScope}:${targetRelative}`;
    const incomingSha256 = sha256Hex(effectiveBytes);
    const currentSha256 = await currentFileSha(target.absolutePath);

    const ledgerPath = appliedStatePath(targetScope, ctx);
    const ledgerState = await readAppliedState(ledgerPath);
    if (!ledgerState.ok) {
      refusals.push({ reason: BUNDLE_REFUSAL.notABundle, path: contentEntry.path, message: ledgerState.message });
      continue;
    }
    const ledgerRecord = ledgerState.state.entries[targetRelative];
    const ledgerSha256 = ledgerRecord?.sha256;

    let bucket: PlanBucket;
    let conflictReason: PlanConflictReason | undefined;

    if (currentSha256 === undefined) {
      bucket = "new";
    } else if (currentSha256 === incomingSha256) {
      bucket = "identical";
    } else if (ledgerSha256 !== undefined && currentSha256 === ledgerSha256) {
      bucket = "update";
    } else if (ledgerSha256 !== undefined && currentSha256 !== ledgerSha256) {
      bucket = "conflict";
      conflictReason = "user-modified";
    } else {
      bucket = "conflict";
      conflictReason = "unmanaged-differs";
    }

    const forced = (opts.force ?? []).includes(targetRelative) || (opts.force ?? []).includes(displayId);
    if (bucket === "conflict" && !forced) {
      refusals.push({ reason: BUNDLE_REFUSAL.unresolvedConflict, path: contentEntry.path, message: `${displayId} conflicts and was not passed to --force` });
    }

    entries.push({
      path: contentEntry.path,
      kind: contentEntry.kind,
      entryScope: contentEntry.scope,
      targetScope,
      targetRelative,
      displayId,
      targetPath: target.absolutePath,
      bucket,
      ...(conflictReason !== undefined ? { conflictReason } : {}),
      forced,
      incomingSha256,
      ...(currentSha256 !== undefined ? { currentSha256 } : {}),
      ...(ledgerSha256 !== undefined ? { ledgerSha256 } : {}),
      bytes: effectiveBytes,
    });
  }

  const forceValues = new Set(opts.force ?? []);
  const matchedForce = new Set<string>();
  for (const entry of entries) {
    if (forceValues.has(entry.targetRelative)) matchedForce.add(entry.targetRelative);
    if (forceValues.has(entry.displayId)) matchedForce.add(entry.displayId);
  }
  for (const forceValue of forceValues) {
    if (!matchedForce.has(forceValue)) {
      refusals.push({ reason: BUNDLE_REFUSAL.unknownForcePath, path: forceValue, message: `--force ${forceValue} does not match any planned entry` });
    }
  }

  return { ok: refusals.length === 0, bundleId: opts.manifest.bundleId, refusals, entries };
}
