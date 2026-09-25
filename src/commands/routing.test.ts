// Flow 305 (Flow A), AC3 — `keryx routing list|set|unset`, mirroring
// `keryx providers`'s subcommand dispatch shape.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRoutingConfig, loadRoutingConfigRaw } from "../harness/routing/config";
import { refreshModelProfiles } from "../harness/routing/model-profile";
import { appendTaskCostRecord } from "../harness/routing/task-cost";
import { routingCommand, type RoutingCommandDeps } from "./routing";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/**
 * `providers` defaults to a small FIXTURE covering the placeholder
 * provider/model names most tests in this file already use ("anthropic",
 * "deepseek") — AC10's connected check would otherwise reject them (an empty
 * live `detectProviders()` result in this sandboxed test environment), which
 * is exactly what the dedicated AC10 tests further down exercise on purpose
 * with a DIFFERENT (empty or narrower) fixture.
 */
async function deps(overrides: Partial<RoutingCommandDeps> = {}): Promise<RoutingCommandDeps & { cwd: string; userConfigDir: string }> {
  return {
    cwd: await tempDir("keryx-routing-cli-cwd-"),
    userConfigDir: await tempDir("keryx-routing-cli-user-"),
    providers: async () => [
      { name: "anthropic", models: ["claude-x", "claude-y"] },
      { name: "deepseek", models: ["deepseek-chat"] },
    ],
    ...overrides,
  };
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
  // `loadRoutingConfigRaw`, not `loadRoutingConfig`: this asserts the WRITE
  // landed, independent of AC11's approval gate (tested separately below) —
  // a fresh `set --project` is never auto-approved.
  const project = await loadRoutingConfigRaw("project", d);
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
  expect(text).toContain("routing trust");
});

// ---------------------------------------------------------------------------
// Flow 305 AC10 — `keryx routing list` falls through an entry naming an
// unconnected provider/model, with the exact notice text.
// ---------------------------------------------------------------------------

test("flow 305 AC10: `keryx routing list` shows a not-connected fallback notice, plain text", async () => {
  const d = await deps({ providers: async () => [] }); // nothing connected at all
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  const { stdout } = await capture(() => routingCommand(["list"], d));
  const text = stdout.join("\n");
  expect(text).toContain("anthropic/claude-x - not connected, falling back to session default");
});

test("flow 305 AC10: `keryx routing list --json` carries the rejected entry alongside the resolved fallback", async () => {
  const d = await deps({ providers: async () => [] });
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  const { stdout } = await capture(() => routingCommand(["list", "--json"], d));
  const parsed = JSON.parse(stdout.join("")) as {
    categories: Record<string, { assignment: unknown; source: string; rejected?: { assignment: unknown; source: string } }>;
  };
  expect(parsed.categories.review?.source).toBe("default");
  expect(parsed.categories.review?.assignment).toEqual({ kind: "session-default" });
  expect(parsed.categories.review?.rejected).toEqual({
    assignment: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    source: "user",
  });
});

test("flow 305 AC10: a CONNECTED provider but an unlisted model also falls through", async () => {
  const d = await deps({ providers: async () => [{ name: "anthropic", models: ["claude-y"] }] });
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  const { stdout } = await capture(() => routingCommand(["list"], d));
  expect(stdout.join("\n")).toContain("anthropic/claude-x - not connected, falling back to session default");
});

test("flow 305 AC10: a provider-default entry for a connected provider resolves normally (no fallback)", async () => {
  const d = await deps({ providers: async () => [{ name: "deepseek", models: ["deepseek-chat"] }] });
  await capture(() => routingCommand(["set", "review", "deepseek"], d));
  const { stdout } = await capture(() => routingCommand(["list"], d));
  const text = stdout.join("\n");
  expect(text).toContain("deepseek (provider default)");
  expect(text).not.toContain("not connected");
});

// ---------------------------------------------------------------------------
// Flow 305 AC11 — `keryx routing trust`: an unapproved project file is
// ignored (with a notice), approving applies it, editing voids it.
// ---------------------------------------------------------------------------

async function writeProjectRoutingFile(d: RoutingCommandDeps & { cwd: string }, categories: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(d.cwd, "routing.config.json"), JSON.stringify({ categories }), "utf8");
}

test("flow 305 AC11: an unapproved project routing.config.json is ignored, with a notice, in `keryx routing list`", async () => {
  const d = await deps();
  await writeProjectRoutingFile(d, { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } });
  const { stdout, stderr } = await capture(() => routingCommand(["list"], d));
  const text = stdout.join("\n");
  // Falls back to session default — the unapproved entry never applies.
  expect(text).toMatch(/review\s+session default\s+\[default\]/);
  expect(stderr.join("\n")).toContain("unapproved");
  expect(stderr.join("\n")).toContain("keryx routing trust");
});

test("flow 305 AC11: `keryx routing trust` shows the file's entries and then approves it — it applies afterwards", async () => {
  const d = await deps();
  await writeProjectRoutingFile(d, { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } });
  const { stdout } = await capture(() => routingCommand(["trust"], d));
  const text = stdout.join("\n");
  // Shows what it is about to approve BEFORE confirming (same discipline as `keryx mcp trust`).
  expect(text).toContain("review: anthropic/claude-x");
  expect(text).toContain("Approved");

  const { stdout: listOut } = await capture(() => routingCommand(["list"], d));
  expect(listOut.join("\n")).toMatch(/review\s+anthropic\/claude-x\s+\[project\]/);
});

test("flow 305 AC11: editing the file after `keryx routing trust` voids the approval", async () => {
  const d = await deps();
  await writeProjectRoutingFile(d, { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } });
  await capture(() => routingCommand(["trust"], d));
  await writeProjectRoutingFile(d, { review: { kind: "model", providerId: "deepseek", modelId: "deepseek-chat" } });

  const { stdout } = await capture(() => routingCommand(["list"], d));
  expect(stdout.join("\n")).toMatch(/review\s+session default\s+\[default\]/);
});

test("flow 305 AC11: `keryx routing trust` with no project categories says there is nothing to approve", async () => {
  const d = await deps();
  const { stdout } = await capture(() => routingCommand(["trust"], d));
  expect(stdout.join("\n")).toContain("nothing to approve");
});

// ---------------------------------------------------------------------------
// Flow 327 (Routing A2), item 5 — `keryx routing profile list/set` and the
// `derived`/`unavailable` rendering of `keryx routing list`.
// ---------------------------------------------------------------------------

test("keryx routing profile list: prints the curated seed from the FIRST read, no write required", async () => {
  const d = await deps();
  const { stdout } = await capture(() => routingCommand(["profile", "list"], d));
  expect(stdout.join("\n")).toContain("anthropic/claude-sonnet-5");
});

test("keryx routing profile list --json: a JSON array of every stored + curated-seed profile", async () => {
  const d = await deps();
  const { stdout } = await capture(() => routingCommand(["profile", "list", "--json"], d));
  const parsed = JSON.parse(stdout.join("")) as { profiles: Array<{ providerId: string; modelId: string }> };
  expect(parsed.profiles.some((p) => p.providerId === "anthropic" && p.modelId === "claude-sonnet-5")).toBe(true);
});

test("keryx routing profile set: an operator correction persists with source 'operator' and shows up on the next list", async () => {
  const d = await deps();
  const { stdout: setOut } = await capture(() => routingCommand(["profile", "set", "anthropic/claude-sonnet-5", "--tier", "deep"], d));
  expect(setOut.join("\n")).toContain("tier=deep (operator)");
  const { stdout } = await capture(() => routingCommand(["profile", "list", "--json"], d));
  const parsed = JSON.parse(stdout.join("")) as {
    profiles: Array<{ providerId: string; modelId: string; strengthTier: { value: string; source: string } }>;
  };
  const sonnet = parsed.profiles.find((p) => p.providerId === "anthropic" && p.modelId === "claude-sonnet-5");
  expect(sonnet?.strengthTier).toEqual({ value: "deep", source: "operator" });
});

test("keryx routing profile set --priority: a numeric flag persists as an operator correction", async () => {
  const d = await deps();
  const { stdout } = await capture(() => routingCommand(["profile", "set", "anthropic/claude-sonnet-5", "--priority", "42"], d));
  expect(stdout.join("\n")).toContain("priority=42 (operator)");
});

test("keryx routing profile set: rejects a target with no slash", async () => {
  const d = await deps();
  const { stderr } = await capture(() => routingCommand(["profile", "set", "not-a-target", "--tier", "deep"], d));
  expect(stderr.join("\n")).toContain("Usage: keryx routing profile set");
});

test("keryx routing profile set: rejects a missing field flag", async () => {
  const d = await deps();
  const { stderr } = await capture(() => routingCommand(["profile", "set", "anthropic/claude-sonnet-5"], d));
  expect(stderr.join("\n")).toContain("Usage: keryx routing profile set");
});

test("flow 327: `keryx routing list` reports a category with no explicit config as 'auto (derived from <provider>'s models)', source [derived]", async () => {
  const d = await deps({
    providers: async () => [{ name: "anthropic", models: ["claude-opus-5.5", "claude-sonnet-5"] }],
    session: () => ({ providerId: "anthropic", modelId: "claude-opus-5.5" }),
  });
  await refreshModelProfiles("anthropic", ["claude-opus-5.5", "claude-sonnet-5"], {}, { dir: d.userConfigDir });
  const { stdout } = await capture(() => routingCommand(["list"], d));
  const text = stdout.join("\n");
  expect(text).toMatch(/subagents\s+auto \(derived from anthropic's models\) -> anthropic\/claude-sonnet-5\s+\[derived\]/);
  expect(text).toMatch(/review\s+auto \(derived from anthropic's models\) -> anthropic\/claude-opus-5\.5\s+\[derived\]/);
});

test("flow 327: `keryx routing list --json` reports source 'derived' for a category the operator never configured", async () => {
  const d = await deps({
    providers: async () => [{ name: "anthropic", models: ["claude-opus-5.5", "claude-sonnet-5"] }],
    session: () => ({ providerId: "anthropic", modelId: "claude-opus-5.5" }),
  });
  await refreshModelProfiles("anthropic", ["claude-opus-5.5", "claude-sonnet-5"], {}, { dir: d.userConfigDir });
  const { stdout } = await capture(() => routingCommand(["list", "--json"], d));
  const parsed = JSON.parse(stdout.join("")) as { categories: Record<string, { assignment: unknown; source: string }> };
  expect(parsed.categories.subagents).toEqual({
    assignment: { kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" },
    source: "derived",
  });
});

test("flow 327 AC11: an explicit entry naming a model whose profile went unavailable falls back, with the em-dash 'unavailable' notice", async () => {
  const d = await deps({ providers: async () => [{ name: "anthropic", models: ["claude-x"] }] });
  await refreshModelProfiles("anthropic", ["claude-x"], {}, { dir: d.userConfigDir }); // first seen
  await refreshModelProfiles("anthropic", [], {}, { dir: d.userConfigDir }); // vanished -> available: false, kept
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  const { stdout } = await capture(() => routingCommand(["list"], d));
  const text = stdout.join("\n");
  expect(text).toContain("anthropic/claude-x — unavailable, falling back to session default");
  expect(text).not.toContain("anthropic/claude-x - not connected"); // the DIFFERENT flow 305 notice, not this one
});

test("flow 327 AC11: `keryx routing list --json` carries the unavailable rejection with its reason", async () => {
  const d = await deps({ providers: async () => [{ name: "anthropic", models: ["claude-x"] }] });
  await refreshModelProfiles("anthropic", ["claude-x"], {}, { dir: d.userConfigDir });
  await refreshModelProfiles("anthropic", [], {}, { dir: d.userConfigDir });
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  const { stdout } = await capture(() => routingCommand(["list", "--json"], d));
  const parsed = JSON.parse(stdout.join("")) as {
    categories: Record<string, { source: string; rejected?: { assignment: unknown; source: string; reason?: string } }>;
  };
  expect(parsed.categories.review?.source).toBe("default");
  expect(parsed.categories.review?.rejected).toEqual({
    assignment: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    source: "user",
    reason: "unavailable",
  });
});

// ---------------------------------------------------------------------------
// Flow 341 (AC6) — `keryx routing stats [--json]`.
// ---------------------------------------------------------------------------

test("keryx routing stats: no recorded tasks — says so, exits clean", async () => {
  const d = await deps();
  const { stdout } = await capture(() => routingCommand(["stats"], d));
  expect(stdout.join("\n")).toContain("no measured tasks recorded yet");
});

test("keryx routing stats: prints n, median tokens, median cost, success rate per (provider, model, category)", async () => {
  const d = await deps();
  await appendTaskCostRecord(
    { providerId: "anthropic", modelId: "claude-x", category: "subagents", inputTokens: 400, outputTokens: 100, totalTokens: 500, costUsd: 0.05, success: true, recordedAt: 1 },
    d.userConfigDir,
  );
  await appendTaskCostRecord(
    { providerId: "anthropic", modelId: "claude-x", category: "subagents", inputTokens: 600, outputTokens: 100, totalTokens: 700, costUsd: 0.07, success: false, recordedAt: 2 },
    d.userConfigDir,
  );
  const { stdout } = await capture(() => routingCommand(["stats"], d));
  const text = stdout.join("\n");
  expect(text).toContain("anthropic/claude-x");
  expect(text).toContain("[subagents]");
  expect(text).toContain("n=2");
  expect(text).toContain("600 tok/task"); // median of 500/700
  expect(text).toContain("$0.06/task"); // median of 0.05/0.07
  expect(text).toContain("50% success");
});

test("keryx routing stats: a key with no known cost prints \"unknown\", never a fabricated number", async () => {
  const d = await deps();
  await appendTaskCostRecord(
    { providerId: "anthropic", modelId: "claude-x", category: "docs", inputTokens: 100, outputTokens: 20, totalTokens: 120, success: true, recordedAt: 1 },
    d.userConfigDir,
  );
  const { stdout } = await capture(() => routingCommand(["stats"], d));
  expect(stdout.join("\n")).toContain("unknown/task");
});

test("keryx routing stats --json: valid JSON, one row per (provider, model, category)", async () => {
  const d = await deps();
  await appendTaskCostRecord(
    { providerId: "anthropic", modelId: "claude-x", category: "subagents", inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.01, success: true, recordedAt: 1 },
    d.userConfigDir,
  );
  const { stdout } = await capture(() => routingCommand(["stats", "--json"], d));
  const parsed = JSON.parse(stdout.join("")) as { stats: Array<{ providerId: string; modelId: string; category: string; n: number; medianCostUsd?: number }> };
  expect(parsed.stats).toHaveLength(1);
  expect(parsed.stats[0]).toMatchObject({ providerId: "anthropic", modelId: "claude-x", category: "subagents", n: 1, medianCostUsd: 0.01 });
});
