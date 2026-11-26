import { reviewGitCommonDir } from "./board-github";
import { projectGithubBinding } from "./github-account-store";
import { namedGithubEnvironment } from "./github-cli";

/**
 * The environment a GitHub call in `cwd` must run with.
 *
 * A project that selected a GitHub account in Settings → Integrations gets that account's token in
 * `GH_TOKEN`, so the call goes through it whichever account `gh` has active globally. A project
 * without a selection keeps `env` unchanged. A selected account whose token cannot be read is an
 * error, never a silent fallback to another account.
 */
export async function projectGithubEnvironment(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const commonDir = await reviewGitCommonDir(cwd);
  const login = commonDir ? projectGithubBinding(commonDir)?.login : null;
  return login ? namedGithubEnvironment(cwd, login, env) : env;
}

/** Command groups that call `gh` for the project in the working directory. */
const GITHUB_COMMANDS = new Set(["review", "flow", "shell", "ci", "conform"]);

/**
 * Make this process's own `gh` calls go through the project's selected account. A token the caller
 * already exported is theirs and stays. A selected account that cannot be read warns on stderr and
 * leaves the environment as it is, so commands that never reach GitHub keep working.
 */
export async function applyProjectGithubAccount(args: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [command, sub] = args;
  // `review accounts` manages the binding itself, and `review state` only reads and writes the local review record:
  // neither calls gh, so neither waits on the account store or `gh auth token`.
  if (!command || !GITHUB_COMMANDS.has(command) || (command === "review" && (sub === "accounts" || sub === "state"))) return;
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return;
  try {
    const bound = await projectGithubEnvironment(cwd, env);
    if (bound.GH_TOKEN) env.GH_TOKEN = bound.GH_TOKEN;
  } catch (error) {
    console.error(`keryx: this project's GitHub account is unavailable, so gh uses its active account. ${error instanceof Error ? error.message : ""}`.trim());
  }
}
