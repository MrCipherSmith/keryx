import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalPath } from "../lib/clone-scope";
import { listProjects } from "../lib/project-registry";
import { reviewGitCommonDir, reviewGitEnvironment, reviewRepositories } from "../review/board-github";
import type { IssueProjectRef, IssueRef } from "./issues-contract";

const exec = promisify(execFile);
export const issueDigest = (key: string): string => createHash("sha256").update(key).digest("hex");

async function branch(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return (await exec("git", ["symbolic-ref", "--quiet", "--short", ref], {
      cwd, env: reviewGitEnvironment(), timeout: 3_000,
    })).stdout.trim() || undefined;
  } catch { return undefined; }
}

/** Registered projects plus the directory the operator explicitly opened in Desktop or Shell. */
export async function issueCheckouts(cwd: string, issue: IssueRef): Promise<IssueProjectRef[]> {
  if (issue.host.toLowerCase() !== "github.com") return [];
  const paths = new Map<string,string>();
  for (const entry of listProjects().filter(entry => entry.state === "active")) {
    paths.set(await canonicalPath(entry.path), entry.projectId);
  }
  const current = await canonicalPath(cwd);
  if (!paths.has(current)) paths.set(current, issueDigest(current));
  const matches: IssueProjectRef[] = [];
  await Promise.all(Array.from(paths, async ([root, projectId]) => {
    const names = await reviewRepositories(root).catch(() => []);
    if (!names.some(name => name.toLowerCase() === `${issue.owner}/${issue.repo}`.toLowerCase())) return;
    const common = await reviewGitCommonDir(root);
    if (!common) return;
    const base = (await branch(root, "refs/remotes/origin/HEAD"))?.replace(/^origin\//, "")
      ?? await branch(root, "HEAD") ?? "";
    matches.push({ projectId, cwd: root, cloneId: issueDigest(await canonicalPath(common)), baseBranch: base });
  }));
  return matches.sort((a, b) => a.cwd.localeCompare(b.cwd));
}

export function selectIssueCheckout(candidates: IssueProjectRef[], explicit?: string): IssueProjectRef | undefined {
  if (explicit !== undefined) return candidates.find(project => project.cwd === explicit);
  return candidates.length === 1 ? candidates[0] : undefined;
}
