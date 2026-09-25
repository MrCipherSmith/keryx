// Flow 309 (W1), T6: `applyInstall` — write the files an ok `InstallPlan`
// describes, then record install-state. Refuses to overwrite a file that
// already exists on disk and is not recorded in the current install-state
// (or whose on-disk hash no longer matches the recorded one) unless
// `options.force` is set — the drift-safety rule `doctor`/`uninstall` also
// enforce.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";
import { writeContained } from "../../lib/contained-write";
import { destinationRootsForTarget, type InstallPlan } from "./plan";
import {
  NotARegularFileError,
  readSkillsInstallState,
  resolveContainedPath,
  skillsInstallStateIsUnreadable,
  sha256OfFile,
  writeSkillsInstallState,
  type InstalledModuleRecord,
} from "./state";

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

  // F2: a corrupt/schema-invalid prior install-state file must not be
  // silently treated as "nothing recorded" — that would make apply believe
  // every existing on-disk file is unrecorded (safe-looking skip) even
  // though the true prior state, if it could be read, might say otherwise.
  if (await skillsInstallStateIsUnreadable(destRoot, plan.target)) {
    return {
      ok: false,
      written: [],
      skipped: [],
      errors: [
        `install-state for target "${plan.target}" exists but is not valid install-state JSON (corrupt or schema-invalid) — refusing to apply until it is repaired`,
      ],
    };
  }

  const existing = await readSkillsInstallState(destRoot, plan.target);
  const destinationRoots = destinationRootsForTarget(plan.target);

  // F2 (class scope): a prior-state record naming a path outside the
  // project root/destination roots makes the WHOLE state untrustworthy —
  // this call must not build `recordedHashes` from it (a poisoned "recorded
  // hash" for some unrelated path could make apply treat an unrecorded file
  // as if it were already Keryx's, skipping the "not recorded" refusal).
  for (const record of existing?.installedModules ?? []) {
    for (const filePath of record.writtenPaths) {
      const result = await resolveContainedPath(destRoot, filePath, destinationRoots);
      if (!result.ok) {
        return {
          ok: false,
          written: [],
          skipped: [],
          errors: [
            `install-state for target "${plan.target}" module "${record.moduleId}" records an unsafe path ` +
              `"${filePath}" (${result.reason}) — refusing to apply until it is repaired`,
          ],
        };
      }
    }
  }

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
      // F2 (class scope): guard the WRITE side too — even though
      // `file.destination` comes from the plan's own trusted destination
      // table, a symlinked intermediate directory (e.g. a symlinked
      // `.claude/`) can still make it resolve outside `destRoot` on disk.
      const contained = await resolveContainedPath(destRoot, file.destination);
      if (!contained.ok) {
        skipped.push({
          path: file.destination,
          reason: `destination resolves outside the project root (${contained.reason}) — refusing to write it`,
        });
        continue;
      }
      const destinationAbs = contained.abs;
      const alreadyExists = await pathExists(destinationAbs);
      if (alreadyExists && !options.force) {
        const recordedHash = recordedHashes.get(file.destination);
        // R3-3: a planned destination that already exists as a directory
        // must not crash apply with a raw EISDIR — skip it the same way an
        // unrecorded/drifted file is skipped, rather than hash it.
        let currentHash: string | undefined;
        try {
          currentHash = await sha256OfFile(destRoot, file.destination);
        } catch (error) {
          if (error instanceof NotARegularFileError) {
            skipped.push({ path: file.destination, reason: `${error.message} — refusing to overwrite it` });
            continue;
          }
          throw error;
        }
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
          // F16: keep the file recorded (with its OLD hash, unchanged) so
          // `doctor` still reports it `drifted`, not `orphaned` — a plain
          // re-apply must never silently make a drifted file's own prior
          // record disappear just because this module also has other files
          // that DID write successfully this round (which would otherwise
          // overwrite the whole per-module record with only the new subset).
          writtenPaths.push(file.destination);
          sha256[file.destination] = recordedHash;
          continue;
        }
      }

      const sourceBytes = await readFile(path.join(sourceRoot, file.source));
      await writeContained(destRoot, file.destination, sourceBytes);
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
