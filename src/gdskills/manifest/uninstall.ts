// Flow 309 (W1), T6: `uninstallInstall` — remove only the paths recorded in
// install-state for a target (optionally scoped to one module), and only
// when the on-disk sha256 still matches the recorded one. A drifted file is
// refused without `--force`; with `--force` it is removed but its mismatch is
// reported first (recorded content is never stored, so the "diff" is a hash
// mismatch plus the current file's head bytes, not a textual diff).

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";
import { readSkillsInstallState, sha256OfFile, writeSkillsInstallState, type InstalledModuleRecord } from "./state";

const DIFF_HEAD_BYTES = 200;

export interface UninstallOptions {
  moduleId?: string | undefined;
  force?: boolean | undefined;
}

export interface UninstallRefusal {
  path: string;
  reason: string;
}

export interface UninstallDiffNote {
  path: string;
  message: string;
}

export interface UninstallResult {
  ok: boolean;
  removed: string[];
  refused: UninstallRefusal[];
  diffs: UninstallDiffNote[];
}

async function headSnippet(absPath: string): Promise<string> {
  try {
    const buf = await readFile(absPath);
    const head = buf.subarray(0, DIFF_HEAD_BYTES).toString("utf8").replace(/\s+/g, " ").trim();
    return buf.length > DIFF_HEAD_BYTES ? `${head}…` : head;
  } catch {
    return "(unreadable)";
  }
}

export async function uninstallInstall(
  repoRoot: string,
  target: string,
  options: UninstallOptions = {},
): Promise<UninstallResult> {
  const state = await readSkillsInstallState(repoRoot, target);
  if (state === undefined) {
    return { ok: true, removed: [], refused: [], diffs: [] };
  }

  const removed: string[] = [];
  const refused: UninstallRefusal[] = [];
  const diffs: UninstallDiffNote[] = [];
  // Only records this call actually touches go into `batch` — `writeSkillsInstallState`
  // merges by moduleId, leaving every untouched record exactly as it was. A
  // touched record with an empty `writtenPaths` tells it to drop that record.
  const batch: InstalledModuleRecord[] = [];

  for (const record of state.installedModules) {
    if (options.moduleId !== undefined && record.moduleId !== options.moduleId) {
      continue;
    }

    const keptPaths: string[] = [];
    for (const filePath of record.writtenPaths) {
      const abs = path.join(repoRoot, filePath);
      if (!(await pathExists(abs))) {
        // Already gone — nothing to remove, nothing to keep recorded.
        continue;
      }
      const recordedHash = record.sha256[filePath];
      const currentHash = await sha256OfFile(repoRoot, filePath);
      const matches = recordedHash !== undefined && currentHash === recordedHash;

      if (!matches) {
        const reason = `drifted: recorded sha256 ${recordedHash ?? "(none)"}, on-disk ${currentHash ?? "(unreadable)"}`;
        if (!options.force) {
          refused.push({ path: filePath, reason: `${reason} — refused without --force` });
          keptPaths.push(filePath);
          continue;
        }
        diffs.push({ path: filePath, message: `${reason}; removing with --force. Current head: ${await headSnippet(abs)}` });
      }

      await rm(abs, { force: true });
      removed.push(filePath);
    }

    const keptSet = new Set(keptPaths);
    batch.push({
      ...record,
      writtenPaths: keptPaths,
      sha256: Object.fromEntries(Object.entries(record.sha256).filter(([p]) => keptSet.has(p))),
    });
  }

  await writeSkillsInstallState(repoRoot, target, batch, state.profile);

  return { ok: refused.length === 0, removed, refused, diffs };
}
