import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatorActivity, coordinatorActivityPage } from "./desk-coordinator";
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
  const raw = 'REVIEW_RESULT:\n```json\n{"status":"DONE","reviewer":"review-logic","summary":"Inspected the assignment","reasoning":"PRIVATE"}\n```\nKERYX_USAGE {"by":"host","tokens_in":7,"tokens_out":4}\n';
  save(["package", "raw", "review-logic-w1.txt"], raw);
  symlinkSync(path.join(directory, "package/raw/review-logic-w1.txt"), path.join(directory, "package/raw/review-logic-w2.txt"));
  const result = readDeskReviewerProgress(directory, key, { ...run, state: "partial" }, true);
  expect(result).toMatchObject({ planned: 2, finished: 1, wave: 1, sessions: [
    { state: "completed", wave: 1, finalOutput: "Inspected the assignment", usage: { totalTokens: 11 }, activity: [{ label: "Reviewer result saved" }] },
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

test("the pinned plan sets the total before dispatch and keeps blocked and later-wave assignments in that total", () => {
  const target = { ref, base: baseSha, head: headSha };
  save(["package", "manifest.json"], { target });
  save(["package", "plan.json"], { target, dispatches: 3 });
  expect(readDeskReviewerProgress(directory, key, run, false)).toMatchObject({ planned: 3, completed: 0 });
  const call = (wave: number) => ({ label: "review-logic", save_result_to: `raw/review-logic-w${wave}.txt` });
  save(["package", "desktop-dispatch.json"], { calls: [call(1), call(2)], blocked: [{ reviewer: "review-style" }] });
  const session = (wave: number, state: string) => ({ id: randomUUID(), reviewer: "review-logic", wave, state });
  const first = session(1, "completed");
  save(["run", "progress.json"], { ref, reviewerSessions: [first, session(2, "failed")] });
  expect(readDeskReviewerProgress(directory, key, run, false)).toMatchObject({ planned: 3, completed: 1, finished: 2 });
  save(["run", "progress.json"], { ref, reviewerSessions: [first, session(2, "failed"), session(2, "completed")] });
  expect(readDeskReviewerProgress(directory, key, run, false)).toMatchObject({ planned: 3, completed: 2, finished: 2 });
});

test("projects a bounded plan summary only from artifacts pinned to the attempt range", () => {
  const target = { ref, base: baseSha, head: headSha };
  save(["package", "manifest.json"], { target });
  save(["package", "plan.json"], { target, dispatches: 2, roster: ["review-logic", "review-security-code"],
    slices: { fix: [], new: [{ id: "S-1", files: ["src/cache.ts", "src/cache.test.ts"], roles: ["review-logic", "review-security-code", "review-style"] }] } });
  save(["package", "desktop-dispatch.json"], { calls: [
    { label: "review-logic" }, { label: "review-security-code" },
  ] });
  save(["package", "slices", "manifest.json"], { projectRoles: ["review-security-code"], slices: [
    { id: "S-1", depth: "deep", risk: { why: ["security-sensitive code"] } },
  ] });
  save(["package", "scope-files.json"], { version: 1, files: ["src/cache.ts", "src/cache.test.ts"], changedLines: 171 });
  save(["package", "round-depth.json"], { depth: "full", reason: "auto: a file hits the project reviewer code-boss-reviewer path gate (risk class)",
    head: headSha, files: ["src/cache.test.ts", "src/cache.ts"], changedLines: 171 });
  const result = readDeskReviewerProgress(directory, key, run, false);
  expect(result?.planSummary).toEqual({ baseSha, headSha, files: ["src/cache.ts", "src/cache.test.ts"], filesComplete: true,
    checks: [
      { name: "review-logic", category: "baseline", slices: ["S-1"] },
      { name: "review-security-code", category: "project", slices: ["S-1"] },
    ], sliceReasons: [{ id: "S-1", depth: "deep", reasons: ["security-sensitive code"] }], checksComplete: true,
    depth: "full", depthReason: "auto: a file hits the project reviewer code-boss-reviewer path gate (risk class)" });
  expect(result?.planSummary?.checks.some(check => check.name === "review-style")).toBe(false);
  expect(readDeskReviewerProgress(directory, key, { ...run, headSha: baseSha }, false)?.planSummary).toBeUndefined();
});

test("truncates large plan projections and keeps file completeness explicit", () => {
  const target = { ref, base: baseSha, head: headSha };
  const files = Array.from({ length: 160 }, (_, index) => `src/file-${index}.ts`);
  save(["package", "manifest.json"], { target });
  save(["package", "plan.json"], { target, dispatches: 1, roster: ["review-logic"],
    slices: { fix: [], new: [{ id: "S-1", files, roles: ["review-logic"] }] } });
  save(["package", "scope-files.json"], { version: 1, files });
  const summary = readDeskReviewerProgress(directory, key, run, false)?.planSummary;
  expect(summary?.files).toHaveLength(80);
  expect(summary?.filesComplete).toBe(false);
  expect(summary?.checks).toEqual([{ name: "review-logic", category: "baseline", slices: ["S-1"] }]);
  expect(summary?.sliceReasons).toHaveLength(0);
});

test("details recover a finished reviewer's public result and context request while the coordinator is still running", () => {
  const reviewer = "review-layout", file = "review-layout-w1.txt";
  save(["package", "manifest.json"], { target: { ref, base: baseSha, head: headSha } });
  save(["package", "desktop-dispatch.json"], { calls: [{ label: reviewer, save_result_to: "raw/" + file }] });
  const session = { id: randomUUID(), reviewer, wave: 1, state: "partial" as const };
  save(["run", "progress.json"], { ref, reviewerSessions: [session] });
  save(["package", "raw", file], JSON.stringify({ reviewer, status: "NEEDS_CONTEXT",
    summary: "Reviewed the controls", needs_context: [{ question: "Provide viewport measurements", private: "PRIVATE" }, { debug: "PRIVATE" }],
    findings: [{ severity: "minor", problem: "Text overlaps", quote: "PRIVATE" }], reasoning: "PRIVATE" }));
  const detail = readDeskReviewerProgress(directory, key, run, true);
  expect(detail?.sessions[0]).toMatchObject({ ...session, outcomeReason: "Provide viewport measurements",
    finalOutput: "Reviewed the controls\n\nminor: Text overlaps" });
  expect(JSON.stringify(detail)).not.toContain("PRIVATE");
  expect(readDeskReviewerProgress(directory, key, run, false)?.sessions[0]).toEqual(session);
});

test("coordinator activity shows public turns, reviewer questions and their answers", () => {
  const questionId = randomUUID();
  const rows = [
    { type: "turn_start", prompt: "PRIVATE" },
    { type: "tool_call", name: "read_file", input: JSON.stringify({ path: "/PRIVATE/plan.json", ignored: "PRIVATE" }) },
    { type: "tool_result", name: "read_file", output: "PRIVATE" },
    { type: "reasoning", text: "PRIVATE" },
    { type: "reviewer_activity", activity: "finished", reviewer: "review-layout", wave: 1, outcome: "partial", extra: "PRIVATE" },
    { type: "desktop_question", questionId, reviewerSessionId: "PRIVATE", reviewer: "review-layout", text: "Which viewport?" },
    { type: "desktop_answer", questionId, reviewerSessionId: "PRIVATE", reviewer: "review-layout", text: "The compact layout." },
    { type: "assistant", text: "Checked the decision" }, { type: "turn_end", text: "Checked the decision" },
  ];
  save(["run", "events.ndjson"], rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  expect(coordinatorActivity(directory)).toEqual([
    { kind: "status", text: "Coordinator started" }, { kind: "tool", text: "Started read_file · plan.json" },
    { kind: "result", text: "read_file finished" }, { kind: "status", text: "review-layout · Wave 1 · partial" },
    { kind: "question", questionId, reviewer: "review-layout", text: "Which viewport?" },
    { kind: "answer", questionId, reviewer: "review-layout", text: "The compact layout." },
    { kind: "message", text: "Checked the decision", final: true },
  ]);
});

test("pages earlier public coordinator events across bounded byte and event windows", () => {
  const rows = Array.from({ length: 103 }, (_, index) => ({
    type: "assistant", text: `Public é ${index}`,
  }));
  const records = [
    ...rows.slice(0, 9),
    { type: "reasoning", text: "PRIVATE".repeat(100_000) },
    ...rows.slice(9),
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  save(["run", "events.ndjson"], records);
  const latest = coordinatorActivityPage(directory);
  expect(latest.events).toHaveLength(80);
  expect(latest.events.at(-1)?.text).toBe("Public é 102");
  expect(latest.before).toBeDefined();

  // Appends do not displace the user's earlier-page anchor.
  save(["run", "events.ndjson"], records + JSON.stringify({ type: "assistant", text: "Live update" }) + "\n");
  let cursor = latest.before;
  const combined = [...latest.events];
  while (cursor !== undefined) {
    const page = coordinatorActivityPage(directory, cursor);
    expect(page.before ?? 0).toBeLessThan(cursor);
    combined.unshift(...page.events);
    cursor = page.before;
  }
  expect(combined.map(event => event.text)).toEqual(rows.map(row => row.text));
  expect(JSON.stringify(combined)).not.toContain("PRIVATE");
});

test("the paged projection never follows a replacement transcript symlink", () => {
  save(["private.ndjson"], JSON.stringify({ type: "assistant", text: "PRIVATE" }) + "\n");
  mkdirSync(path.join(directory, "run"));
  symlinkSync(path.join(directory, "private.ndjson"), path.join(directory, "run", "events.ndjson"));
  expect(coordinatorActivityPage(directory, 2048)).toEqual({ events: [] });
});

test("publishes per-wave tier evidence for exact dispatches while keeping old queue summaries readable", () => {
  const target = { ref, base: baseSha, head: headSha };
  const role = "review-logic";
  const planned = { target, roster: [role], slices: { new: [{ id: "a", roles: [role] }, { id: "b", roles: [role] }] } };
  save(["package", "manifest.json"], { target });
  save(["package", "plan.json"], planned);
  const first = "raw/review-logic-w1.txt", second = "raw/review-logic-w2.txt";
  const calls = [
    { label: role, save_result_to: first, expected_model: { provider: "local", model: "small" } },
    { label: role, save_result_to: second, expected_model: { provider: "remote", model: "large" } },
  ];
  save(["package", "desktop-dispatch.json"], { calls });
  expect(readDeskReviewerProgress(directory, key, run, false)?.planSummary?.checks[0]?.assignments).toBeUndefined();
  save(["package", "desktop-dispatch.json"], { calls, modelRouting: [
    { result: first, slices: ["a"], tier: "light", tierReason: "Mechanical check" },
    { result: second, slices: ["b"], tier: "strong", tierReason: "Assigned slice has high recorded risk." },
    { result: "raw/unplanned.txt", slices: ["b"], tier: "strong", tierReason: "Omitted" },
  ] });
  expect(readDeskReviewerProgress(directory, key, run, false)?.planSummary?.checks[0]?.assignments).toEqual([
    { wave: 1, slices: ["a"], tier: "light", tierReason: "Mechanical check", provider: "local", model: "small" },
    { wave: 2, slices: ["b"], tier: "strong", tierReason: "Assigned slice has high recorded risk.", provider: "remote", model: "large" },
  ]);
});
