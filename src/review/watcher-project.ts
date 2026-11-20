import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import type { WatcherKey } from "./watcher-types";
import { realpath } from "node:fs/promises";
import { boardGraphql, reviewRepositories } from "./board-github";

const exec = promisify(execFile);

/** A worktree-scoped remote can live outside the primary checkout that owns the schedule. */
export async function resolveWatcherCheckout(projectRoot: string, repo: string): Promise<string> {
  const matches = async (cwd: string) =>
    (await reviewRepositories(cwd)).some((candidate) => candidate.toLowerCase() === repo.toLowerCase());
  if (await matches(projectRoot)) return projectRoot;
  const projectGit = await resolveGitCommonDir(projectRoot);
  let worktrees: string;
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: projectRoot,
      timeout: 10_000,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    worktrees = stdout;
  } catch {
    throw new Error("configuration: Could not inspect the project's linked worktrees.");
  }
  // NUL field and record separators preserve valid paths containing newlines.
  for (const record of worktrees.split("\0\0")) {
    const fields = record.split("\0");
    const location = fields[0];
    if (
      !location?.startsWith("worktree ") ||
      fields.some((field) => field === "bare" || field.startsWith("prunable"))
    )
      continue;
    const cwd = location.slice("worktree ".length);
    if (
      cwd === projectRoot ||
      !isAbsolute(cwd) ||
      !projectGit ||
      (await resolveGitCommonDir(cwd)) !== projectGit
    )
      continue;
    try {
      if (await matches(cwd)) return cwd;
    } catch {
      // An unmounted or concurrently removed worktree must not hide a valid later candidate.
    }
  }
  throw new Error(
    "configuration: The selected GitHub repository is no longer connected to this project's worktrees.",
  );
}

export async function mainCheckout(cwd: string, env?: NodeJS.ProcessEnv) {
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd,
      env,
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const first = stdout.split("\0", 1)[0]!;
    if (first.startsWith("worktree ")) return await realpath(first.slice("worktree ".length));
  } catch {
    /* A removed Git remote or a missing Git installation must still allow a local pause. */
  }
  return realpath(cwd);
}

export async function verifyIdentity(project: string, key: WatcherKey, env?: NodeJS.ProcessEnv) {
  const cwd = await resolveWatcherCheckout(project, key.repo);
  const [owner, name] = key.repo.split("/");
  const data = await boardGraphql<{ viewer?: { login: string }; repository?: { id: string } }>(
    cwd,
    "query($owner:String!, $name:String!) { viewer { login } repository(owner:$owner,name:$name) { id } }",
    { owner: owner!, name: name! },
    env,
  );
  if (
    data.viewer?.login?.toLowerCase() !== key.viewer.toLowerCase() ||
    data.repository?.id !== key.repositoryId
  ) {
    throw new Error("access: The current gh account or repository changed. Refresh Review.");
  }
}

export function parseWatcherKey(v: {repo?: string | undefined; viewer?: string | undefined; "repository-id"?: string | undefined}) {
  let key: WatcherKey | undefined;
  const id = v["repository-id"];
  if (id !== undefined || v.repo !== undefined || v.viewer !== undefined) {
    if (
      !id ||
      !/^[A-Za-z0-9_=:.-]{1,160}$/.test(id) ||
      !v.repo ||
      !/^[a-z0-9-]+\/[\w.-]+$/i.test(v.repo) ||
      !v.viewer ||
      !/^[a-z\d][a-z\d_.-]*(?:\[bot\])?$/i.test(v.viewer)
    )
      throw new Error("configuration: Invalid Review repository identity.");
    key = { repo: v.repo, repositoryId: id, viewer: v.viewer };
  }
  return key;
}
