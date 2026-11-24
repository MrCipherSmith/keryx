import { createHash } from "node:crypto";
import { namedGithubEnvironment, validGithubLogin } from "../review/github-cli";
import type { IssueViewer } from "./issues-contract";

export const API = "https://api.github.com";
export const denied = "access: The issue or project is unavailable to this GitHub account.";
const invalidResponse = "unavailable: GitHub returned an unexpected Issues response. Refresh and retry.";
export const invalidInput = "configuration: Invalid Issues request.";
/** GitHub's 410 Gone on a repository's issues: Issues are turned off there (the default on a fork). */
export const issuesDisabled = "configuration: GitHub has Issues turned off for this repository.";
export type FetchIssues = (url: URL, options: RequestInit) => Promise<Response>;

function failure(response: Response, diagnostic: string): Error {
  if (response.status === 410) return new Error(issuesDisabled);
  if (
    response.status === 401 ||
    response.status === 404 ||
    /FORBIDDEN|NOT_FOUND|INSUFFICIENT_SCOPES|not accessible|permission|could not resolve/i.test(diagnostic)
  )
    return new Error(denied);
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") ||
    /rate.limit|RATE_LIMITED/i.test(diagnostic)
  ) {
    const wait = response.headers.get("retry-after");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const time = wait && /^\d+$/.test(wait) ? Date.now() + Number(wait) * 1000 : reset * 1000;
    const retry =
      Number.isFinite(time) && time > 0 && time < 8.64e15
        ? " Retry after " + new Date(time).toISOString() + "."
        : "";
    return new Error("rate-limit: GitHub request limit reached." + retry);
  }
  if (response.status === 403) return new Error(denied);
  return new Error(invalidResponse);
}

/** The only bearer-token egress. Cursors cannot inject a destination, redirect, or headers. */
export class IssueGithub {
  constructor(
    private readonly token: string,
    private readonly fetcher: FetchIssues = fetch,
  ) {}

  private async request(url: URL, body?: string) {
    if (url.origin !== API || url.username || url.password) throw new Error(invalidInput);
    const headers: Record<string, string> = {
      Authorization: "Bearer " + this.token,
      Accept: "application/vnd.github+json",
      "User-Agent": "keryx-issues",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        ...(body === undefined ? {} : { method: "POST", body }),
      });
      text = await response.text();
    } catch {
      throw new Error("offline: Could not reach GitHub. Check the connection and refresh.");
    }
    if (!response.ok) throw failure(response, text);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(invalidResponse);
    }
    return { json, response };
  }

  async rest<T>(url: URL): Promise<{ data: T; link: string }> {
    const { json, response } = await this.request(url);
    return { data: json as T, link: response.headers.get("link") ?? "" };
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { json, response } = await this.request(new URL("/graphql", API), JSON.stringify({ query, variables }));
    const { data, errors } = json as { data?: T; errors?: unknown[] };
    if (errors?.length || !data) throw failure(response, JSON.stringify(errors));
    return data;
  }
}

export interface IssueAccount {
  viewer: IssueViewer;
  api: IssueGithub;
}

export async function authenticatedAccount(login: string, api: IssueGithub): Promise<IssueAccount> {
  if (!validGithubLogin(login)) throw new Error(invalidInput);
  const { data } = await api.rest<{ login: string; node_id: string }>(new URL("/user", API));
  if (data.login?.toLowerCase() !== login.toLowerCase() || !data.node_id) throw new Error(denied);
  return { viewer: { host: "github.com", login: data.login, nodeId: data.node_id }, api };
}

export async function connectIssueAccount(cwd: string, login: string): Promise<IssueAccount> {
  const env = await namedGithubEnvironment(cwd, login, process.env);
  return authenticatedAccount(login, new IssueGithub(env.GH_TOKEN!));
}

export function cursorScope(viewer: IssueViewer, ...filter: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([viewer.host, viewer.nodeId, ...filter]))
    .digest("base64url");
}

export function scopedCursor(scope: string, next: string | null): string | null {
  return next ? scope + "." + Buffer.from(next).toString("base64url") : null;
}

export function readCursor(scope: string, raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string" || raw.length > 12000 || !raw.startsWith(scope + "."))
    throw new Error("configuration: Refresh before loading the next page.");
  const encoded = raw.slice(scope.length + 1);
  if (!/^[\w-]+$/.test(encoded)) throw new Error(invalidInput);
  return Buffer.from(encoded, "base64url").toString("utf8");
}
