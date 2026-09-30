import { lstatSync } from "node:fs";
import path from "node:path";
import { git, gitOk, REWIND_MAX_FILE_BYTES, splitNul, type ShadowRepo } from "./shadow";

export interface CapturedTree {
  tree: string;
  skipped: string[];
}

/** Folds the work tree's current state into the shadow index and returns its tree id. */
export async function captureTree(repo: ShadowRepo): Promise<CapturedTree> {
  const listed = splitNul(await gitOk(repo, ["ls-files", "-z", "-o", "-m", "-d", "--exclude-standard"]));
  const keep: string[] = [];
  const skipped: string[] = [];
  for (const rel of new Set(listed)) {
    if (rel.endsWith("/")) continue;
    let stat;
    try {
      stat = lstatSync(path.join(repo.workTree, rel));
    } catch {
      keep.push(rel);
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    if (stat.size > REWIND_MAX_FILE_BYTES) {
      skipped.push(rel);
      continue;
    }
    keep.push(rel);
  }
  if (keep.length > 0) {
    await gitOk(repo, ["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], { stdin: `${keep.join("\0")}\0` });
  }
  const tree = (await gitOk(repo, ["write-tree"])).trim();
  return { tree, skipped: skipped.sort() };
}

export async function writeSnapshotRef(repo: ShadowRepo, seq: number, tree: string): Promise<void> {
  await gitOk(repo, ["update-ref", `refs/rewind/${seq}`, tree]);
}

export async function deleteSnapshotRef(repo: ShadowRepo, seq: number): Promise<void> {
  await git(repo, ["update-ref", "-d", `refs/rewind/${seq}`]);
}

export async function changedFiles(repo: ShadowRepo, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  return splitNul(await gitOk(repo, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]));
}
