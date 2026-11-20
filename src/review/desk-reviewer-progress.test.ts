import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventTail } from "./autonomous-progress";
import { readDeskReviewerProgress } from "./desk-reviewer-progress";
import { ReviewerActivityRecorder } from "./reviewer-activity";
import type { DeskRun } from "./desk-run-types";

const key = { repo: "org/example", repositoryId: "R1", viewer: "dev", number: 18 };
const ref = "https://github.com/org/example/pull/18";
const baseSha = "a".repeat(40), headSha = "b".repeat(40);
const run: DeskRun = {
  id: randomUUID(), source: "scheduled", baseSha, headSha, state: "running",
  phase: "Reviewing", reason: "", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null,
};
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "desk-sessions-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
function save(parts: string[], content: unknown) {
  const file = path.join(directory, ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

test("projects bounded host activity and idempotent request receipts into the selected attempt", () => {
  const recorder = new ReviewerActivityRecorder();
  const sessionId = randomUUID(), at = "2026-08-03T09:34:01.002Z";
  const activity = { type: "reviewer_activity", reviewer: "review-logic", wave: 2, at, sessionId };
  const receipt = { type: "request_usage", participant: "reviewer", sessionId, reviewer: "review-logic",
    requestId: "r1", model: "gpt-model", provider: "openai-codex", usage: { inputTokens: 5, outputTokens: 2 } };
  const lines = [{ ...activity, activity: "started" }, receipt, receipt,
    ...Array.from({ length: 30 }, () => ({ ...activity, activity: "tool_start", tool: "read_file", input: "PRIVATE_INPUT" })),
    { ...activity, activity: "tool_end", tool: "read_file", output: "PRIVATE_OUTPUT", ok: false },
    { type: "assistant", text: "PRIVATE_TEXT" }];
  const file = path.join(directory, "events.ndjson");
  writeFileSync(file, lines.map(row => JSON.stringify(row)).join("\n") + "\n");
  const reader = createEventTail(file, e => recorder.observe(e));
  reader.poll();
  reader.poll();
  save(["run", "progress.json"], { ref, reviewerSessions: recorder.sessions() });
  const detail = readDeskReviewerProgress(directory, key, run, true);
  expect(detail).toMatchObject({ planned: null, finished: 0, wave: 2, sessions: [{ id: sessionId,
    startedAt: at, state: "running", truncated: true, model: "gpt-model", usage: { totalTokens: 7 } }] });
  expect(detail?.sessions[0]?.activity).toHaveLength(24);
  expect(detail?.sessions[0]?.activity?.at(-1)?.label).toBe("read_file failed");
  expect(JSON.stringify(detail)).not.toContain("PRIVATE");
  expect(readDeskReviewerProgress(directory, key, run, false)?.sessions[0]?.activity).toBeUndefined();
  recorder.observe({ ...activity, activity: "finished", outcome: "cancelled" });
  save(["run", "progress.json"], { ref, reviewerSessions: recorder.sessions() });
  expect(readDeskReviewerProgress(directory, key, run, true)).toMatchObject({ finished: 1, sessions: [{ state: "cancelled", finishedAt: at }] });
});

test("uses saved results for legacy waves only within the verified revision and never follows a linked raw result", () => {
  const calls = [1, 2].map(n => ({ label: "review-logic", save_result_to: `raw/review-logic-w${n}.txt`,
    expected_model: { provider: "openai-codex", model: "gpt-model" } }));
  save(["package", "manifest.json"], { target: { ref, base: baseSha, head: headSha } });
  save(["package", "desktop-dispatch.json"], { calls });
  const raw = 'REVIEW_RESULT:\n```json\n{"status":"DONE","reviewer":"review-logic","summary":"PRIVATE"}\n```\nKERYX_USAGE {"by":"host","tokens_in":7,"tokens_out":4}\n';
  save(["package", "raw", "review-logic-w1.txt"], raw);
  symlinkSync(path.join(directory, "package/raw/review-logic-w1.txt"), path.join(directory, "package/raw/review-logic-w2.txt"));
  const result = readDeskReviewerProgress(directory, key, { ...run, state: "partial" }, true);
  expect(result).toMatchObject({ planned: 2, finished: 1, wave: 1, sessions: [
    { state: "completed", wave: 1, usage: { totalTokens: 11 }, activity: [{ label: "Reviewer result saved" }] },
    { state: "unknown", wave: 2 },
  ] });
  expect(result?.sessions[0]?.finishedAt).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(readDeskReviewerProgress(directory, key, { ...run, headSha: baseSha }, true)).toBeUndefined();
  expect(readDeskReviewerProgress(directory, key, { ...run, source: "existing" }, true)).toBeUndefined();
});

test("retry sessions do not enlarge the assignment plan or finish an active retry", () => {
  const reviewer = "review-logic";
  const pair = { reviewer, wave: 1 };
  const calls = [1, 2].map(wave => ({ label: reviewer, save_result_to: `raw/${reviewer}-w${wave}.txt` }));
  save(["package", "manifest.json"], { target: { ref, base: baseSha, head: headSha } });
  save(["package", "desktop-dispatch.json"], { calls });
  const sessions = [
    { ...pair, id: randomUUID(), state: "failed" },
    { ...pair, id: randomUUID(), state: "running" },
  ];
  save(["run", "progress.json"], { ref, reviewerSessions: sessions });
  expect(readDeskReviewerProgress(directory, key, run, true)).toMatchObject({
    planned: 2, finished: 0, sessions: [{ state: "failed" }, { state: "running" }, { state: "planned" }],
  });
  sessions[1]!.state = "completed";
  save(["run", "progress.json"], { ref, reviewerSessions: sessions });
  expect(readDeskReviewerProgress(directory, key, run, false)).toMatchObject({ planned: 2, finished: 1 });
});

test("an unmeasured request keeps an interrupted reviewer's measured usage partial", () => {
  const recorder = new ReviewerActivityRecorder();
  const sessionId = randomUUID();
  const reviewer = "review-logic";
  const at = "2026-08-03T09:34:01.002Z";
  const activity = { type: "reviewer_activity", reviewer, wave: 1, at, sessionId };
  const request = { participant: "reviewer", sessionId, reviewer };
  recorder.observe({ ...activity, activity: "started" });
  recorder.observe({ ...request, type: "request_start", requestId: "one" });
  recorder.observe({ ...request, type: "request_usage", requestId: "one", usage: { inputTokens: 8, outputTokens: 1 }, partial: true });
  expect(recorder.sessions()[0]?.usagePartial).toBe(true);
  recorder.observe({ ...request, type: "request_usage", requestId: "one", usage: { inputTokens: 9, outputTokens: 2 } });
  expect(recorder.sessions()[0]?.usagePartial).toBeUndefined();
  recorder.observe({ ...request, type: "request_start", requestId: "one" });
  expect(recorder.sessions()[0]?.usagePartial).toBeUndefined();
  recorder.observe({ ...request, type: "request_start", requestId: "two" });
  recorder.observe({ ...activity, activity: "finished", outcome: "cancelled" });
  save(["run", "progress.json"], { ref, reviewerSessions: recorder.sessions() });
  const progress = readDeskReviewerProgress(directory, key, { ...run, state: "cancelled" }, true);
  expect(progress?.sessions[0]).toMatchObject({
    id: sessionId, state: "cancelled", usagePartial: true,
    usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 },
  });
});

test("preserves many simultaneous sessions and distinct retries without inventing an end time after interruption", () => {
  const sessions = Array.from({ length: 80 }, (_, i) => ({
    id: randomUUID(), reviewer: `review-${Math.floor(i / 2)}`, wave: 1, state: i % 2 ? "running" : "failed",
    activity: [{ at: "2026-08-03T09:34:01.002Z", label: "Reviewer started" }],
  }));
  save(["run", "progress.json"], { ref, reviewerSessions: [
    ...sessions, { id: randomUUID(), reviewer: "triage", wave: 1, state: "completed" },
  ] });
  save(["package", "manifest.json"], { target: { ref, base: baseSha, head: headSha } });
  save(["package", "desktop-dispatch.json"], { calls: sessions.filter((_, i) => i % 2).map(s => ({
    label: s.reviewer, save_result_to: `raw/${s.reviewer}-w1.txt`,
  })) });
  const result = readDeskReviewerProgress(directory, key, { ...run, state: "partial" }, true);
  expect(result?.planned).toBe(40);
  expect(result?.finished).toBe(0);
  expect(new Set(result?.sessions.map(s => s.id)).size).toBe(80);
  expect(result?.sessions[1]?.state).toBe("unknown");
  expect(result?.sessions[1]?.finishedAt).toBeUndefined();
  expect(readDeskReviewerProgress(directory, { ...key, number: 19 }, run, true)).toBeUndefined();
});

test("the saved result completes a uniquely observed session after interruption and leaves ambiguous retries unresolved", () => {
  const call = { label: "review-logic", save_result_to: "raw/review-logic-w1.txt" };
  save(["package", "manifest.json"], { target: { ref, base: baseSha, head: headSha } });
  save(["package", "desktop-dispatch.json"], { calls: [call] });
  save(["package", "raw", "review-logic-w1.txt"], 'REVIEW_RESULT:\n```json\n{"status":"DONE","reviewer":"review-logic","findings":[]}\n```');
  const session = { id: randomUUID(), reviewer: call.label, wave: 1, state: "running", activity: [{ at: "2026-08-03T09:34:01.002Z", label: "Reviewer started" }] };
  save(["run", "progress.json"], { ref, reviewerSessions: [session] });
  const ended = { ...run, state: "partial" as const };
  const single = readDeskReviewerProgress(directory, key, ended, true);
  expect(single).toMatchObject({ finished: 1, sessions: [{ id: session.id, state: "completed",
    activity: [{ label: "Reviewer started" }, { label: "Reviewer result saved" }] }] });
  expect(single?.sessions[0]?.finishedAt).toBeUndefined();
  save(["run", "progress.json"], { ref, reviewerSessions: [session, { ...session, id: randomUUID() }] });
  expect(readDeskReviewerProgress(directory, key, ended, true)).toMatchObject({ finished: 0, sessions: [{ state: "unknown" }, { state: "unknown" }] });
});
