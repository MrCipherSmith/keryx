import { expect, test } from "bun:test";
import { reviewRunArgs } from "../../dev/reviewRun";

const target = { repo: "org/project", repositoryId: "R_123", viewer: "reviewer", number: 42 };

test("the bridge forwards the selected PR and revision as separate arguments", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  expect(reviewRunArgs(target, { kind: "start", baseSha: base, headSha: head })).toEqual([
    "review", "desk-run", "start", "--json", "--repo", "org/project", "--repository-id", "R_123",
    "--viewer", "reviewer", "--number", "42", "--base", base, "--head", head,
  ]);
  expect(reviewRunArgs(target, { kind: "status", activityId: "attempt" }).slice(-2)).toEqual(["--activity-id", "attempt"]);
  expect(() => reviewRunArgs(target, { kind: "status", activityId: "attempt", id: "another" })).toThrow();
  expect(reviewRunArgs(target, { kind: "cancel", id: "attempt" }).slice(-2)).toEqual(["--id", "attempt"]);
});

test("the webview cannot supply the worker operation or replace an argument with a switch", () => {
  expect(() => reviewRunArgs(target, { kind: "worker" })).toThrow();
  expect(() => reviewRunArgs(target, { kind: "cancel", id: "--json" })).toThrow();
  expect(() => reviewRunArgs({ ...target, number: 0 }, { kind: "status" })).toThrow();
});
