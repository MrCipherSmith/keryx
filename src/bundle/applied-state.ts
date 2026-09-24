// Flow 313 (W4 portability), T6 — the per-scope "last sha256 Keryx wrote
// here" ledger apply/uninstall consult to tell an ordinary update apart from
// a human-modified file (W4-AC4). Atomic writes (tmp + rename); a corrupt
// ledger fails closed rather than being treated as empty.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { scopeRoot, type PathCtx } from "./paths";
import type { BundleContentKind, BundleScope } from "./types";

export interface AppliedStateEntry {
  bundleId: string;
  sha256: string;
  kind: BundleContentKind;
  appliedAt: string;
}

export interface AppliedState {
  schemaVersion: 1;
  entries: Record<string, AppliedStateEntry>;
}

export type ReadAppliedStateResult =
  | { ok: true; state: AppliedState }
  | { ok: false; reason: "corrupt-ledger"; message: string };

function emptyState(): AppliedState {
  return { schemaVersion: 1, entries: {} };
}

/** Ledger path for a scope: project/team share `.metaproject/data/bundles/applied-state.json`; user uses `userStorePaths().appliedState`. */
export function appliedStatePath(scope: BundleScope, ctx: PathCtx): string {
  if (scope === "user") {
    return path.join(scopeRoot("user", ctx), "bundles", "applied-state.json");
  }
  return path.join(scopeRoot(scope, ctx), "data", "bundles", "applied-state.json");
}

function isValidEntry(value: unknown): value is AppliedStateEntry {
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
function isValidState(value: unknown): value is AppliedState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return false;
  if (typeof v.entries !== "object" || v.entries === null || Array.isArray(v.entries)) return false;
  return Object.values(v.entries as Record<string, unknown>).every(isValidEntry);
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
  if (!isValidState(parsed)) {
    return { ok: false, reason: "corrupt-ledger", message: `applied-state ledger at ${ledgerPath} has an unrecognized shape` };
  }
  return { ok: true, state: parsed };
}

export async function writeAppliedState(ledgerPath: string, state: AppliedState): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const sortedEntries: Record<string, AppliedStateEntry> = {};
  for (const key of Object.keys(state.entries).sort()) {
    sortedEntries[key] = state.entries[key] as AppliedStateEntry;
  }
  const payload = `${JSON.stringify({ schemaVersion: 1, entries: sortedEntries }, null, 2)}\n`;
  const tmpPath = path.join(path.dirname(ledgerPath), `.applied-state.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmpPath, payload, "utf8");
  try {
    await rename(tmpPath, ledgerPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
