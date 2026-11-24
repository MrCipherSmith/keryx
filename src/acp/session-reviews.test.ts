import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeskRunStore } from "../review/desk-run-store";
import type { DeskRun, DeskRunKey } from "../review/desk-run-types";
import { recordSessionReviewRequest, sessionReviewSummaries, sessionReviewsTool } from "./session-reviews";

const key: DeskRunKey = { repo: "org/repo", repositoryId: "r", viewer: "operator", number: 13 };
const run: DeskRun = {
  id: "attempt", source: "manual", sessionId: "origin", baseSha: "b".repeat(40), headSha: "a".repeat(40),
  state: "completed", phase: "Report ready", reason: "", createdAt: "", startedAt: "", finishedAt: "",
  result: { reviewed: null, verdict: null, coverage: "complete", findings: { blocker: 0, major: 0, minor: 0, info: 0 }, report: "x".repeat(20_000) },
};

test("review metadata presents the original session and exact pinned attempt without exposing the report", () => {
  expect(sessionReviewSummaries([{ key, run }], "origin")).toEqual([{
    id: "attempt", sessionId: "origin", key, revision: { baseSha: run.baseSha, headSha: run.headSha },
  }]);
});

test("the ordinary session tool reads live review progress and bounds untrusted report text", async () => {
  let current: DeskRun = { ...run, state: "running", phase: "Reviewing source", result: null,
    reviewerProgress: { planned: 15, wave: 2, finished: 5, completed: 4, sessions: Array.from({ length: 35 }, (_, index) => ({
      id: String(index), reviewer: "logic", wave: 2, state: "completed",
    })) } };
  const tool = sessionReviewsTool(async () => [{ key, run: current }]);
  const active = JSON.parse((await tool.invoke({})).output)[0];
  expect(active).toMatchObject({ state: "running", phase: "Reviewing source", result: null,
    progress: { planned: 15, finished: 5, completed: 4, activityTruncated: true } });
  expect(active.progress.activity).toHaveLength(32);
  current = run;
  const result = await tool.invoke({});
  expect(result.untrusted).toBe(true);
  expect(JSON.parse(result.output)[0].result.report).toHaveLength(12_000);
  expect(JSON.parse(result.output)[0].result.reportTruncated).toBe(true);
});


test("a launch request survives reopen only under the owning chat and keeps its original text", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "keryx-review-receipt-"));
  try {
    const storeRoot = path.join(temp, "review");
    const sessionDir = path.join(temp, "account", "origin");
    await mkdir(sessionDir, { recursive: true });
    const saved = { ...run, id: "4b60dbfd-f5a4-4085-ada7-0817306c8c09", source: "session" as const };
    const store = new DeskRunStore(storeRoot);
    try {
      store.recordSession(temp, key, saved);
    } finally {
      store.close();
    }
    const prompt = "Сделай ревью https://github.com/org/repo/pull/13";
    expect(await recordSessionReviewRequest(temp, "another", sessionDir, saved.id, prompt, storeRoot)).toBeNull();
    expect(await recordSessionReviewRequest(temp, "origin", sessionDir, saved.id, prompt, storeRoot)).toBe(prompt);
    expect(await recordSessionReviewRequest(temp, "origin", sessionDir, saved.id, "Other text", storeRoot)).toBe(prompt);
    expect(sessionReviewSummaries([{ key, run: saved }], "origin", sessionDir)[0]?.prompt).toBe(prompt);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
