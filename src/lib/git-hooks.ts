import path from "node:path";
import { stat } from "node:fs/promises";
import { pathExists } from "./fs";

export async function resolveGitHooksRoot(projectRoot: string): Promise<string | null> {
  const dotGit = path.join(projectRoot, ".git");
  const fallback = async (): Promise<string | null> => {
    try {
      return (await stat(dotGit)).isDirectory() ? path.join(dotGit, "hooks") : null;
    } catch {
      return null;
    }
  };
  if (!Bun.which("git")) return fallback();
  const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0 || !stdout.trim()) return fallback();
  const commonDir = stdout.trim();
  const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(projectRoot, commonDir);
  return path.join(absolute, "hooks");
}
