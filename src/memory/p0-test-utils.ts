import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runtime trees that are disposable and must not pollute a contract snapshot. */
const IGNORED_RUNTIME_PARTS = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".metaproject/data/gdctx",
  ".metaproject/data/testing/logs",
  ".metaproject/data/health/logs",
]);

export type ProjectSnapshot = {
  files: Array<{ path: string; sha256: string; content: string }>;
  gitStatus: string[];
};

export type SnapshotOptions = {
  /** Limit the snapshot to these root-relative paths; defaults to the project. */
  paths?: string[];
  /** Include a disposable path explicitly (for example, legacy report artifacts). */
  includeRuntimePaths?: string[];
};

function isIgnoredRuntime(relativePath: string, include: Set<string>): boolean {
  if (include.has(relativePath)) {
    return false;
  }
  for (const ignored of IGNORED_RUNTIME_PARTS) {
    if (relativePath === ignored || relativePath.startsWith(`${ignored}/`)) {
      return true;
    }
  }
  return false;
}

async function collectFiles(
  root: string,
  current: string,
  relativePrefix: string,
  include: Set<string>,
  files: Array<{ path: string; sha256: string; content: string }>,
): Promise<void> {
  for (const item of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, item.name);
    const relativePath = path.posix.join(relativePrefix, item.name);
    if (isIgnoredRuntime(relativePath, include)) {
      continue;
    }
    if (item.isDirectory()) {
      await collectFiles(root, absolute, relativePath, include, files);
      continue;
    }
    if (!item.isFile()) {
      continue;
    }
    const content = await readFile(absolute, "utf8");
    files.push({
      path: path.relative(root, absolute).split(path.sep).join("/"),
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    });
  }
}

async function readGitStatus(root: string, paths: string[]): Promise<string[]> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", root, "status", "--short", "--untracked-files=all", "--", ...paths],
      { maxBuffer: 1024 * 1024 },
    );
    return result.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean).sort();
  } catch {
    // Temporary test roots are often not repositories. A null Git state is
    // represented as an empty status rather than making filesystem assertions
    // depend on the host checkout.
    return [];
  }
}

/**
 * Capture the relevant project state for a read-purity contract.
 *
 * Files are root-relative and include both content and SHA-256 so callers can
 * diagnose a changed path without a second read. Git status is scoped to the
 * same roots and ignored runtime noise is skipped unless explicitly included.
 */
export async function snapshotProject(
  root: string,
  options: SnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const paths = options.paths ?? ["."];
  const include = new Set(options.includeRuntimePaths ?? []);
  const files: Array<{ path: string; sha256: string; content: string }> = [];

  for (const relativePath of paths) {
    const absolute = path.resolve(root, relativePath);
    try {
      await collectFiles(root, absolute, relativePath === "." ? "" : relativePath, include, files);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw cause;
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, gitStatus: await readGitStatus(root, paths) };
}

export function snapshotComparable(snapshot: ProjectSnapshot): string {
  return JSON.stringify({
    files: snapshot.files.map(({ path: filePath, sha256, content }) => ({ path: filePath, sha256, content })),
    gitStatus: snapshot.gitStatus,
  });
}

export function p0PurityEnforced(): boolean {
  return process.env.KERYX_P0_ENFORCE === "1";
}

/** Returning changed paths keeps every read-purity failure exact and actionable. */
export function assertP0Purity(before: ProjectSnapshot, after: ProjectSnapshot): void {
  const unchanged = snapshotComparable(after) === snapshotComparable(before);
  if (!unchanged) {
    const changed = after.files
      .filter((file) => before.files.find((old) => old.path === file.path)?.sha256 !== file.sha256)
      .map((file) => file.path);
    const mode = p0PurityEnforced() ? "enforcement" : "default";
    throw new Error(`P0 purity ${mode} failed; changed paths: ${changed.join(", ") || "Git status"}`);
  }
}
