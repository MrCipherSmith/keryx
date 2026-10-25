import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";

/** Review packages are written by the review itself, so they never count as the reviewed state. */
export const REVIEW_PACKAGES_DIR = ".metaproject/reviews";
const EXCLUDE_REVIEW_PACKAGES = `:(exclude)${REVIEW_PACKAGES_DIR}`;

export type ProvenanceLimits = {
  /** More untracked, non-ignored files than this and the treeHash is left out. */
  maxUntrackedFiles: number;
  /** An untracked file larger than this contributes its size only. */
  maxHashedFileBytes: number;
  /** Output of one git command (the tracked diff is the large one) over this size leaves the treeHash out. */
  maxGitOutputBytes: number;
  /** Bytes read from untracked files in total; past it the treeHash is left out. */
  maxTotalBytes: number;
  /** Wall time for one git command. */
  gitTimeoutMs: number;
  /** Wall time for the whole step; past it the treeHash is left out. */
  maxMs: number;
};

export const DEFAULT_PROVENANCE_LIMITS: ProvenanceLimits = {
  maxUntrackedFiles: 20_000,
  maxHashedFileBytes: 10 * 1024 * 1024,
  maxGitOutputBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  gitTimeoutMs: 60_000,
  maxMs: 120_000,
};

function gitOutput(args: string[], cwd: string, limits: ProvenanceLimits): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const env = { ...withoutGitDiscoveryOverrides(process.env), GIT_OPTIONAL_LOCKS: "0" };
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, limits.gitTimeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.maxGitOutputBytes) {
        over = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && !over ? Buffer.concat(chunks) : undefined);
    });
  });
}

/** What one untracked entry contributes to the hash; a link or special file is never followed or opened. */
async function untrackedDigest(full: string, limits: ProvenanceLimits): Promise<Buffer> {
  try {
    const info = await lstat(full);
    if (info.isSymbolicLink()) return Buffer.from(`link:${await readlink(full)}`);
    if (!info.isFile()) return Buffer.from("other:");
    return info.size <= limits.maxHashedFileBytes ? Buffer.concat([Buffer.from("file:"), await readFile(full)]) : Buffer.from(`big:${info.size}`);
  } catch {
    return Buffer.from("unreadable:");
  }
}

/**
 * Which state of the worktree a pass judged: its commit and a hash of the uncommitted changes to tracked
 * files (staged and unstaged, binary included) plus the untracked, non-ignored files. Review packages under
 * `.metaproject/reviews` are left out, since a pass writes its own evidence there. Not covered: ignored
 * files (the scratch copy still includes them), the inside of an untracked nested repository, and the
 * content of an untracked file over `maxHashedFileBytes`, which counts by size only.
 * `head` and `treeHash` are both left out when the worktree is not the root of a git checkout or git fails;
 * `treeHash` alone when a limit is exceeded. Runs on the worktree, never on the scratch copy.
 */
export async function worktreeProvenance(worktree: string, overrides: Partial<ProvenanceLimits> = {}): Promise<{ head?: string; treeHash?: string }> {
  const limits = { ...DEFAULT_PROVENANCE_LIMITS, ...overrides };
  const deadline = Date.now() + limits.maxMs;
  const top = await gitOutput(["rev-parse", "--show-toplevel"], worktree, limits);
  if (top === undefined) return {};
  const [topReal, worktreeReal] = await Promise.all([realpath(top.toString("utf8").trim()).catch(() => undefined), realpath(worktree).catch(() => undefined)]);
  if (topReal === undefined || topReal !== worktreeReal) return {};
  const headOut = await gitOutput(["rev-parse", "HEAD"], worktree, limits);
  if (headOut === undefined) return {};
  const head = headOut.toString("utf8").trim();
  const diff = await gitOutput(["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--", ".", EXCLUDE_REVIEW_PACKAGES], worktree, limits);
  const listed = await gitOutput(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", EXCLUDE_REVIEW_PACKAGES], worktree, limits);
  if (diff === undefined || listed === undefined) return { head };
  const untracked = listed.toString("utf8").split("\0").filter((name) => name !== "").sort();
  if (untracked.length > limits.maxUntrackedFiles) return { head };
  const hash = createHash("sha256").update(diff);
  let total = 0;
  for (const name of untracked) {
    if (Date.now() > deadline) return { head };
    const digest = await untrackedDigest(path.join(worktree, name), limits);
    total += digest.length;
    if (total > limits.maxTotalBytes) return { head };
    hash.update(`\0${name}\0${digest.length}\0`).update(digest);
  }
  return { head, treeHash: hash.digest("hex") };
}
