import { chmod, constants, copyFile, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git";

export interface CopyEnvFilesInput {
  mainRoot: string;
  worktreeRoot: string;
  /** Paths relative to the checkout root, as named by the configuration. */
  files: readonly string[];
  force?: boolean;
}

export interface SkippedEnvFile {
  file: string;
  reason: string;
}

export interface CopyEnvFilesResult {
  copied: string[];
  skipped: SkippedEnvFile[];
}

function isUnsafeRelative(file: string): boolean {
  return file.length === 0 || path.isAbsolute(file) || file.includes("..");
}

/**
 * Copy the named env files from the main checkout into the worktree (spec §7.1).
 * Only files that git ignores in the worktree are copied; anything else is skipped
 * and reported by name. An existing destination is kept unless `force`. The mode is
 * preserved. File contents are never read into this process's output.
 */
export async function copyEnvFiles(input: CopyEnvFilesInput): Promise<CopyEnvFilesResult> {
  const { mainRoot, worktreeRoot, files, force = false } = input;
  const result: CopyEnvFilesResult = { copied: [], skipped: [] };

  const sameCheckout = (await realpath(mainRoot).catch(() => mainRoot)) === (await realpath(worktreeRoot).catch(() => worktreeRoot));
  for (const file of files) {
    const skip = (reason: string): void => {
      result.skipped.push({ file, reason });
    };
    if (sameCheckout) {
      skip("source and destination are the same checkout");
      continue;
    }
    if (isUnsafeRelative(file)) {
      skip("path must be relative and stay inside the checkout");
      continue;
    }
    const source = path.join(mainRoot, file);
    const destination = path.join(worktreeRoot, file);

    const sourceStat = await lstat(source).catch(() => undefined);
    if (sourceStat === undefined) {
      skip("not found in the main checkout");
      continue;
    }
    if (!sourceStat.isFile()) {
      skip("not a regular file in the main checkout");
      continue;
    }

    const ignored = await runGit(worktreeRoot, ["check-ignore", "-q", "--", file]);
    if (ignored.code === 1) {
      skip("not ignored by git in the worktree");
      continue;
    }
    if (ignored.code !== 0) {
      skip("could not check git ignore status");
      continue;
    }

    await mkdir(path.dirname(destination), { recursive: true });
    if (force) {
      // Never write through a symlink an earlier run or the branch left at the destination.
      await unlink(destination).catch(() => undefined);
    }
    try {
      await copyFile(source, destination, force ? 0 : constants.COPYFILE_EXCL);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        skip("already exists in the worktree (use force to overwrite)");
        continue;
      }
      throw cause;
    }
    await chmod(destination, sourceStat.mode & 0o7777);
    result.copied.push(file);
  }
  return result;
}
