import { execFile } from "node:child_process";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bundledSkillMarkdownPath } from "../../gdskills/catalog";
import { revisionOperand } from "../../lib/git-revision";
const execFileAsync = promisify(execFile);
export async function ensureRunsRoot(root: string): Promise<void> { await mkdir(root, { recursive: true }); }

export async function snapshotGitRevision(projectRoot: string, revision: string, destination: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", ...revisionOperand(`${revision}^{commit}`)], { cwd: projectRoot, encoding: "utf8" });
  const resolved = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(resolved)) throw new Error("revision did not resolve to a commit");
  await mkdir(path.join(destination, "source"), { recursive: true });
  const archive = path.join(destination, "source.tar");
  await execFileAsync("git", ["archive", "--format=tar", `--output=${archive}`, ...revisionOperand(resolved), ".", ":(exclude).metaproject"], { cwd: projectRoot });
  try { await execFileAsync("tar", ["-xf", archive, "-C", path.join(destination, "source")]); }
  finally { await unlink(archive).catch(() => undefined); }
  return resolved;
}

export async function reviewSkillInstructions(projectRoot: string, skillRef: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(skillRef)) throw new Error(`Invalid Review agents skill reference ${skillRef}`);
  const candidates = [
    path.join(projectRoot, ".metaproject", "project-skills", "review", skillRef, "SKILL.md"),
    path.join(projectRoot, ".metaproject", "skills", "gdskills", "review", skillRef, "SKILL.md"),
    bundledSkillMarkdownPath("review", skillRef),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try { return await readFile(candidate, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error(`Review agents skill ${skillRef} is not installed`);
}

