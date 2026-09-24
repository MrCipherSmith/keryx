// Flow 309 (W1), T6: `applyInstall` — write the files an ok `InstallPlan`
// describes, then record install-state. Refuses to overwrite a file that
// already exists on disk and is not recorded in the current install-state
// (or whose on-disk hash no longer matches the recorded one) unless
// `options.force` is set — the drift-safety rule `doctor`/`uninstall` also
// enforce.

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";
import type { InstallPlan } from "./plan";
import { readSkillsInstallState, sha256OfFile, writeSkillsInstallState, type InstalledModuleRecord } from "./state";

export interface ApplyOptions {
  force?: boolean;
  /**
   * Root that `file.source` (repo-relative bundled paths, e.g.
   * `src/gdskills/bundled/rules/core/git-rules.mdc`) resolves against.
   * Defaults to `destRoot` — correct for tests and fixtures that build a
   * fake bundled tree alongside the destination, but WRONG for a real
   * install: source content ships inside the keryx package
   * (`defaultBundledSourceRoot()` in `./manifest`), not inside the target
   * project. CLI callers installing into a real project must pass it.
   */
  sourceRoot?: string;
}

export interface ApplySkippedFile {
  path: string;
  reason: string;
}

export interface ApplyResult {
  ok: boolean;
  written: string[];
  skipped: ApplySkippedFile[];
  errors: string[];
}

export async function applyInstall(
  plan: InstallPlan,
  destRoot: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  if (!plan.ok) {
    return { ok: false, written: [], skipped: [], errors: ["cannot apply a plan with errors — see plan.errors"] };
  }
  const sourceRoot = options.sourceRoot ?? destRoot;

  const existing = await readSkillsInstallState(destRoot, plan.target);
  const recordedHashes = new Map<string, string>();
  for (const record of existing?.installedModules ?? []) {
    for (const [filePath, hash] of Object.entries(record.sha256)) {
      recordedHashes.set(filePath, hash);
    }
  }

  const written: string[] = [];
  const skipped: ApplySkippedFile[] = [];
  const moduleRecords: InstalledModuleRecord[] = [];

  for (const module of plan.modules) {
    const writtenPaths: string[] = [];
    const sha256: Record<string, string> = {};

    for (const file of module.files) {
      const destinationAbs = path.join(destRoot, file.destination);
      const alreadyExists = await pathExists(destinationAbs);
      if (alreadyExists && !options.force) {
        const recordedHash = recordedHashes.get(file.destination);
        const currentHash = await sha256OfFile(destRoot, file.destination);
        if (recordedHash === undefined) {
          skipped.push({
            path: file.destination,
            reason: "a file already exists at this destination and is not recorded in install-state",
          });
          continue;
        }
        if (currentHash !== recordedHash) {
          skipped.push({
            path: file.destination,
            reason: `existing file content differs from the recorded install-state hash (drift) — recorded ${recordedHash}, on-disk ${currentHash ?? "(unreadable)"}`,
          });
          continue;
        }
      }

      await mkdir(path.dirname(destinationAbs), { recursive: true });
      await copyFile(path.join(sourceRoot, file.source), destinationAbs);
      written.push(file.destination);
      writtenPaths.push(file.destination);
      const hash = await sha256OfFile(destRoot, file.destination);
      if (hash !== undefined) sha256[file.destination] = hash;
    }

    if (writtenPaths.length > 0) {
      moduleRecords.push({
        moduleId: module.id,
        writtenPaths,
        sha256,
        managedSentinel: true,
        installedAt: new Date().toISOString(),
      });
    }
  }

  await writeSkillsInstallState(destRoot, plan.target, moduleRecords, plan.profile);

  return { ok: skipped.length === 0, written, skipped, errors: [] };
}
