import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import type { WatcherKey } from "./watcher-types";
import { realpath } from "node:fs/promises";
import { isNotFound } from "../lib/fs";
import { boardGraphql, projectGithubConnection, reviewRepositories, reviewTool } from "./board-github";

const exec = promisify(execFile);

export function watcherDiscoveryEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: homedir(),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
}

/** At installation the inherited PATH is still untrusted. macOS supplies Git at this absolute path. */
export async function watcherWorktrees(cwd: string): Promise<string[]> {
  const { stdout } = await exec("/usr/bin/git", ["worktree", "list", "--porcelain", "-z"], {
    cwd, env: watcherDiscoveryEnvironment(), timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  }).catch(error => { throw new Error("configuration: Could not verify the project's worktrees with system Git.", { cause: error }); });
  const roots: string[] = [];
  for (const record of stdout.split("\0\0")) {
    const first = record.split("\0", 1)[0];
    if (!first?.startsWith("worktree ")) continue;
    const location = first.slice("worktree ".length);
    if (!isAbsolute(location)) throw new Error("configuration: Git returned an invalid worktree path.");
    try {
      roots.push(await realpath(location));
    } catch (error) {
      // A removed worktree cannot contribute a PATH entry.
      if (!roots.length || !isNotFound(error)) throw error;
    }
  }
  if (!roots.length) throw new Error("configuration: Could not determine the primary checkout.");
  return roots;
}

/** A worktree-scoped remote can live outside the primary checkout that owns the schedule. */
export async function resolveWatcherCheckout(projectRoot: string, repo: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const matches = async (cwd: string) =>
    (await reviewRepositories(cwd, env)).some((candidate) => candidate.toLowerCase() === repo.toLowerCase());
  if (await matches(projectRoot)) return projectRoot;
  const projectGit = await resolveGitCommonDir(projectRoot, env);
  let worktrees: string;
  try {
    const { stdout } = await exec(reviewTool("git", env), ["worktree", "list", "--porcelain", "-z"], {
      cwd: projectRoot, env,
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
      (await resolveGitCommonDir(cwd, env)) !== projectGit
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
    const { stdout } = await exec(reviewTool("git", env), ["worktree", "list", "--porcelain", "-z"], {
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
  const cwd = await resolveWatcherCheckout(project, key.repo, env);
  const [owner, name] = key.repo.split("/");
  const auth = await projectGithubConnection(cwd, env, key.viewer);
  const data = await boardGraphql<{ viewer?: { login: string }; repository?: { id: string } }>(
    cwd,
    "query($owner:String!, $name:String!) { viewer { login } repository(owner:$owner,name:$name) { id } }",
    { owner: owner!, name: name! },
    auth,
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
