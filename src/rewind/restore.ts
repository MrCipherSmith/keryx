import { existsSync, lstatSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { isPathInside } from "../lib/fs";
import { gitOk, splitNul, type ShadowRepo } from "./shadow";
import { captureTree } from "./snapshot";

export interface RestoreResult {
  /** Files that existed and were put back to their snapshot content. */
  restored: string[];
  /** Files deleted since the snapshot that were written back. */
  recreated: string[];
  /** Files created since the snapshot that were removed. */
  removed: string[];
  /** Files over the size cap that were never captured, so left as they are. */
  skipped: string[];
}

const PROTECTED_PREFIXES = [".git/", "node_modules/", ".metaproject/data/"];

function isProtected(rel: string): boolean {
  const normalized = path.posix.normalize(rel);
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) return true;
  return normalized === ".git" || PROTECTED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** The nearest existing ancestor of `rel` must resolve inside the project root, so a symlinked directory cannot redirect a write or delete. */
function staysInside(root: string, rel: string): boolean {
  let probe = path.dirname(path.join(root, rel));
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try {
    return isPathInside(realpathSync(root), realpathSync(probe));
  } catch {
    return false;
  }
}

function removeEmptyParents(root: string, rel: string): void {
  let dir = path.dirname(path.join(root, rel));
  while (dir !== root && isPathInside(root, dir)) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Puts the work tree back to `targetTree`: modified files restored, created files removed, deleted files recreated. */
export async function restoreTree(repo: ShadowRepo, targetTree: string): Promise<RestoreResult> {
  const current = await captureTree(repo);
  const result: RestoreResult = { restored: [], recreated: [], removed: [], skipped: current.skipped };
  const parts = splitNul(await gitOk(repo, ["diff-tree", "-r", "-z", "--name-status", "--no-renames", current.tree, targetTree]));
  const write: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const rel = parts[i + 1]!;
    if (isProtected(rel) || !staysInside(repo.workTree, rel)) continue;
    if (status === "D") {
      const full = path.join(repo.workTree, rel);
      try {
        lstatSync(full);
        unlinkSync(full);
      } catch {
        continue;
      }
      removeEmptyParents(repo.workTree, rel);
      result.removed.push(rel);
    } else if (status === "A") {
      write.push(rel);
      result.recreated.push(rel);
    } else {
      write.push(rel);
      result.restored.push(rel);
    }
  }
  await gitOk(repo, ["read-tree", targetTree]);
  if (write.length > 0) {
    await gitOk(repo, ["checkout-index", "-f", "-z", "--stdin"], { stdin: `${write.join("\0")}\0` });
  }
  return result;
}
