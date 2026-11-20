import { invoke } from "./backend";
import { errMessage } from "../lib/format";

const unsupported = "The selected Keryx CLI does not support GitHub accounts. In Settings → Desktop, choose Bundled keryx or select a compatible CLI.";

export interface GitHubAccount {
  login: string;
  active: boolean;
  state?: "success" | "error" | "timeout" | "unknown";
}

export interface ProjectGitHubAccount {
  eligible: boolean;
  configured: boolean;
  login: string | null;
}

type AccountList = { accounts: GitHubAccount[] };
let pendingList: Promise<AccountList> | undefined;

async function requestAccounts<T>(args: Record<string, unknown>, isResponse: (value: unknown) => value is T): Promise<T> {
  let response: unknown;
  try {
    response = await invoke("github_accounts", args);
  } catch (failure) {
    const message = errMessage(failure);
    if (/^unknown command:\s*(?:review|accounts)\b/i.test(message) ||
        message.startsWith("unavailable: The selected Keryx CLI did not return a valid Review response.")) {
      throw new Error(unsupported);
    }
    throw failure;
  }
  if (!isResponse(response)) throw new Error(unsupported);
  return response;
}

function isAccountList(value: unknown): value is AccountList {
  return value !== null && typeof value === "object" && "accounts" in value && Array.isArray(value.accounts)
    && value.accounts.every((account) => account && typeof account.login === "string" && typeof account.active === "boolean");
}

function isProjectAccount(value: unknown): value is ProjectGitHubAccount {
  return value !== null && typeof value === "object"
    && "eligible" in value && typeof value.eligible === "boolean"
    && "configured" in value && typeof value.configured === "boolean"
    && "login" in value && (value.login === null || typeof value.login === "string");
}

export function listGitHubAccounts(): Promise<AccountList> {
  pendingList ??= requestAccounts({ action: "list" }, isAccountList).finally(() => { pendingList = undefined; });
  return pendingList;
}

export function getProjectGitHubAccount(cwd: string): Promise<ProjectGitHubAccount> {
  return requestAccounts({ cwd, action: "project" }, isProjectAccount);
}

export function bindProjectGitHubAccount(cwd: string, login: string | null): Promise<ProjectGitHubAccount> {
  return requestAccounts({ cwd, action: "bind", ...(login ? { login } : { skip: true }) }, isProjectAccount);
}
