import { lstatSync } from "node:fs";
import path from "node:path";
import { assertNativeShadowPath, git, gitOk, REWIND_MAX_FILE_BYTES, splitNul, type ShadowRepo } from "./shadow";

export interface CapturedTree {
  tree: string;
  skipped: string[];
}

/** Folds the work tree's current state into the shadow index and returns its tree id. */
export async function captureTree(repo: ShadowRepo): Promise<CapturedTree> {
  const listed = splitNul(await gitOk(repo, ["ls-files", "-z", "-o", "-m", "-d", "--exclude-standard"]));
  const keep: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const observed = new Map<string, { ino: number; dev: number; size: number; mtimeMs: number; mode: number } | null>();
  if (repo.native) {
    repo.native.assertOwnership(); repo.native.signal().throwIfAborted();
    if (listed.length > 5000) throw new Error("snapshot-quota");
    await repo.native.validatePaths(listed, repo.native.signal());
  }
  for (const rel of new Set(listed)) {
    if (rel.endsWith("/")) continue;
    if (repo.native) assertNativeShadowPath(repo.workTree, rel);
    let stat;
    try {
      stat = lstatSync(path.join(repo.workTree, rel));
    } catch {
      if (repo.native) observed.set(rel, null);
      keep.push(rel);
      continue;
    }
    if (repo.native) {
      if (!stat.isFile()) throw new Error("unsupported-snapshot");
      observed.set(rel, { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    if (repo.native && (stat.isSymbolicLink() || !stat.isFile() || (bytes += stat.size) > 20 * 1024 * 1024)) throw new Error("unsupported-snapshot");
    if (stat.size > REWIND_MAX_FILE_BYTES && !repo.native) {
      skipped.push(rel);
      continue;
    }
    keep.push(rel);
  }
  if (keep.length > 0) {
    await gitOk(repo, ["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], { stdin: `${keep.join("\0")}\0` });
  }
  const tree = (await gitOk(repo, ["write-tree"])).trim();
  if (repo.native) {
    repo.native.assertOwnership(); repo.native.signal().throwIfAborted();
    await repo.native.validatePaths([...observed.keys()], repo.native.signal());
    for (const [relative, expected] of observed) {
      assertNativeShadowPath(repo.workTree, relative);
      let actual;
      try { const stat = lstatSync(path.join(repo.workTree, relative)); actual = { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; actual = null; }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("snapshot-interference");
    }
  }
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
