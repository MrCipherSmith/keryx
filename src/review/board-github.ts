import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";

// Each board PR has up to two independent people connections. Four parents keep
// that page at eight parallel gh workers, with cursors within a connection still sequential.
export const OVERFLOW_PARENTS = 4;

const exec = promisify(execFile);
const commandOptions = (cwd: string, env: NodeJS.ProcessEnv = process.env) => ({
  cwd, encoding: "utf8" as const, timeout: 18_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
});

/** A launchd pin must still match the command on its installed PATH. */
export function reviewTool(name: "gh" | "git", env: NodeJS.ProcessEnv = process.env): string {
  const pin = env[name === "gh" ? "KERYX_REVIEW_GH_BIN" : "KERYX_REVIEW_GIT_BIN"];
  if (!pin) return name;
  const candidate = Bun.which(name, { PATH: env.PATH ?? "" });
  try {
    if (candidate && realpathSync.native(candidate) === pin) return pin;
  } catch { /* The executable may have been replaced between lookup and resolution. */ }
  throw new Error("configuration: A watcher executable moved. Select Restore timer in Desktop or enable the watcher again from the CLI.");
}

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

export async function reviewRepositories(cwd: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const git = reviewTool("git", env);
  try {
    const { stdout } = await exec(git, ["remote", "-v"], commandOptions(cwd, env));
    return configuredRepositories(stdout);
  } catch {
    throw new Error("configuration: Open a Git project with a GitHub.com remote.");
  }
}

function githubFailure(diagnostic: string): Error {
  if (/rate limit|too many requests|HTTP 429/i.test(diagnostic)) {
    return new Error("unavailable: GitHub rate limit reached. Refresh after the limit resets.");
  }
  if (/HTTP (?:401|403|404)|forbidden|not authorized|bad credentials|authenticate|auth login|not logged|could not resolve to a repository|not accessible|authentication|not found in the repository/i.test(diagnostic)) {
    return new Error("access: Check the active gh account and its access to this repository.");
  }
  return new Error("unavailable: Could not read from GitHub. Check the connection and refresh.");
}

export async function boardGh(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 18_000): Promise<string> {
  const gh = reviewTool("gh", env);
  try {
    return (await exec(gh, args, { ...commandOptions(cwd, env), timeout })).stdout;
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: string; stdout?: string };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("unavailable: GitHub page exceeds the reader output limit.", { cause: error });
    if (failure.code === "ENOENT") throw new Error("configuration: Install GitHub CLI (gh) and sign in.", { cause: error });
    // Command errors may include private URLs, tokens or full queries. Expose fixed diagnostics only.
    throw githubFailure(failure.stderr ?? "");
  }
}

export async function boardGraphql<T>(cwd: string, query: string, variables: Record<string, string | number>, env?: NodeJS.ProcessEnv): Promise<T> {
  const args = ["api", "--hostname", "github.com", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  const raw = await boardGh(cwd, args, env);
  let response: { data?: T; errors?: { message?: string }[] };
  try {
    response = JSON.parse(raw);
  } catch {
    throw new Error("unavailable: GitHub returned an unreadable response.");
  }
  if (!response?.data || response.errors?.length) {
    throw githubFailure(response?.errors?.map((entry) => entry.message ?? "").join(" ") ?? "");
  }
  return response.data;
}
