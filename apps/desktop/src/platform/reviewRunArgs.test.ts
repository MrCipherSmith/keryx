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

test("answers bind to one question and preserve spaces and leading dashes", () => {
  const op = { kind: "answer", id: "run", questionId: "q", answer: "--continue with this" };
  expect(reviewRunArgs(target, op).slice(-5)).toEqual(["--id", "run", "--question-id", "q", "--answer=--continue with this"]);
  for (const answer of ["", " ", "x".repeat(2001), "a\0b"]) {
    expect(() => reviewRunArgs(target, { ...op, answer })).toThrow();
  }
});

test("a launch configuration travels as one JSON argument", () => {
  const options = { mode: "auto", adaptive: true, modelPools: { strong: [{ provider: "anthropic", model: "opus" }] } };
  const action = { kind: "start", baseSha: "a".repeat(40), headSha: "b".repeat(40), options };
  expect(reviewRunArgs(target, action).at(-1)).toBe("--options=" + JSON.stringify(options));
  expect(() => reviewRunArgs(target, { ...action, options: [] })).toThrow();
});
