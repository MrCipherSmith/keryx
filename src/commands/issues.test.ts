import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { authenticatedAccount, IssueGithub } from "../integrations/issues-github";
import { fixtureGitEnv, isolateGitDiscovery } from "../review/test-git-fixture";
import { issuesCommand } from "./issues";

test("AC13 `keryx issues list` lists the repository of the project it runs in", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "issues-command-"));
  const restore = isolateGitDiscovery();
  const requests: string[] = [];
  const logins: string[] = [];
  const written: string[] = [];
  const write = process.stdout.write;
  try {
    const env = fixtureGitEnv();
    execFileSync("git", ["init", "--quiet"], { cwd, env });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/org/base.git"], { cwd, env });
    const api = new IssueGithub("test-token", async (url) => {
      if (url.pathname === "/user") return Response.json({ login: "viewer", node_id: "U_v" });
      requests.push(url.pathname);
      return Response.json([]);
    });
    const connect = async (_cwd: string, login: string) => {
      logins.push(login);
      return authenticatedAccount(login, api);
    };
    process.stdout.write = ((chunk: string, done?: (error?: Error | null) => void) => {
      written.push(String(chunk));
      done?.();
      return true;
    }) as typeof process.stdout.write;
    await issuesCommand(["list", "--login", "viewer", "--request", JSON.stringify({ source: "repository" }), "--json"], cwd, connect);
  } finally {
    process.stdout.write = write;
    restore();
    await rm(cwd, { recursive: true, force: true });
  }
  expect(logins).toEqual(["viewer"]);
  expect(requests).toEqual(["/repos/org/base/issues"]);
  expect(JSON.parse(written.join(""))).toMatchObject({ viewer: { login: "viewer" }, items: [], nextCursor: null });
});
