import path from "node:path";

/**
 * Whether git reports the acceptance-criteria file as unchanged against HEAD.
 *
 * This is the whole gate on `flow ac reseal`, so be exact about what it proves
 * and what it does not.
 *
 * It proves: nobody edited the criteria and then resealed to launder the edit.
 * A working-tree modification, a staged modification, and an untracked file all
 * make this false.
 *
 * It does NOT prove the recorded checksum was ever correct — it cannot. The
 * case this exists for (flow 002) has a criteria file byte-identical to its
 * first commit and an `acChecksum` function unchanged since that same commit,
 * with the values still differing: the seal was taken against content that
 * predates the squashed 0.1.0 import and is not recoverable. No check can
 * reconstruct what was sealed. What a reseal can honestly claim is that the
 * file being sealed now is the file that is committed now.
 *
 * Refusing when git is unavailable is deliberate. Without git there is no
 * evidence either way, and "no evidence" must not read the same as "clean" —
 * that conflation is the defect this whole command was written to correct.
 */
export interface ResealEvidence {
  clean: boolean;
  /** Why it is not clean, or why cleanliness could not be established. */
  reason?: string;
}

export async function acFileUnchangedSinceHead(
  cwd: string,
  acRelativePath: string,
): Promise<ResealEvidence> {
  if (!Bun.which("git")) {
    return { clean: false, reason: "git is not on PATH, so the file's state cannot be established" };
  }

  const inRepo = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [inRepoOut, inRepoCode] = await Promise.all([
    new Response(inRepo.stdout).text(),
    inRepo.exited,
  ]);
  if (inRepoCode !== 0 || inRepoOut.trim() !== "true") {
    return { clean: false, reason: "not inside a git work tree, so the file's state cannot be established" };
  }

  // `status --porcelain` on the single path covers modified, staged and
  // untracked in one answer: any output at all means the committed file and the
  // file on disk are not the same thing.
  const status = Bun.spawn(["git", "status", "--porcelain", "--", acRelativePath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [statusOut, statusCode] = await Promise.all([
    new Response(status.stdout).text(),
    status.exited,
  ]);
  if (statusCode !== 0) {
    return { clean: false, reason: "git status failed, so the file's state cannot be established" };
  }
  if (statusOut.trim().length > 0) {
    return {
      clean: false,
      reason: `git reports ${acRelativePath} as changed: ${statusOut.trim().split("\n")[0]}`,
    };
  }

  // An untracked file produces no `status` output once it is ignored, which
  // would read as clean. Ask git directly whether it knows the path at all.
  const tracked = Bun.spawn(["git", "ls-files", "--error-unmatch", "--", acRelativePath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const trackedCode = await tracked.exited;
  if (trackedCode !== 0) {
    return {
      clean: false,
      reason: `${acRelativePath} is not tracked by git, so there is no committed version to compare against`,
    };
  }

  return { clean: true };
}

export function acRelativePathFor(flowsRootRelative: string, dir: string): string {
  return path.posix.join(flowsRootRelative, dir, "acceptance-criteria.md");
}
