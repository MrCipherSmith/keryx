import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const githubCredentials = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_DEBUG"]);

export function withoutGithubCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !githubCredentials.has(name)));
}

export function reviewCommandOptions(cwd: string, env: NodeJS.ProcessEnv) {
  return {
    cwd, encoding: "utf8" as const, timeout: 18_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
  };
}

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

export function validGithubLogin(login: unknown): login is string {
  return typeof login === "string" && /^[a-z\d][a-z\d_-]{0,99}$/i.test(login);
}

async function runGhAuth(cwd: string, args: string[], env: NodeJS.ProcessEnv, message: string): Promise<string> {
  const gh = reviewTool("gh", env);
  try {
    return (await exec(gh, ["auth", ...args], reviewCommandOptions(cwd, withoutGithubCredentials(env)))).stdout;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    // eslint-disable-next-line preserve-caught-error -- Auth subprocess errors can include credentials.
    throw new Error(missing ? "configuration: Install GitHub CLI (gh) and sign in." : message);
  }
}

export async function namedGithubEnvironment(cwd: string, login: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (!validGithubLogin(login)) throw new Error("configuration: Choose a valid GitHub account.");
  const unavailable = `access: Reconnect @${login} in Settings → Integrations.`;
  const raw = await runGhAuth(cwd, ["token", "--hostname", "github.com", "--user", login], env, unavailable);
  const token = raw.trim();
  if (!/^[A-Za-z0-9_=-]{12,512}$/.test(token)) throw new Error(unavailable);
  return { ...withoutGithubCredentials(env), GH_TOKEN: token };
}

interface GithubAccount {
  login: string;
  active: boolean;
  state: "success" | "error" | "timeout" | "unknown";
}

export async function listGithubAccounts(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<GithubAccount[]> {
  const raw = await runGhAuth(cwd, ["status", "--hostname", "github.com", "--json", "hosts", "--jq",
    '(.hosts["github.com"] // []) | map({login,active,state})'], env, "unavailable: Could not list accounts. Check that GitHub CLI supports multiple accounts.");
  let rows: unknown;
  try { rows = JSON.parse(raw); }
  catch { throw new Error("unavailable: GitHub CLI returned an unreadable account list."); }
  if (!Array.isArray(rows)) throw new Error("unavailable: GitHub CLI returned an unreadable account list.");
  const accounts = new Map<string, GithubAccount>();
  for (const row of rows) {
    if (!validGithubLogin(row?.login) || typeof row.active !== "boolean") continue;
    const { login, active } = row;
    const state = row.state === "success" || row.state === "error" || row.state === "timeout" ? row.state : "unknown";
    accounts.set(login.toLowerCase(), { login, active, state });
  }
  return [...accounts.values()];
}
