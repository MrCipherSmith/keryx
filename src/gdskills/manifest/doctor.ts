// Flow 309 (W1), T6: `doctorInstall` — compare recorded install-state to
// disk and report each recorded path `ok`/`drifted`/`missing`, plus
// `orphaned` files found under this target's own destination roots that
// install-state does not know about.
//
// "Orphaned" is bounded and deterministic by construction: only the fixed
// destination ROOTS this target's v1 destination table can ever write under
// (`.claude/skills`, `.claude/rules` for `claude`; `.metaproject/skills/gdskills`,
// `.metaproject/rules/core` for `keryx-shell`) are walked — never the whole
// project tree — so a file the module system never could have written is
// never reported as orphaned, and the scan cost is bounded by those roots'
// size alone.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";
import { destinationRootsForTarget } from "./plan";
import { readSkillsInstallState, resolveContainedPath, skillsInstallStateIsUnreadable, sha256OfFile } from "./state";

export type DoctorStatus = "ok" | "drifted" | "missing" | "orphaned";

export interface DoctorEntry {
  moduleId: string | undefined;
  path: string;
  status: DoctorStatus;
}

export interface DoctorReport {
  target: string;
  entries: DoctorEntry[];
  ok: boolean;
  /**
   * F2/F17: non-empty when the recorded install-state itself could not be
   * trusted — either the `<target>.json` file exists but is not valid
   * install-state JSON (corrupt/schema-invalid), or a recorded path escapes
   * the project root or this target's own destination roots. `entries` is
   * empty and `ok` is false whenever this is non-empty: doctor refuses to
   * re-hash or orphan-scan against state it cannot trust.
   */
  invalidState: string[];
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export async function doctorInstall(repoRoot: string, target: string): Promise<DoctorReport> {
  // F17: a `<target>.json` that exists but fails schema validation (corrupt
  // JSON, or well-formed JSON that isn't valid install-state) must be
  // reported as a problem, not silently read as "nothing recorded" — that
  // would make doctor report a clean `ok` next to a genuinely broken file.
  if (await skillsInstallStateIsUnreadable(repoRoot, target)) {
    return {
      target,
      entries: [],
      ok: false,
      invalidState: [
        `install-state for target "${target}" exists but is not valid install-state JSON (corrupt or schema-invalid) — refusing to read it`,
      ],
    };
  }

  const state = await readSkillsInstallState(repoRoot, target);
  const destinationRoots = destinationRootsForTarget(target);

  // F2: every recorded path must be contained under the project root AND
  // under this target's own destination roots before doctor trusts it for
  // ANY filesystem read (re-hash, missing-check, orphan-scan exclusion) — a
  // record naming `../victim.txt` must never be silently hashed or treated
  // as legitimately "missing"/"ok".
  const invalidState: string[] = [];
  for (const record of state?.installedModules ?? []) {
    for (const filePath of record.writtenPaths) {
      const result = await resolveContainedPath(repoRoot, filePath, destinationRoots);
      if (!result.ok) {
        invalidState.push(`module "${record.moduleId}" recorded path "${filePath}": ${result.reason}`);
      }
    }
  }
  if (invalidState.length > 0) {
    return { target, entries: [], ok: false, invalidState };
  }

  const entries: DoctorEntry[] = [];
  const recordedPaths = new Set<string>();

  for (const record of state?.installedModules ?? []) {
    for (const filePath of record.writtenPaths) {
      recordedPaths.add(filePath);
      const abs = path.join(repoRoot, filePath);
      if (!(await pathExists(abs))) {
        entries.push({ moduleId: record.moduleId, path: filePath, status: "missing" });
        continue;
      }
      const recordedHash = record.sha256[filePath];
      const currentHash = await sha256OfFile(repoRoot, filePath);
      const status: DoctorStatus = recordedHash !== undefined && currentHash === recordedHash ? "ok" : "drifted";
      entries.push({ moduleId: record.moduleId, path: filePath, status });
    }
  }

  for (const root of destinationRoots) {
    const files = await listFilesRecursive(path.join(repoRoot, root));
    for (const abs of files) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
      if (!recordedPaths.has(rel)) {
        entries.push({ moduleId: undefined, path: rel, status: "orphaned" });
      }
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { target, entries, ok: entries.every((e) => e.status === "ok"), invalidState: [] };
}
