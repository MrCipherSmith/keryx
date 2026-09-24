// Flow 313 (W4 portability), T6 — `keryx bundle uninstall <bundleId>`: remove
// only the files the applied-state ledger records as written by that bundle
// AND still unmodified (current sha256 === the ledger's recorded sha256);
// a file a human has since edited is kept, with a warning, per the same
// never-clobber-a-hand-edit discipline apply itself follows.

import { readFile, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { appliedStatePath, readAppliedState, writeAppliedState } from "./applied-state";
import { sha256Hex } from "./checksum";
import { scopeRoot, type PathCtx } from "./paths";
import { BUNDLE_REFUSAL, type BundleRefusal, type BundleScope } from "./types";

export interface UninstallBundleOptions {
  bundleId: string;
  targetScope: BundleScope;
  projectRoot: string;
  dryRun?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
}

export interface UninstallKept {
  path: string;
  reason: "user-modified";
}

export interface UninstallBundleResult {
  ok: boolean;
  refusals: BundleRefusal[];
  removed: string[];
  kept: UninstallKept[];
  missing: string[];
}

// Directories a bundle's kind-shaped paths always sit under; uninstall never
// removes these themselves, only files and now-empty directories beneath them.
const PROTECTED_KIND_ROOTS = [
  "skills",
  "project-skills",
  "rules",
  "agents",
  "memory",
  "learning",
  path.join("data", "learning"),
];

async function removeNowEmptyParents(root: string, filePath: string): Promise<void> {
  let dir = path.dirname(filePath);
  const rootResolved = path.resolve(root);
  while (dir !== rootResolved && dir.startsWith(rootResolved)) {
    const relFromRoot = path.relative(rootResolved, dir);
    if (PROTECTED_KIND_ROOTS.includes(relFromRoot)) break;
    try {
      await rmdir(dir);
    } catch {
      break; // not empty, or cannot remove — stop walking up
    }
    dir = path.dirname(dir);
  }
}

export async function uninstallBundle(opts: UninstallBundleOptions): Promise<UninstallBundleResult> {
  const ctx: PathCtx = { projectRoot: opts.projectRoot, env: opts.env, homeDir: opts.homeDir };
  const root = scopeRoot(opts.targetScope, ctx);
  const ledgerPath = appliedStatePath(opts.targetScope, ctx);

  const ledgerRead = await readAppliedState(ledgerPath);
  if (!ledgerRead.ok) {
    return { ok: false, refusals: [{ reason: BUNDLE_REFUSAL.notABundle, message: ledgerRead.message }], removed: [], kept: [], missing: [] };
  }

  const removed: string[] = [];
  const kept: UninstallKept[] = [];
  const missing: string[] = [];
  const remainingEntries = { ...ledgerRead.state.entries };

  for (const [relPath, record] of Object.entries(ledgerRead.state.entries)) {
    if (record.bundleId !== opts.bundleId) continue;
    const absolute = path.join(root, ...relPath.split("/"));

    let currentBytes: Buffer | undefined;
    try {
      currentBytes = await readFile(absolute);
    } catch {
      currentBytes = undefined;
    }

    if (currentBytes === undefined) {
      missing.push(relPath);
      delete remainingEntries[relPath];
      continue;
    }

    if (sha256Hex(currentBytes) !== record.sha256) {
      kept.push({ path: relPath, reason: "user-modified" });
      continue;
    }

    if (!opts.dryRun) {
      await unlink(absolute);
      await removeNowEmptyParents(root, absolute);
    }
    removed.push(relPath);
    delete remainingEntries[relPath];
  }

  if (!opts.dryRun && (removed.length > 0 || missing.length > 0)) {
    await writeAppliedState(ledgerPath, { schemaVersion: 1, entries: remainingEntries });
  }

  return { ok: true, refusals: [], removed, kept, missing };
}
