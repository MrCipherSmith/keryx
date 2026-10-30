import { constants, existsSync, lstatSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isPathInside } from "../lib/fs";
import { assertNativeShadowPath as strictRewindPath, gitOk, splitNul, type ShadowRepo } from "./shadow";
import { captureTree } from "./snapshot";
import { REWIND_MAX_FILE_BYTES } from "./shadow";

export interface RewindFileState { oid: string; size: number; mode: string }
export interface RewindRestorePlan { targetTree: string; digest: string; paths: string[]; states: { path: string; current: RewindFileState | null; target: RewindFileState | null }[] }
const MAX_TOTAL = 20 * 1024 * 1024;
const fileDigest = (data: Buffer) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const planDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export { assertNativeShadowPath as strictRewindPath } from "./shadow";

async function currentState(root: string, relative: string, signal: AbortSignal, textOnly = false): Promise<RewindFileState | null> {
  strictRewindPath(root, relative); signal.throwIfAborted();
  let initial;
  try { initial = lstatSync(path.join(root, relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!initial.isFile() || initial.size > (textOnly ? REWIND_MAX_FILE_BYTES : MAX_TOTAL)) throw new Error("unsupported-snapshot");
  const handle = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat(); if (actual.ino !== initial.ino || actual.dev !== initial.dev) throw new Error("snapshot-interference");
    const buffer = Buffer.alloc(Math.min((textOnly ? REWIND_MAX_FILE_BYTES : MAX_TOTAL) + 1, initial.size + 1)); let bytes = 0;
    while (bytes < buffer.length) { signal.throwIfAborted(); const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!read.bytesRead) break; bytes += read.bytesRead; }
    const after = await handle.stat();
    if (bytes > (textOnly ? REWIND_MAX_FILE_BYTES : MAX_TOTAL) || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) throw new Error("snapshot-interference");
    if (textOnly) { const contents = buffer.subarray(0, bytes); if (contents.includes(0)) throw new Error("unsupported-snapshot"); try { new TextDecoder("utf-8", { fatal: true }).decode(contents); } catch { throw new Error("unsupported-snapshot"); } }
    return { oid: fileDigest(buffer.subarray(0, bytes)), size: bytes, mode: initial.mode & 0o111 ? "100755" : "100644" };
  } finally { await handle.close(); }
}
/** Pure native preview: reads the existing private tree plus current owned files; never initializes/captures a tree or updates an index. */
export async function previewRestoreTree(repo: ShadowRepo, targetTree: string): Promise<RewindRestorePlan> {
  if (!repo.native || !/^[a-f0-9]{40}$/.test(targetTree)) throw new Error("unsupported-snapshot");
  repo.native.assertOwnership(); const signal = repo.native.signal(); signal.throwIfAborted();
  const listed = splitNul(await gitOk(repo, ["ls-tree", "-r", "-z", "-l", targetTree]));
  const target = new Map<string, RewindFileState>(); let total = 0;
  for (const line of listed) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("unsupported-snapshot");
    const [, mode, oid, rawSize, relative] = match; const size = Number(rawSize);
    strictRewindPath(repo.workTree, relative!); if (size > MAX_TOTAL || (total += size) > MAX_TOTAL || target.has(relative!)) throw new Error("snapshot-quota");
    target.set(relative!, { oid: oid!, size, mode: mode! });
  }
  const candidates = [...new Set([...target.keys(), ...repo.native.currentPaths()])].sort();
  if (candidates.length > 5000) throw new Error("snapshot-quota");
  await repo.native.validatePaths(candidates, signal);
  const states: RewindRestorePlan["states"] = [];
  for (const relative of candidates) {
    const current = await currentState(repo.workTree, relative, signal); total += current?.size ?? 0;
    if (total > MAX_TOTAL * 2) throw new Error("snapshot-quota");
    const desired = target.get(relative) ?? null;
    if (JSON.stringify(current) !== JSON.stringify(desired)) states.push({ path: relative, current, target: desired });
  }
  // Unsupported content is a restoration constraint. An untouched opaque asset
  // must not make an otherwise representable text-only restore unavailable.
  for (const state of states) { if ((state.target?.size ?? 0) > REWIND_MAX_FILE_BYTES) throw new Error("unsupported-snapshot"); await currentState(repo.workTree, state.path, signal, true); }
  await verifyTargetBlobs(repo, new Map(states.flatMap(state => state.target === null ? [] : [[state.path, state.target] as const])));
  repo.native.assertOwnership(); signal.throwIfAborted();
  const body = { targetTree, states }; return { ...body, digest: planDigest(body), paths: states.map(row => row.path) };
}
async function verifyTargetBlobs(repo: ShadowRepo, targets: ReadonlyMap<string, RewindFileState>): Promise<void> {
  const unique = [...new Map([...targets.values()].map(value => [value.oid, value])).values()];
  let batch: RewindFileState[] = []; let bytes = 0;
  const verify = async () => {
    if (!batch.length) return;
    const output = Buffer.from(await gitOk(repo, ["cat-file", "--batch"], { stdin: batch.map(value => value.oid).join("\n") + "\n" }));
    let offset = 0;
    for (const expected of batch) {
      const lineEnd = output.indexOf(10, offset);
      if (lineEnd < 0 || output.subarray(offset, lineEnd).toString() !== `${expected.oid} blob ${expected.size}`) throw new Error("snapshot-object-corrupt");
      const blob = output.subarray(lineEnd + 1, lineEnd + 1 + expected.size);
      if (blob.length !== expected.size || blob.includes(0) || fileDigest(blob) !== expected.oid || output[lineEnd + 1 + expected.size] !== 10) throw new Error("unsupported-snapshot");
      offset = lineEnd + 2 + expected.size;
    }
    if (offset !== output.length) throw new Error("snapshot-object-corrupt");
    batch = []; bytes = 0;
  };
  for (const target of unique) { if (bytes + target.size + 100 > REWIND_MAX_FILE_BYTES && batch.length) await verify(); batch.push(target); bytes += target.size + 100; }
  await verify();
}

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
export async function restoreTree(repo: ShadowRepo, targetTree: string, options: { expectedPlanDigest?: string } = {}): Promise<RestoreResult> {
  const strict = repo.native === undefined ? undefined : await previewRestoreTree(repo, targetTree);
  if (options.expectedPlanDigest !== undefined && strict?.digest !== options.expectedPlanDigest) throw new Error("stale-preview");
  const current = await captureTree(repo);
  if (repo.native && (await previewRestoreTree(repo, targetTree)).digest !== strict!.digest) throw new Error("snapshot-interference");
  const result: RestoreResult = { restored: [], recreated: [], removed: [], skipped: current.skipped };
  const parts = splitNul(await gitOk(repo, ["diff-tree", "-r", "-z", "--name-status", "--no-renames", current.tree, targetTree]));
  const write: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const rel = parts[i + 1]!;
    if (isProtected(rel) || !staysInside(repo.workTree, rel)) { if (repo.native) throw new Error("unsupported-snapshot"); continue; }
    if (repo.native) { repo.native.assertOwnership(); repo.native.signal().throwIfAborted(); strictRewindPath(repo.workTree, rel); const expected = strict!.states.find(row => row.path === rel); if (!expected || JSON.stringify(await currentState(repo.workTree, rel, repo.native.signal())) !== JSON.stringify(expected.current)) throw new Error("snapshot-interference"); }
    if (status === "D") {
      const full = path.join(repo.workTree, rel);
      try {
        lstatSync(full);
        unlinkSync(full);
      } catch (error) {
        if (repo.native) throw error;
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
    if (repo.native) { await repo.native.validatePaths(write, repo.native.signal()); for (const rel of write) { strictRewindPath(repo.workTree, rel); const expected = strict!.states.find(row => row.path === rel)!; if (JSON.stringify(await currentState(repo.workTree, rel, repo.native.signal())) !== JSON.stringify(expected.current)) throw new Error("snapshot-interference"); } }
    await gitOk(repo, ["checkout-index", "-f", "-z", "--stdin"], { stdin: `${write.join("\0")}\0` });
  }
  return result;
}
