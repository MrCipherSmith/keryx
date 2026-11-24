import path from "node:path";
import { parseArgs } from "node:util";
import { withFileLock } from "../lib/fs";
import { keryxDataDir } from "../lib/config-dir";
import { boardGraphql, reviewGitCommonDir, reviewGitEnvironment, reviewRepositories, selectRepository } from "../review/board-github";
import { claimProjectGithubAccountIntent, projectGithubBinding } from "../review/github-account-store";
import { listGithubAccounts, namedGithubEnvironment, validGithubLogin } from "../review/github-cli";
import { projectGithubEnvironment } from "../review/project-github-env";
import { beginWatcherOperation, changeProjectGithubBinding, readWatcher } from "../review/watcher";
import { mainCheckout } from "../review/watcher-project";
import { reconcileWatcherTimer, watcherLabel } from "../review/watch-launchd";

export const ACCOUNTS_USAGE = `keryx review accounts list --json
  keryx review accounts project --json
  keryx review accounts bind (--login LOGIN [--repo owner/name] | --skip) --json
  keryx review accounts env --json   (the selected account's GH_TOKEN, for Desktop terminals)`;

interface ProjectGithubAccount {
  eligible: boolean;
  login: string | null;
  configured: boolean;
}

export async function readProjectGithubAccount(cwd: string): Promise<ProjectGithubAccount> {
  const commonDir = await reviewGitCommonDir(cwd);
  if (!commonDir) return { eligible: false, login: null, configured: false };
  const repositories = await reviewRepositories(cwd);
  const binding = projectGithubBinding(commonDir);
  return { eligible: repositories.length > 0, login: binding?.login ?? null, configured: !!binding };
}

export async function bindProjectGithubAccount(
  cwd: string, login: string | null, requested?: string,
): Promise<ProjectGithubAccount> {
  const order = beginWatcherOperation();
  const commonDir = await reviewGitCommonDir(cwd);
  if (!commonDir) throw new Error("configuration: Open a Git project to connect GitHub.");
  claimProjectGithubAccountIntent(commonDir, order);
  const repo = selectRepository(await reviewRepositories(cwd), requested);
  if (login !== null) {
    const [owner, name] = repo.split("/") as [string, string];
    const env = await namedGithubEnvironment(cwd, login, process.env);
    const data = await boardGraphql<{ viewer?: { login?: string }; repository?: { id?: string } | null }>(
      cwd, "query($owner:String!, $name:String!) { viewer { login } repository(owner:$owner,name:$name) { id } }",
      { owner, name }, { login, env },
    );
    if (data.viewer?.login?.toLowerCase() !== login.toLowerCase() || !data.repository?.id)
      throw new Error(`access: Check that @${login} is connected and has access to this repository.`);
    login = data.viewer.login;
  }
  const project = await mainCheckout(cwd, reviewGitEnvironment());
  const stopped = changeProjectGithubBinding(commonDir, project, login, order);
  // Watcher state already prevents a stale timer from claiming work. Clean up
  // the timer as well, without tearing down a watcher explicitly re-enabled later.
  await Promise.allSettled(stopped.map(async (key) => {
    const lock = path.join(keryxDataDir(), "review-watch", watcherLabel(project, key) + ".lock");
    await withFileLock(lock, async () => {
      if (readWatcher(project, key).state === "paused") await reconcileWatcherTimer(project, key, {});
    });
  }));
  return readProjectGithubAccount(cwd);
}

export async function runReviewAccounts(args: string[], cwd = process.cwd()): Promise<void> {
  const [action, ...flags] = args;
  if (!action || action === "--help" || action === "-h") {
    console.log(ACCOUNTS_USAGE);
    return;
  }
  if (action !== "list" && action !== "project" && action !== "bind" && action !== "env") throw new Error(ACCOUNTS_USAGE);
  const { values } = parseArgs({ args: flags, allowPositionals: false, options: {
    json: { type: "boolean" }, login: { type: "string" }, skip: { type: "boolean" }, repo: { type: "string" },
  } });
  if (!values.json) throw new Error(ACCOUNTS_USAGE);
  if (action === "env") {
    if (values.login !== undefined || values.skip || values.repo !== undefined) throw new Error(ACCOUNTS_USAGE);
    const account = await readProjectGithubAccount(cwd);
    const token = account.login ? (await projectGithubEnvironment(cwd, process.env)).GH_TOKEN : undefined;
    console.log(JSON.stringify({ login: account.login, env: token ? { GH_TOKEN: token } : {} }));
    return;
  }
  if (action !== "bind") {
    if (values.login !== undefined || values.skip || values.repo !== undefined) throw new Error(ACCOUNTS_USAGE);
    console.log(JSON.stringify(action === "list" ? { accounts: await listGithubAccounts(cwd) } : await readProjectGithubAccount(cwd)));
    return;
  }
  if (values.skip ? values.login !== undefined || values.repo !== undefined : !validGithubLogin(values.login))
    throw new Error(ACCOUNTS_USAGE);
  console.log(JSON.stringify(await bindProjectGithubAccount(cwd, values.login ?? null, values.repo)));
}
