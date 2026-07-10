import type { RunProvenance } from "./types";

export async function collectGitProvenance(cwd: string): Promise<RunProvenance> {
  const [commit, branch, worktree] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["rev-parse", "--show-toplevel"]),
  ]);
  return {
    commit,
    branch: branch || null,
    worktree,
    sources: [
      {
        name: "git",
        path: ".git",
        timestamp: new Date().toISOString(),
        reliability: commit ? "exact" : "unknown",
      },
    ],
  };
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  if (!Bun.which("git")) return null;
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? stdout.trim() || null : null;
}
