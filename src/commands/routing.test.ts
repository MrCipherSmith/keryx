// `keryx routing` subcommands over the canonical routing settings. Default-engine
// and migration acceptance lives in `routing-default.test.ts`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRoutingSettings } from "../harness/routing/settings";
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

test("keryx routing set <category> <provider>/<model> writes an explicit model, default layer --user", async () => {
  const d = await deps();
  const result = await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  expect(result.stdout.join("\n")).toContain("review -> anthropic/claude-x  [user]");
  expect(readRoutingSettings({ cwd: d.cwd, configDir: d.userConfigDir }).user.layer?.categories?.review)
    .toEqual({ mode: "model", target: { providerId: "anthropic", modelId: "claude-x" } });
});

test("keryx routing set <category> <provider> (no slash) pins that provider's documented default model", async () => {
  const d = await deps();
  await capture(() => routingCommand(["set", "quick", "ollama"], d));
  expect(readRoutingSettings({ cwd: d.cwd, configDir: d.userConfigDir }).user.layer?.categories?.quick)
    .toEqual({ mode: "model", target: { providerId: "ollama", modelId: "llama3.1:latest" } });
  const unknown = await capture(() => routingCommand(["set", "quick", "no-such-provider"], d));
  expect(unknown.stderr.join("\n")).toContain("no known default model");
});

test("keryx routing set --project writes the project layer, which applies only after keryx routing trust", async () => {
  const d = await deps();
  const set = await capture(() => routingCommand(["set", "review", "expert", "--project"], d));
  expect(set.stdout.join("\n")).toContain("keryx routing trust");
  const raw = JSON.parse(await readFile(path.join(d.cwd, "routing.config.json"), "utf8"));
  expect(raw.modelRouting.categories.review).toEqual({ mode: "class", modelClass: "expert" });
  expect(readRoutingSettings({ cwd: d.cwd, configDir: d.userConfigDir }).project.trusted).toBe(false);
  const listed = await capture(() => routingCommand(["list"], { ...d, session: () => undefined }));
  expect(listed.stderr.join("\n")).toContain("keryx routing trust");
  const trust = await capture(() => routingCommand(["trust"], d));
  expect(trust.stdout.join("\n")).toContain("review: class expert");
  expect(readRoutingSettings({ cwd: d.cwd, configDir: d.userConfigDir }).project.trusted).toBe(true);
  await capture(() => routingCommand(["set", "review", "light", "--project"], d));
  expect(readRoutingSettings({ cwd: d.cwd, configDir: d.userConfigDir }).project.trusted).toBe(false);
});

test("keryx routing unset clears one category, leaving the others untouched", async () => {
  const d = await deps();
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  await capture(() => routingCommand(["set", "docs", "light"], d));
  await capture(() => routingCommand(["unset", "review"], d));
  expect(readRoutingSettings({ cwd: d.cwd, configDir: d.userConfigDir }).user.layer?.categories).toEqual({ docs: { mode: "class", modelClass: "light" } });
});

test("keryx routing set with an unknown category or an unparseable target is refused and writes nothing", async () => {
  const d = await deps();
  const category = await capture(() => routingCommand(["set", "nonsense", "anthropic/claude-x"], d));
  expect(category.stderr.join("\n")).toContain("Unknown or missing category");
  const target = await capture(() => routingCommand(["set", "review", "/"], d));
  expect(target.stderr.join("\n")).toContain("Could not parse");
  expect(readRoutingSettings({ cwd: d.cwd, configDir: d.userConfigDir }).user.source).toBe("none");
});

test("keryx routing trust with no project settings says there is nothing to approve", async () => {
  const d = await deps();
  const result = await capture(() => routingCommand(["trust"], d));
  expect(result.stdout.join("\n")).toContain("nothing to approve");
});

test("keryx routing --help / unknown subcommand print usage naming every subcommand, with no engine switch", async () => {
  const d = await deps();
  const help = (await capture(() => routingCommand(["--help"], d))).stdout.join("\n");
  for (const sub of ["list", "set", "unset", "trust", "classes", "settings", "explain", "pilot", "migrate", "profile", "stats"]) {
    expect(help).toContain(`keryx routing ${sub}`);
  }
  expect(help).not.toMatch(/v2|--legacy|--apply|--rollback|--deactivate/);
  const unknown = await capture(() => routingCommand(["sideways"], d));
  expect(unknown.stderr.join("\n")).toContain("Unknown routing command");
});

test("keryx routing list without a session model shows each assignment and its layer", async () => {
  const d = await deps({ session: () => undefined });
  await capture(() => routingCommand(["set", "review", "anthropic/claude-x"], d));
  const result = await capture(() => routingCommand(["list", "--json"], d));
  const parsed = JSON.parse(result.stdout.join("")) as { baseline: null; assignments: { category: string; source: string }[] };
  expect(parsed.baseline).toBeNull();
  expect(parsed.assignments.find((row) => row.category === "review")?.source).toBe("user");
});

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

test("routing settings rejects a stale revision and exposes the new class pool", async () => {
  const d = await deps();
  const settings = await capture(() => routingCommand(["settings", "list"], d));
  const { revision } = JSON.parse(settings.stdout.join("")) as { revision: string };
  const file = path.join(d.cwd, "expert.json");
  const candidate = { target: { providerId: "anthropic", modelId: "claude-x" }, priority: 1, enabled: true };
  await writeFile(file, JSON.stringify({ candidates: [candidate], selection: "priority", fallbackClasses: [] }));
  await capture(() => routingCommand(["classes", "set", "expert", file, "--revision", revision], d));
  const pools = await capture(() => routingCommand(["classes", "list"], d));
  expect(JSON.parse(pools.stdout.join(""))).toMatchObject({ expert: { candidates: [candidate] } });
  const updatedSettings = await capture(() => routingCommand(["settings", "list"], d));
  await writeFile(file, JSON.stringify({ candidates: [], selection: "priority", fallbackClasses: [] }));
  await expect(routingCommand(["classes", "set", "expert", file, "--revision", revision], d)).rejects.toThrow(/revision/i);
  const afterRefusal = await capture(() => routingCommand(["settings", "list"], d));
  const poolsAfterRefusal = await capture(() => routingCommand(["classes", "list"], d));
  expect(JSON.parse(afterRefusal.stdout.join(""))).toEqual(JSON.parse(updatedSettings.stdout.join("")));
  expect(JSON.parse(poolsAfterRefusal.stdout.join(""))).toEqual(JSON.parse(pools.stdout.join("")));
}, 30_000);
