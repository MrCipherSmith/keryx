// Flow 361: what `HEAD` holds for a project file. The migration off tracked
// entrypoints asks two questions of git — "what did the team commit here" and
// "has this file moved since" — and both must work when the project root is a
// subdirectory of the repository, so every path is addressed as `./<rel>`
// from `projectRoot` rather than from the repository top level.

export type HeadStatus =
  /** `HEAD` has no version of the file: never committed, no commit yet, or not a git repository. */
  | "untracked"
  /** The working tree (and index) match `HEAD`. */
  | "equal"
  /** `HEAD` has the file and the working tree or index differs from it, a deleted file included. */
  | "differs";

async function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string } | undefined> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  } catch {
    // `git` itself is unavailable, or `cwd` is gone: same answer as "not a repository".
    return undefined;
  }
}

function headSpec(relativePath: string): string {
  return `HEAD:./${relativePath.split("\\").join("/")}`;
}

/**
 * The content of `relativePath` (relative to `projectRoot`) as committed in
 * `HEAD`, or `undefined` when `HEAD` has no such file — which covers an
 * untracked file, a repository with no commit, and no repository at all.
 */
export async function readHeadBlob(projectRoot: string, relativePath: string): Promise<string | undefined> {
  const result = await runGit(projectRoot, ["show", headSpec(relativePath)]);
  return result !== undefined && result.code === 0 ? result.stdout : undefined;
}

/**
 * Where `relativePath` stands against `HEAD`. Asked of git (`git diff --quiet
 * HEAD`) rather than by comparing bytes, so line-ending and clean filters
 * give the same verdict `git status` would.
 */
export async function classifyAgainstHead(projectRoot: string, relativePath: string): Promise<HeadStatus> {
  const inHead = await runGit(projectRoot, ["cat-file", "-e", headSpec(relativePath)]);
  if (inHead === undefined || inHead.code !== 0) return "untracked";
  const diff = await runGit(projectRoot, ["diff", "--quiet", "HEAD", "--", relativePath]);
  return diff !== undefined && diff.code === 0 ? "equal" : "differs";
}

/**
 * Puts `HEAD`'s version of `relativePath` back into the working tree and
 * leaves the index alone. Done by git (`git restore --source=HEAD
 * --worktree`) rather than by writing the blob, so smudge and line-ending
 * filters produce the same bytes a checkout would. False when git refused or
 * is too old to know `restore`.
 */
export async function restoreWorktreeFileFromHead(projectRoot: string, relativePath: string): Promise<boolean> {
  const result = await runGit(projectRoot, ["restore", "--source=HEAD", "--worktree", "--", relativePath]);
  return result !== undefined && result.code === 0;
}

/** `git diff --quiet -- <file>`: true when the working tree copy shows no unstaged change. */
export async function worktreeFileIsClean(projectRoot: string, relativePath: string): Promise<boolean> {
  const result = await runGit(projectRoot, ["diff", "--quiet", "--", relativePath]);
  return result !== undefined && result.code === 0;
}
