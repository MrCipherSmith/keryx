import { expect, test } from "bun:test";
import { reviewRuleArgs, reviewWatcherArgs } from "../../dev/reviewWatcher";

const target = { repo: "org/repo", repositoryId: "R1", viewer: "me" };

test("watcher installation pins the board identity and interval", () => {
  expect(reviewWatcherArgs(target, {kind: "enable", intervalMinutes: 5})).toEqual([
    "review", "watch", "enable", "--json", "--repo", "org/repo", "--repository-id", "R1", "--viewer", "me", "--interval-minutes", "5",
  ]);
});

test("offline status and pause are available while the worker and invalid targets are private", () => {
  expect(reviewWatcherArgs(null, {kind: "status"})).toEqual(["review", "watch", "status", "--json"]);
  expect(reviewWatcherArgs(null, {kind: "pause"})).toContain("pause");
  for (const kind of ["tick", "enable", "resume"]) expect(() => reviewWatcherArgs(null, {kind})).toThrow();
  for (const intervalMinutes of [0, 1.5, 1441]) expect(() => reviewWatcherArgs(target, {kind: "enable", intervalMinutes})).toThrow();
  expect(() => reviewWatcherArgs({...target, repo: "--repo"}, {kind: "pause"})).toThrow();
});

test("rule settings carry a single JSON payload and never expose a worker operation", () => {
  const action = { kind: "delete", id: "rule-1" };
  expect(reviewRuleArgs(target, action)).toEqual([
    "review", "rules", "--json", "--repo", "org/repo", "--repository-id", "R1", "--viewer", "me",
    "--request", JSON.stringify(action),
  ]);
  expect(() => reviewRuleArgs(null, action)).toThrow();
  expect(() => reviewRuleArgs(target, { kind: "start" })).toThrow();
});

test("the browser host forwards an omitted, unlimited or explicit rule budget unchanged", () => {
  for (const budgetTokens of [undefined, null, 500000]) {
    const rule = { id: "tokens", budgetTokens };
    const args = reviewRuleArgs(target, { kind: "save", rule });
    expect(JSON.parse(args[args.indexOf("--request") + 1]!).rule).toEqual(JSON.parse(JSON.stringify(rule)));
  }
});
