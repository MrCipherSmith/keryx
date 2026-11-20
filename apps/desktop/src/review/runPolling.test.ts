import { expect, test } from "bun:test";
import type { reviewRun } from "../platform/reviewRuns";
import { readRunStatus } from "./runPolling";

test("a rate-limited PR pauses automatic status requests across PRs for that viewer until explicit recovery", async () => {
  const key = { number: 1, repo: "owner/repo", repositoryId: "repo-id", viewer: "Viewer" };
  let requests = 0;
  const invoke: typeof reviewRun = async () => {
    if (++requests === 1) throw new Error("unavailable: GitHub rate limit reached");
    return { version: 1, runs: [] };
  };
  const error = await readRunStatus(invoke, "/project", key).catch((cause: Error) => cause.message);
  expect(error).toContain("rate limit");
  expect(await readRunStatus(invoke, "/project", {...key, number: 2, viewer: "viewer"}, undefined, true)).toBeUndefined();
  expect(requests).toBe(1);
  expect((await readRunStatus(invoke, "/project", {...key, viewer: "another"}, undefined, true))?.runs).toEqual([]);
  expect((await readRunStatus(invoke, "/project", key))?.runs).toEqual([]);
  expect((await readRunStatus(invoke, "/project", key, undefined, true))?.runs).toEqual([]);
});
