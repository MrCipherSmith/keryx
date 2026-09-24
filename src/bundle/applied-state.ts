// Flow 313 (W4 portability), T6 — the per-scope "last sha256 Keryx wrote
// here" ledger apply/uninstall consult to tell an ordinary update apart from
// a human-modified file (W4-AC4). Atomic writes (tmp + rename); a corrupt
// ledger fails closed rather than being treated as empty.
//
// Flow 313 re-plan, lane C2, choke point b: the ledger's own KEY is the
// canonical form (`canonicalBundleKey`, paths.ts) of the bundle-relative
// path it records, not the path's original casing — two entries from
// different bundles that differ only by case (`rules/X.md` vs `rules/x.md`)
// are the SAME on-disk file on a case-insensitive filesystem, and must
// collide on the SAME ledger key rather than silently coexisting as two
// records pointing at one file (R3-F2). The original-case path is kept in
// the record's own `path` field for display/round-trip. schemaVersion 2;
// `readAppliedState` migrates a v1 ledger (keyed by raw path, no `path`
// field) in memory, refusing closed if migration would collide two v1 keys
// onto the same canonical form.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeContained } from "../lib/contained-write";
import { canonicalBundleKey, scopeRoot, type PathCtx } from "./paths";
import type { BundleContentKind, BundleScope } from "./types";

export const APPLIED_STATE_SCHEMA_VERSION = 2;

export interface AppliedStateEntry {
  bundleId: string;
  sha256: string;
  kind: BundleContentKind;
  appliedAt: string;
  /** Original-case bundle-relative path this record was written for; the ledger's own key is `canonicalBundleKey(path)` (R3-F2). */
  path: string;
  /** `manifest.provenance.sourceProject` at apply time, when the exporting bundle declared one (R3-F18). */
  sourceProject?: string;
  /** A digest of the exporting bundle's own sorted content list at apply time — recorded for ownership audit/troubleshooting, not itself part of the conflict decision (R3-F18). */
  contentDigest?: string;
}

export interface AppliedState {
  schemaVersion: typeof APPLIED_STATE_SCHEMA_VERSION;
  /** Keyed by `canonicalBundleKey(entry.path)`. */
  entries: Record<string, AppliedStateEntry>;
}

export type ReadAppliedStateResult =
  | { ok: true; state: AppliedState }
  | { ok: false; reason: "corrupt-ledger"; message: string };

function emptyState(): AppliedState {
  return { schemaVersion: APPLIED_STATE_SCHEMA_VERSION, entries: {} };
}

/** Ledger path for a scope: project/team share `.metaproject/data/bundles/applied-state.json`; user uses `userStorePaths().appliedState`. */
export function appliedStatePath(scope: BundleScope, ctx: PathCtx): string {
  if (scope === "user") {
    return path.join(scopeRoot("user", ctx), "bundles", "applied-state.json");
  }
  return path.join(scopeRoot(scope, ctx), "data", "bundles", "applied-state.json");
}

function isPlainEntryShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.bundleId === "string" &&
    v.bundleId.length > 0 &&
    typeof v.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(v.sha256) &&
    typeof v.kind === "string" &&
    typeof v.appliedAt === "string"
  );
}

/** R1-F9: validate every record's shape, not just the container — a ledger with a malformed record (missing bundleId/sha256, or a non-hex sha) is corrupt, not merely "has records", and must fail closed the same way a structurally invalid file does. */
function isValidV2Entry(value: unknown): value is AppliedStateEntry {
  if (!isPlainEntryShape(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === "string" && v.path.length > 0 && (v.sourceProject === undefined || typeof v.sourceProject === "string") && (v.contentDigest === undefined || typeof v.contentDigest === "string");
}

function isValidV2State(value: unknown): value is AppliedState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== APPLIED_STATE_SCHEMA_VERSION) return false;
  if (typeof v.entries !== "object" || v.entries === null || Array.isArray(v.entries)) return false;
  return Object.values(v.entries as Record<string, unknown>).every(isValidV2Entry);
}

/** v1 shape: `schemaVersion: 1`, entries keyed by the RAW (non-canonical) bundle-relative path, no `path` field on the record itself. */
function isValidV1State(value: unknown): value is { schemaVersion: 1; entries: Record<string, Record<string, unknown>> } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return false;
  if (typeof v.entries !== "object" || v.entries === null || Array.isArray(v.entries)) return false;
  return Object.values(v.entries as Record<string, unknown>).every(isPlainEntryShape);
}

/**
 * Migrate a v1 ledger (keyed by raw path) to the v2 in-memory shape (keyed
 * by `canonicalBundleKey`). Refuses closed, rather than picking a winner,
 * when two v1 keys fold to the same canonical key — that can only happen
 * already-corrupt (two ledger records the fold-collision check in
 * uninstall.ts would itself have refused under the old scheme) or hand-
 * tampered input, and silently dropping one record would lose track of a
 * file Keryx wrote.
 */
function migrateV1(v1: { entries: Record<string, Record<string, unknown>> }): ReadAppliedStateResult {
  const entries: Record<string, AppliedStateEntry> = {};
  for (const [rawPath, record] of Object.entries(v1.entries)) {
    const canonical = canonicalBundleKey(rawPath);
    const prior = entries[canonical];
    if (prior !== undefined && prior.path !== rawPath) {
      return {
        ok: false,
        reason: "corrupt-ledger",
        message: `applied-state ledger v1->v2 migration: keys "${prior.path}" and "${rawPath}" collide on canonical key "${canonical}"`,
      };
    }
    entries[canonical] = {
      bundleId: record.bundleId as string,
      sha256: record.sha256 as string,
      kind: record.kind as BundleContentKind,
      appliedAt: record.appliedAt as string,
      path: rawPath,
    };
  }
  return { ok: true, state: { schemaVersion: APPLIED_STATE_SCHEMA_VERSION, entries } };
}

export async function readAppliedState(ledgerPath: string): Promise<ReadAppliedStateResult> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, state: emptyState() };
    }
    return { ok: false, reason: "corrupt-ledger", message: `cannot read applied-state ledger at ${ledgerPath}: ${String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "corrupt-ledger", message: `applied-state ledger at ${ledgerPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (isValidV2State(parsed)) {
    return { ok: true, state: parsed };
  }
  if (isValidV1State(parsed)) {
    return migrateV1(parsed);
  }
  return { ok: false, reason: "corrupt-ledger", message: `applied-state ledger at ${ledgerPath} has an unrecognized shape` };
}

/**
 * `ledgerPath` is always `<root>/data/bundles/applied-state.json` (project/
 * team) or `<userStoreRoot>/bundles/applied-state.json` (user) —
 * `writeContained`'s `root` is the ledger's own parent directory, so the
 * "contained write" check is over an already-fixed, non-bundle-controlled
 * location; the containment guard still matters because a symlink planted
 * at that fixed location (or an ancestor of it) must not be followed.
 */
export async function writeAppliedState(ledgerPath: string, state: AppliedState): Promise<void> {
  const dir = path.dirname(ledgerPath);
  const rel = path.basename(ledgerPath);
  const sortedEntries: Record<string, AppliedStateEntry> = {};
  for (const key of Object.keys(state.entries).sort()) {
    sortedEntries[key] = state.entries[key] as AppliedStateEntry;
  }
  const payload = `${JSON.stringify({ schemaVersion: APPLIED_STATE_SCHEMA_VERSION, entries: sortedEntries }, null, 2)}\n`;
  await writeContained(dir, rel, payload);
}
