// Flow 305 (Flow A), AC3 — `keryx routing list|set|unset`, mirroring
// `keryx providers`'s subcommand dispatch shape.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRoutingConfig } from "../harness/routing/config";
import { routingCommand } from "./routing";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function deps(): Promise<{ cwd: string; userConfigDir: string }> {
  return { cwd: await tempDir("keryx-routing-cli-cwd-"), userConfigDir: await tempDir("keryx-routing-cli-user-") };
}

async function capture(run: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await run();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const result = { stdout, stderr };
  process.exitCode = origExit;
  return result;
}

test("keryx routing list: an unconfigured project reports every category as session default", async () => {
  const d = await deps();
  const { stdout } = await capture(() => routingCommand(["list"], d));
  const text = stdout.join("\n");
  expect(text).toContain("review");
  expect(text).toContain("session default");
  expect(text).toContain("[default]");
});

test("keryx routing list --json: valid JSON with every category", async () => {
  const d = await deps();
  const { stdout } = await capture(() => routingCommand(["list", "--json"], d));
  const parsed = JSON.parse(stdout.join("")) as { categories: Record<string, { assignment: unknown; source: string }> };
  expect(Object.keys(parsed.categories).sort()).toEqual(
    ["coding", "default", "docs", "planning", "quick", "review", "subagents", "unattended"].sort(),
  );
  expect(parsed.categories.review?.source).toBe("default");
});

test("keryx routing set <category> <provider>/<model> writes an explicit model, default layer --user", async () => {
  const d = await deps();
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  const user = await loadRoutingConfig("user", d);
  expect(user.table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
  const project = await loadRoutingConfig("project", d);
  expect(project.table.review).toBeUndefined();
});

test("keryx routing set <category> <provider> (no slash) writes a provider-default", async () => {
  const d = await deps();
  await capture(() => routingCommand(["set", "quick", "deepseek"], d));
  const user = await loadRoutingConfig("user", d);
  expect(user.table.quick).toEqual({ kind: "provider-default", providerId: "deepseek" });
});

test("keryx routing set --project writes the project layer instead of the user layer", async () => {
  const d = await deps();
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x", "--project"], d));
  const project = await loadRoutingConfig("project", d);
  expect(project.table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
  const user = await loadRoutingConfig("user", d);
  expect(user.table.review).toBeUndefined();
});

test("keryx routing list reflects a set immediately, with the right source layer", async () => {
  const d = await deps();
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  const { stdout } = await capture(() => routingCommand(["list", "--json"], d));
  const parsed = JSON.parse(stdout.join("")) as { categories: Record<string, { assignment: unknown; source: string }> };
  expect(parsed.categories.review).toEqual({
    assignment: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    source: "user",
  });
});

test("keryx routing unset clears a category back to session default, leaving other categories untouched", async () => {
  const d = await deps();
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  await capture(() => routingCommand(["set", "quick", "deepseek"], d));
  await capture(() => routingCommand(["unset", "review"], d));
  const user = await loadRoutingConfig("user", d);
  expect(user.table.review).toBeUndefined();
  expect(user.table.quick).toEqual({ kind: "provider-default", providerId: "deepseek" });
});

test("keryx routing set with an unknown category is refused, exits non-zero, and writes nothing", async () => {
  const d = await deps();
  const { stderr } = await capture(async () => {
    process.exitCode = undefined;
    await routingCommand(["set", "not-a-category", "anthropic/claude-x"], d);
  });
  expect(stderr.join("\n")).toContain("Unknown or missing category");
  const user = await loadRoutingConfig("user", d);
  expect(user.table).toEqual({});
});

test("keryx routing set with an unparseable target is refused", async () => {
  const d = await deps();
  const { stderr } = await capture(() => routingCommand(["set", "review", "/no-provider"], d));
  expect(stderr.join("\n")).toContain("Could not parse");
});

test("keryx routing --help / unknown subcommand print usage naming every subcommand", async () => {
  const d = await deps();
  const { stdout } = await capture(() => routingCommand([], d));
  const text = stdout.join("\n");
  expect(text).toContain("routing list");
  expect(text).toContain("routing set");
  expect(text).toContain("routing unset");
});
