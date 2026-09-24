// Flow 313 (W4 portability), T6 — `keryx bundle uninstall <bundleId>`: remove
// only the files the applied-state ledger records as written by that bundle
// AND still unmodified (current sha256 === the ledger's recorded sha256);
// a file a human has since edited is kept, with a warning, per the same
// never-clobber-a-hand-edit discipline apply itself follows.

import path from "node:path";

import { removeContained, rmdirIfEmptyContained } from "../lib/contained-write";
import { APPLIED_STATE_SCHEMA_VERSION, appliedStatePath, readAppliedState, writeAppliedState } from "./applied-state";
import { sha256Hex } from "./checksum";
import { canonicalBundleKey, normalizeBundlePath, readTargetFile, refuseSymlinkChain, scopeRoot, validateKindPath, type PathCtx } from "./paths";
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
const PROTECTED_KIND_ROOTS = new Set(["skills", "project-skills", "rules", "agents", "memory", "learning", "data/learning"]);

/** True when `candidate` is `root` itself or sits beneath it — segment-aware, not a string prefix check (a sibling directory that merely starts with the same characters must not pass). */
function isContained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Prune now-empty ancestor directories under `root`, deepest first, via the
 * shared contained-write primitive's `rmdirIfEmptyContained` (R3-F24). Stops
 * at the first non-empty directory (a no-op `rmdirIfEmptyContained` returns
 * `false`) or at a protected kind root.
 */
async function removeNowEmptyParents(root: string, relFilePath: string): Promise<void> {
  let relDir = path.posix.dirname(relFilePath);
  while (relDir !== "." && relDir !== "/" && relDir !== "") {
    if (PROTECTED_KIND_ROOTS.has(relDir)) break;
    const removed = await rmdirIfEmptyContained(root, relDir).catch(() => false);
    if (!removed) break; // not empty, or cannot remove — stop walking up
    relDir = path.posix.dirname(relDir);
  }
}

interface ValidatedRecord {
  relPath: string;
  normalizedRelPath: string;
  absolute: string;
  action: "remove" | "kept" | "missing";
  currentBytes?: Buffer;
}

export async function uninstallBundle(opts: UninstallBundleOptions): Promise<UninstallBundleResult> {
  const ctx: PathCtx = { projectRoot: opts.projectRoot, env: opts.env, homeDir: opts.homeDir };
  const root = scopeRoot(opts.targetScope, ctx);
  const rootResolved = path.resolve(root);
  const ledgerPath = appliedStatePath(opts.targetScope, ctx);

  const ledgerRead = await readAppliedState(ledgerPath);
  if (!ledgerRead.ok) {
    return { ok: false, refusals: [{ reason: BUNDLE_REFUSAL.corruptLedger, message: ledgerRead.message }], removed: [], kept: [], missing: [] };
  }

  // The ledger is keyed by the CANONICAL form of the path (choke point b,
  // R3-F2) as of schemaVersion 2, so two records that fold to the same
  // on-disk file can no longer coexist under different keys — this is
  // structural now, not merely checked. A hand-tampered or not-yet-migrated
  // ledger could still carry a literal duplicate key (JSON does not forbid
  // it structurally the same way); kept as defense-in-depth.
  const foldedKeys = new Map<string, string>();
  for (const canonicalKey of Object.keys(ledgerRead.state.entries)) {
    const prior = foldedKeys.get(canonicalKey);
    if (prior !== undefined) {
      return {
        ok: false,
        refusals: [{ reason: BUNDLE_REFUSAL.corruptLedger, path: canonicalKey, message: `applied-state ledger has a duplicate canonical key "${canonicalKey}"` }],
        removed: [],
        kept: [],
        missing: [],
      };
    }
    foldedKeys.set(canonicalKey, canonicalKey);
  }

  // R3-F17: PHASE 1 — validate every record for this bundleId first, without
  // touching disk. A refusal on any one record (a corrupt/escaping ledger
  // key, an unreadable target) aborts the WHOLE uninstall before anything is
  // deleted, so a later record's refusal can never leave `removed: []`
  // disagreeing with files an earlier record already had unlinked.
  const toProcess: Array<{ canonicalKey: string; record: (typeof ledgerRead.state.entries)[string] }> = [];
  for (const [canonicalKey, record] of Object.entries(ledgerRead.state.entries)) {
    if (record.bundleId !== opts.bundleId) continue;
    toProcess.push({ canonicalKey, record });
  }

  const validated: ValidatedRecord[] = [];
  for (const { canonicalKey, record } of toProcess) {
    const relPath = record.path;

    // R1-F9: the ledger is untrusted input from this point of view — a
    // planted or hand-edited ledger could carry a `../../victim.txt` key, or
    // one under a symlinked directory. Every key is re-run through the same
    // normalize + containment + symlink-chain checks a write goes through
    // before it is ever read or unlinked; a corrupt key is refused rather
    // than silently skipped, so a tampered ledger surfaces instead of
    // quietly losing entries.
    const normalized = normalizeBundlePath(relPath);
    if (!normalized.ok) {
      return { ok: false, refusals: [{ reason: BUNDLE_REFUSAL.corruptLedger, path: relPath, message: `applied-state ledger record "${relPath}" is not a valid bundle path: ${normalized.refusal.message}` }], removed: [], kept: [], missing: [] };
    }
    if (canonicalBundleKey(normalized.path) !== canonicalKey) {
      return { ok: false, refusals: [{ reason: BUNDLE_REFUSAL.corruptLedger, path: relPath, message: `applied-state ledger key "${canonicalKey}" does not match its own record's path "${relPath}"` }], removed: [], kept: [], missing: [] };
    }
    // R1-F9 (still open in round 2): normalize/containment/symlink checks
    // alone accept ANY valid bundle path, not only one shaped like the
    // ledger record's own RECORDED kind — a planted record
    // `{"kind":"rule", ...}` under the key `.metaproject/index.md` passed
    // every check above and reached `unlink`, deleting a file uninstall was
    // never meant to be able to touch. Re-running `validateKindPath`
    // rejects any key that is not shaped like its own recorded kind.
    const kindCheck = validateKindPath(record.kind, opts.targetScope, normalized.path);
    if (!kindCheck.ok) {
      return { ok: false, refusals: [{ reason: BUNDLE_REFUSAL.corruptLedger, path: relPath, message: `applied-state ledger record "${relPath}" does not match its recorded kind "${record.kind}": ${kindCheck.refusal.message}` }], removed: [], kept: [], missing: [] };
    }
    const absolute = path.resolve(rootResolved, normalized.path);
    if (!isContained(rootResolved, absolute)) {
      return { ok: false, refusals: [{ reason: BUNDLE_REFUSAL.corruptLedger, path: relPath, message: `applied-state ledger record "${relPath}" resolves outside the scope root` }], removed: [], kept: [], missing: [] };
    }
    const symlinkCheck = await refuseSymlinkChain(rootResolved, normalized.path);
    if (!symlinkCheck.ok) {
      return { ok: false, refusals: [symlinkCheck.refusal], removed: [], kept: [], missing: [] };
    }

    // R2-F20: an unreadable-but-present target must refuse, not be treated
    // as "missing" — dropping it from the ledger here would silently stop
    // tracking a file that still exists (just not readable right now),
    // defeating any future uninstall of it.
    const currentFile = await readTargetFile(absolute);
    if (!currentFile.ok) {
      return { ok: false, refusals: [{ ...currentFile.refusal, path: relPath }], removed: [], kept: [], missing: [] };
    }
    const currentBytes = currentFile.bytes;

    if (currentBytes === undefined) {
      validated.push({ relPath, normalizedRelPath: normalized.path, absolute, action: "missing" });
      continue;
    }
    if (sha256Hex(currentBytes) !== record.sha256) {
      validated.push({ relPath, normalizedRelPath: normalized.path, absolute, action: "kept" });
      continue;
    }
    validated.push({ relPath, normalizedRelPath: normalized.path, absolute, action: "remove" });
  }

  // R3-F17: PHASE 2 — every record validated with no refusal; now actually
  // unlink (or dry-run report) and update the ledger once, in a single
  // batch, so the reported `removed`/`kept`/`missing` always matches what
  // was (or, dry-run, would be) done to disk.
  const removed: string[] = [];
  const kept: UninstallKept[] = [];
  const missing: string[] = [];
  const remainingEntries = { ...ledgerRead.state.entries };

  for (const v of validated) {
    const canonicalKey = canonicalBundleKey(v.normalizedRelPath);
    if (v.action === "missing") {
      missing.push(v.relPath);
      delete remainingEntries[canonicalKey];
      continue;
    }
    if (v.action === "kept") {
      kept.push({ path: v.relPath, reason: "user-modified" });
      continue;
    }
    if (!opts.dryRun) {
      await removeContained(root, v.normalizedRelPath);
      await removeNowEmptyParents(root, v.normalizedRelPath);
    }
    removed.push(v.relPath);
    delete remainingEntries[canonicalKey];
  }

  if (!opts.dryRun && (removed.length > 0 || missing.length > 0)) {
    await writeAppliedState(ledgerPath, { schemaVersion: APPLIED_STATE_SCHEMA_VERSION, entries: remainingEntries });
  }

  return { ok: true, refusals: [], removed, kept, missing };
}
