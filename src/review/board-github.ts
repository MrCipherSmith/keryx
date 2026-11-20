import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import { projectGithubBinding } from "./github-account-store";
import { watcherTransaction } from "./watcher-db";
import { namedGithubEnvironment, reviewCommandOptions, reviewTool, withoutGithubCredentials } from "./github-cli";
export { reviewTool } from "./github-cli";

const projectNotConnected = "access: Choose a GitHub account in Project Settings.";

// Each board PR has up to two independent people connections. Four parents keep
// that page at eight parallel gh workers, with cursors within a connection still sequential.
export const OVERFLOW_PARENTS = 4;

const exec = promisify(execFile);
/** Extract only owner/name. Remotes may include credentials; never return or log their full URL. */
function githubRemote(raw: string): string | undefined {
  const scp = /^git@github\.com:(.+)$/i.exec(raw);
  let pathname = scp?.[1];
  if (!pathname) {
    try {
      const url = new URL(raw);
      if (url.hostname.toLowerCase() !== "github.com" || !["ssh:", "http:", "https:", "git:"].includes(url.protocol)) return;
      pathname = url.pathname.slice(1);
    } catch { return; }
  }
  const repo = pathname.replace(/\/?$/, "").replace(/\.git$/i, "");
  return /^[a-z0-9-]+\/[\w.-]+$/i.test(repo) ? repo : undefined;
}

export function configuredRepositories(remotes: string): string[] {
  const choices = new Map<string, string>();
  for (const row of remotes.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(row.trim());
    if (!match) continue;
    const repo = githubRemote(match[2]!);
    if (repo) choices.set(match[1]!, repo);
  }
  const origin = choices.get("origin");
  return [...new Set([...(origin ? [origin] : []), ...choices.values()])];
}

export function selectRepository(repositories: string[], requested?: string): string {
  if (!repositories.length) throw new Error("configuration: This project has no GitHub.com fetch remote.");
  if (!requested) return repositories[0]!;
  const selected = repositories.find((repo) => repo.toLowerCase() === requested.toLowerCase());
  if (!selected) throw new Error("configuration: Choose a GitHub repository connected to this project.");
  return selected;
}

export function reviewGitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withoutGitDiscoveryOverrides(withoutGithubCredentials(env));
}

export function reviewGitCommonDir(cwd: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  reviewTool("git", env); // Retain the timer's executable pin before resolving the shared directory.
  return resolveGitCommonDir(cwd, reviewGitEnvironment(env));
}

export async function reviewRepositories(cwd: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const git = reviewTool("git", env);
  try {
    const { stdout } = await exec(git, ["remote", "-v"], reviewCommandOptions(cwd, reviewGitEnvironment(env)));
    return configuredRepositories(stdout);
  } catch {
    throw new Error("configuration: Open a Git project with a GitHub.com remote.");
  }
}

function githubFailure(diagnostic: string, login: string | null): Error {
  if (/rate limit|too many requests|HTTP 429/i.test(diagnostic)) {
    return new Error("unavailable: GitHub rate limit reached. Refresh after the limit resets.");
  }
  if (/HTTP (?:401|403|404)|forbidden|not authorized|bad credentials|authenticate|auth login|not logged|could not resolve to a repository|not accessible|authentication|not found in the repository/i.test(diagnostic)) {
    return new Error(login
      ? `access: Check that @${login} is connected in Settings → Integrations and has access to this repository.`
      : "access: Check the active gh account and its access to this repository.");
  }
  return new Error("unavailable: Could not read from GitHub. Check the connection and refresh.");
}

export interface GithubConnection {
  login: string | null;
  env: NodeJS.ProcessEnv;
  binding?: { project: string; generation: number | null };
}

export function withCurrentGithubBinding<T>(connection: GithubConnection, useConnection: () => T): T {
  if (!connection.binding) return useConnection();
  const { project, generation } = connection.binding;
  return watcherTransaction((db) => {
    if ((projectGithubBinding(project, db)?.generation ?? null) !== generation)
      throw new Error("access: The project's GitHub account changed. Refresh Review.");
    return useConnection();
  });
}

export function verifyGithubBindingUnchanged(connection: GithubConnection): void {
  withCurrentGithubBinding(connection, () => undefined);
}

export async function projectGithubConnection(
  cwd: string, env: NodeJS.ProcessEnv = process.env, expectedViewer?: string,
): Promise<GithubConnection> {
  const project = await reviewGitCommonDir(cwd, env);
  if (!project) throw new Error("configuration: Open a Git project to connect GitHub.");
  const binding = projectGithubBinding(project);
  if (binding?.login === null) throw new Error(projectNotConnected);
  const login = binding?.login ?? null;
  if (login && expectedViewer && login.toLowerCase() !== expectedViewer.toLowerCase())
    throw new Error("access: The project's GitHub account changed. Refresh Review.");
  return { login, env: login ? await namedGithubEnvironment(cwd, login, env) : env,
    binding: { project, generation: binding?.generation ?? null } };
}

export async function boardGh(
  cwd: string, args: string[], connection?: GithubConnection, timeout = 18_000,
): Promise<string> {
  const auth = connection ?? await projectGithubConnection(cwd);
  const gh = reviewTool("gh", auth.env);
  let output: string;
  try {
    output = (await exec(gh, args, { ...reviewCommandOptions(cwd, auth.env), timeout })).stdout;
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: string; stdout?: string };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      // eslint-disable-next-line preserve-caught-error -- The subprocess error can contain private response bodies.
      throw new Error("unavailable: GitHub page exceeds the reader output limit.");
    }
    if (failure.code === "ENOENT") {
      // eslint-disable-next-line preserve-caught-error -- The subprocess error can contain private request arguments.
      throw new Error("configuration: Install GitHub CLI (gh) and sign in.");
    }
    // Command errors may include private URLs, tokens or full queries. Expose fixed diagnostics only.
    throw githubFailure(failure.stderr ?? "", auth.login);
  }
  verifyGithubBindingUnchanged(auth);
  return output;
}

export async function boardGraphql<T>(
  cwd: string, query: string, variables: Record<string, string | number>, connection?: GithubConnection,
): Promise<T> {
  const args = ["api", "--hostname", "github.com", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  const auth = connection ?? await projectGithubConnection(cwd);
  const raw = await boardGh(cwd, args, auth);
  let response: { data?: T; errors?: { message?: string }[] };
  try {
    response = JSON.parse(raw);
  } catch {
    throw new Error("unavailable: GitHub returned an unreadable response.");
  }
  if (!response?.data || response.errors?.length) {
    throw githubFailure(response?.errors?.map((entry) => entry.message ?? "").join(" ") ?? "", auth.login);
  }
  const viewer = (response.data as { viewer?: { login?: string } | null }).viewer;
  if (auth.login && viewer !== undefined && viewer?.login?.toLowerCase() !== auth.login.toLowerCase())
    throw new Error(`access: Reconnect @${auth.login} in Settings → Integrations.`);
  return response.data;
}
