import { issueDigest } from "./issue-key";
import { mapBounded } from "../lib/map-bounded";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalPath } from "../lib/clone-scope";
import { listProjects } from "../lib/project-registry";
import { reviewGitCommonDir, reviewGitEnvironment, reviewRepositories } from "../review/board-github";
import { projectGithubBinding } from "../review/github-account-store";
import type { IssueProjectRef, IssueRef, IssueViewer } from "./issues-contract";

const exec = promisify(execFile);


async function branch(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return (await exec("git", ["symbolic-ref", "--quiet", "--short", ref], {
      cwd, env: reviewGitEnvironment(), timeout: 3_000,
    })).stdout.trim() || undefined;
  } catch { return undefined; }
}

/** Registered projects plus the directory the operator explicitly opened in Desktop or Shell. */
export async function issueCheckoutCatalog(cwd: string, issues: IssueRef[]): Promise<Map<string, IssueProjectRef[]>> {
  const catalog = new Map<string, IssueProjectRef[]>();
  const repoNames = new Map(issues.filter(i => i.host.toLowerCase() === "github.com")
    .map(i => [`${i.owner}/${i.repo}`.toLowerCase(), i.repositoryId]));
  if (!repoNames.size) return catalog;
  const paths = new Map<string,string>();
  for (const entry of listProjects().filter(entry => entry.state === "active")) {
    paths.set(await canonicalPath(entry.path), entry.projectId);
  }
  const current = await canonicalPath(cwd);
  if (!paths.has(current)) paths.set(current, issueDigest(current));
  await mapBounded(Array.from(paths), 4, async ([root, projectId]) => {
    const names = await reviewRepositories(root).catch(() => []);
    const ids = names.flatMap(name => repoNames.get(name.toLowerCase()) ?? []);
    if (!ids.length) return;
    const common = await reviewGitCommonDir(root);
    if (!common) return;
    const base = (await branch(root, "refs/remotes/origin/HEAD"))?.replace(/^origin\//, "")
      ?? await branch(root, "HEAD") ?? "";
    const project = { projectId, cwd: root, cloneId: issueDigest(await canonicalPath(common)), baseBranch: base };
    for (const id of new Set(ids)) {
      const candidates = catalog.get(id);
      if (candidates) candidates.push(project); else catalog.set(id, [project]);
    }
  });
  for (const projects of catalog.values()) projects.sort((a, b) => a.cwd.localeCompare(b.cwd));
  return catalog;
}

export async function issueCheckouts(cwd: string, issue: IssueRef): Promise<IssueProjectRef[]> {
  return (await issueCheckoutCatalog(cwd, [issue])).get(issue.repositoryId) ?? [];
}

export function selectIssueCheckout(candidates: IssueProjectRef[], explicit?: string): IssueProjectRef | undefined {
  if (explicit !== undefined) return candidates.find(project => project.cwd === explicit);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function projectLoginMatches(project: string, viewer: IssueViewer): boolean {
  const binding = projectGithubBinding(project);
  return !binding || binding.login?.toLowerCase() === viewer.login.toLowerCase();
}

export async function projectIsAuthorized(project: IssueProjectRef, viewer: IssueViewer): Promise<boolean> {
  const common = await reviewGitCommonDir(project.cwd);
  return !!common && projectLoginMatches(common, viewer);
}
