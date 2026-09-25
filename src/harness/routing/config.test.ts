// Flow 305 (Flow A), AC2 — `loadRoutingConfig`/`saveRoutingConfig`, the shared
// loader for both layers: `routing.config.json` at the project root, and the
// per-user entry in shell config. An absent file/entry is an empty table
// (never an error); a file that EXISTS but cannot be read as one is a named,
// surfaced error, never a silent empty table.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadRoutingConfig,
  projectRoutingConfigPath,
  saveRoutingConfig,
  setRoutingCategory,
  unsetRoutingCategory,
  validateRoutingConfig,
} from "./config";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function location(): Promise<{ cwd: string; userConfigDir: string }> {
  return { cwd: await tempDir("keryx-routing-cfg-"), userConfigDir: await tempDir("keryx-routing-cfg-user-") };
}

test("validateRoutingConfig: a well-formed table round-trips", () => {
  const { table, errors } = validateRoutingConfig({
    categories: {
      review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
      quick: { kind: "provider-default", providerId: "deepseek" },
      subagents: { kind: "session-default" },
    },
  });
  expect(errors).toEqual([]);
  expect(table).toEqual({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    quick: { kind: "provider-default", providerId: "deepseek" },
    subagents: { kind: "session-default" },
  });
});

test("validateRoutingConfig: an unknown category and a malformed assignment are dropped AND reported, not silently kept", () => {
  const { table, errors } = validateRoutingConfig({
    categories: {
      review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
      nonsense: { kind: "model", providerId: "x", modelId: "y" },
      quick: { kind: "model", providerId: "" },
    },
  });
  expect(table).toEqual({ review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } });
  expect(errors.some((e) => e.includes("nonsense"))).toBe(true);
  expect(errors.some((e) => e.includes("quick"))).toBe(true);
});

test("validateRoutingConfig: absent categories key -> empty table, no error (an absent config is unconfigured, not malformed)", () => {
  expect(validateRoutingConfig({})).toEqual({ table: {}, errors: [] });
});

test("loadRoutingConfig (project): an absent file is an empty table, never an error", async () => {
  const loc = await location();
  const result = await loadRoutingConfig("project", loc);
  expect(result).toEqual({ table: {} });
});

test("loadRoutingConfig (user): an absent entry is an empty table, never an error", async () => {
  const loc = await location();
  const result = await loadRoutingConfig("user", loc);
  expect(result).toEqual({ table: {} });
});

test("saveRoutingConfig/loadRoutingConfig round-trip through BOTH layers independently", async () => {
  const loc = await location();
  await saveRoutingConfig("project", loc, { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } });
  await saveRoutingConfig("user", loc, { quick: { kind: "provider-default", providerId: "deepseek" } });

  const project = await loadRoutingConfig("project", loc);
  const user = await loadRoutingConfig("user", loc);
  expect(project.table).toEqual({ review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } });
  expect(user.table).toEqual({ quick: { kind: "provider-default", providerId: "deepseek" } });
});

test("saveRoutingConfig (project) writes JSON at the project root, sibling to .metaproject", async () => {
  const loc = await location();
  await saveRoutingConfig("project", loc, { review: { kind: "session-default" } });
  const file = projectRoutingConfigPath(loc.cwd);
  expect(file).toBe(path.join(loc.cwd, "routing.config.json"));
});

test("a malformed project file is a NAMED, SURFACED error, never a silently empty table", async () => {
  const loc = await location();
  await writeFile(projectRoutingConfigPath(loc.cwd), "not json at all", "utf8");
  const result = await loadRoutingConfig("project", loc);
  expect(result.table).toEqual({});
  expect(result.error).toBeDefined();
  expect(result.error).toContain(projectRoutingConfigPath(loc.cwd));
});

test("a project file that parses but is not an object is also a surfaced error", async () => {
  const loc = await location();
  await writeFile(projectRoutingConfigPath(loc.cwd), "[1,2,3]", "utf8");
  const result = await loadRoutingConfig("project", loc);
  expect(result.table).toEqual({});
  expect(result.error).toBeDefined();
});

test("setRoutingCategory preserves every other category already set in that layer", async () => {
  const loc = await location();
  await setRoutingCategory("user", loc, "review", { kind: "model", providerId: "anthropic", modelId: "claude-x" });
  await setRoutingCategory("user", loc, "quick", { kind: "provider-default", providerId: "deepseek" });
  const result = await loadRoutingConfig("user", loc);
  expect(result.table).toEqual({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    quick: { kind: "provider-default", providerId: "deepseek" },
  });
});

test("unsetRoutingCategory clears exactly one category, leaving the rest untouched", async () => {
  const loc = await location();
  await setRoutingCategory("project", loc, "review", { kind: "model", providerId: "anthropic", modelId: "claude-x" });
  await setRoutingCategory("project", loc, "quick", { kind: "provider-default", providerId: "deepseek" });
  await unsetRoutingCategory("project", loc, "review");
  const result = await loadRoutingConfig("project", loc);
  expect(result.table).toEqual({ quick: { kind: "provider-default", providerId: "deepseek" } });
});

test("the user layer and the project layer for DIFFERENT projects at the same cwd do not collide (userConfigDir is independent of cwd)", async () => {
  const cwd = await tempDir("keryx-routing-shared-cwd-");
  const userA = await tempDir("keryx-routing-user-a-");
  const userB = await tempDir("keryx-routing-user-b-");
  await saveRoutingConfig("user", { cwd, userConfigDir: userA }, { review: { kind: "session-default" } });
  await saveRoutingConfig("user", { cwd, userConfigDir: userB }, { review: { kind: "provider-default", providerId: "deepseek" } });
  expect((await loadRoutingConfig("user", { cwd, userConfigDir: userA })).table.review).toEqual({ kind: "session-default" });
  expect((await loadRoutingConfig("user", { cwd, userConfigDir: userB })).table.review).toEqual({
    kind: "provider-default",
    providerId: "deepseek",
  });
});
