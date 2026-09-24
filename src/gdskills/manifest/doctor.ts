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
import { readSkillsInstallState, sha256OfFile } from "./state";

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
}

function destinationRootsFor(target: string): string[] {
  if (target === "claude") return [".claude/skills", ".claude/rules"];
  if (target === "keryx-shell") return [".metaproject/skills/gdskills", ".metaproject/rules/core"];
  return [];
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
  const state = await readSkillsInstallState(repoRoot, target);
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

  for (const root of destinationRootsFor(target)) {
    const files = await listFilesRecursive(path.join(repoRoot, root));
    for (const abs of files) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
      if (!recordedPaths.has(rel)) {
        entries.push({ moduleId: undefined, path: rel, status: "orphaned" });
      }
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { target, entries, ok: entries.every((e) => e.status === "ok") };
}
