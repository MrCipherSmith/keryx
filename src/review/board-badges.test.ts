import { expect, test } from "bun:test";
import { localBadge } from "./board-badges";
import type { DeskRevision, DeskRun } from "./desk-run-types";

const base = "a".repeat(40);
const old = { baseSha: base, headSha: "b".repeat(40) };
const older = { baseSha: base, headSha: "d".repeat(40) };
const current = { baseSha: base, headSha: "c".repeat(40) };

type Run = Parameters<typeof localBadge>[0][number];
const run = (range: DeskRevision, state: DeskRun["state"], extra: Partial<Run> = {}): Run => ({
  ...range, state, source: "manual",
  result: ["completed", "partial", "budget"].includes(state) ? { reviewed: range } : null,
  ...extra,
});

test("a finished review of an earlier head is reported as outdated without counting as ready", () => {
  const badge = localBadge([run(old, "completed", { publication: "pending" })], current);
  expect(badge).toEqual({ active: false, ready: false, outdated: { headSha: old.headSha, state: "completed" } });
  expect(badge.runState).toBeUndefined();
  expect(badge.publicationPending).toBeUndefined();
});

test("a run on the current range takes precedence over an outdated result", () => {
  expect(localBadge([run(current, "failed"), run(old, "completed")], current))
    .toEqual({ active: false, ready: false, runState: "failed" });
  expect(localBadge([run(current, "partial"), run(old, "completed")], current))
    .toEqual({ active: false, ready: true, runState: "partial" });
  // A run requested on another range whose reviewed range is the current one also counts.
  expect(localBadge([run(old, "completed", { result: { reviewed: current } }), run(older, "completed")], current).outdated)
    .toBeUndefined();
});

test("an active run on any range takes precedence over an outdated result", () => {
  expect(localBadge([run(older, "running"), run(old, "completed")], current))
    .toEqual({ active: true, ready: false, runState: "other-revision" });
  expect(localBadge([run(current, "queued"), run(old, "completed")], current))
    .toEqual({ active: true, ready: false, runState: "queued" });
});

test("archived, deleted, imported, unfinished and resultless runs never become outdated", () => {
  const decision = (action: "archive" | "delete") => ({ decision: { action, reason: "", at: "" } });
  expect(localBadge([
    run(old, "completed", decision("archive")),
    run(old, "completed", decision("delete")),
    run(old, "completed", { source: "existing" }),
    run(old, "failed"),
    run(old, "cancelled"),
    run(old, "partial", { result: null }),
    run(old, "budget", { result: { reviewed: null } }),
  ], current)).toEqual({ active: false, ready: false });
});

test("an outdated result names its round when the run carries one", () => {
  expect(localBadge([run(old, "completed", { round: 2 })], current).outdated)
    .toEqual({ headSha: old.headSha, state: "completed", round: 2 });
  // Rows read from a store that predates rounds carry null or nothing: the badge stays as before.
  expect(localBadge([run(old, "completed", { round: null })], current).outdated)
    .toEqual({ headSha: old.headSha, state: "completed" });
  expect(localBadge([run(old, "completed")], current).outdated).not.toHaveProperty("round");
});

test("the newest of several outdated results wins", () => {
  expect(localBadge([run(old, "budget"), run(older, "completed")], current).outdated)
    .toEqual({ headSha: old.headSha, state: "budget" });
  // History is newest first; a skipped newer run does not hide an older finished one.
  expect(localBadge([run(old, "completed", { source: "existing" }), run(older, "partial")], current).outdated)
    .toEqual({ headSha: older.headSha, state: "partial" });
});

test("a published review of the current range carries its verdict; a newer run or another range drops it", () => {
  expect(localBadge([run(current, "completed", { publication: "published", publishedVerdict: "changes" })], current).published)
    .toEqual({ verdict: "changes" });
  expect(localBadge([run(current, "completed", { publication: "published" })], current).published).toEqual({});
  expect(localBadge([run(current, "running"), run(current, "completed", { publication: "published", publishedVerdict: "approve" })], current).published)
    .toBeUndefined();
  expect(localBadge([run(old, "completed", { publication: "published", publishedVerdict: "approve" })], current).published).toBeUndefined();
});
