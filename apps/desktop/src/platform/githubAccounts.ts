import { invoke } from "./backend";

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

export function listGitHubAccounts(): Promise<{ accounts: GitHubAccount[] }> {
  return invoke("github_accounts", { action: "list" });
}

export function getProjectGitHubAccount(cwd: string): Promise<ProjectGitHubAccount> {
  return invoke("github_accounts", { cwd, action: "project" });
}

export function bindProjectGitHubAccount(cwd: string, login: string | null): Promise<ProjectGitHubAccount> {
  return invoke("github_accounts", { cwd, action: "bind", ...(login ? { login } : { skip: true }) });
}
