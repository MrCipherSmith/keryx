// Acceptance: `keryx routing` operates on the primary routing engine with no
// activation step and no engine switch. Ordinary category commands edit the
// canonical settings; the old activation commands are gone.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { refreshModelProfiles } from "../harness/routing/model-profile";
import { ROUTING_CATEGORIES } from "../harness/routing/table";
import { routingCommand, type RoutingCommandDeps } from "./routing";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function deps(): Promise<RoutingCommandDeps & { cwd: string; userConfigDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-routing-default-cwd-"));
  const userConfigDir = await mkdtemp(path.join(tmpdir(), "keryx-routing-default-user-"));
  roots.push(cwd, userConfigDir);
  // A saved credential makes the session provider a routable candidate.
  await writeFile(path.join(userConfigDir, "auth.json"), JSON.stringify({ apiKeys: { ANTHROPIC_API_KEY: "sk-test" } }));
  return {
    cwd,
    userConfigDir,
    providers: async () => [{ name: "anthropic", models: ["claude-x", "claude-y"] }],
    session: () => ({ providerId: "anthropic", modelId: "claude-y" }),
  };
}

async function run(args: string[], d: RoutingCommandDeps): Promise<{ stdout: string; stderr: string; exitCode: number | undefined; error?: Error }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => stdout.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => stderr.push(a.map(String).join(" "));
  process.exitCode = undefined;
  let error: Error | undefined;
  try {
    await routingCommand(args, d);
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = origExit;
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode, ...(error === undefined ? {} : { error }) };
}

describe("keryx routing uses primary routing by default", () => {
  test("list --json resolves every category without an activation step", async () => {
    const d = await deps();
    const result = await run(["list", "--json"], d);
    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(result.stdout) as { engineVersion?: unknown; decisions: { category: string; decision: { status: string; assignmentSource: string } }[] };
    expect(parsed.engineVersion).toBeUndefined();
    expect(parsed.decisions.map((d) => d.category)).toEqual([...ROUTING_CATEGORIES]);
    for (const { decision } of parsed.decisions) {
      expect(decision.status).toBe("selected");
      expect(decision.assignmentSource).toBe("builtin");
    }
  });

  test("set writes the canonical user setting and list reflects it", async () => {
    const d = await deps();
    await refreshModelProfiles("anthropic", ["claude-x", "claude-y"], {}, { dir: d.userConfigDir });
    expect((await run(["set", "review", "anthropic/claude-x"], d)).error).toBeUndefined();
    expect((await run(["set", "docs", "light"], d)).error).toBeUndefined();
    const auth = JSON.parse(await readFile(path.join(d.userConfigDir, "auth.json"), "utf8"));
    expect(auth.modelRouting).toEqual({
      schemaVersion: 2,
      categories: {
        review: { mode: "model", target: { providerId: "anthropic", modelId: "claude-x" } },
        docs: { mode: "class", modelClass: "light" },
      },
    });
    expect(auth.routing).toBeUndefined();
    expect(auth.routingV2).toBeUndefined();
    const listed = JSON.parse((await run(["list", "--json"], d)).stdout) as { decisions: { category: string; decision: { assignmentSource: string; selection?: { modelId: string } } }[] };
    const review = listed.decisions.find((row) => row.category === "review")!;
    expect(review.decision.assignmentSource).toBe("user");
    expect(review.decision.selection?.modelId).toBe("claude-x");
  });

  test("settings list works without activation and the old activation commands are gone", async () => {
    const d = await deps();
    const listed = await run(["settings", "list"], d);
    expect(listed.error).toBeUndefined();
    expect(JSON.parse(listed.stdout)).toHaveProperty("revision");
    const apply = await run(["migrate", "--apply", "plan.json", "--confirm"], d);
    expect(apply.error?.message ?? apply.stderr).toMatch(/Usage: keryx routing migrate/);
    const legacy = await run(["set", "review", "anthropic/claude-x", "--legacy"], d);
    expect(legacy.error?.message ?? legacy.stderr).toMatch(/--legacy/);
  });

  test("migrate converts legacy settings into canonical ones and is idempotent", async () => {
    const d = await deps();
    await writeFile(path.join(d.userConfigDir, "auth.json"), JSON.stringify({
      apiKeys: { ANTHROPIC_API_KEY: "sk-test" },
      routing: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } },
    }));
    const first = await run(["migrate"], d);
    expect(first.error).toBeUndefined();
    expect(JSON.parse(first.stdout)).toMatchObject({ user: "migrated" });
    const second = await run(["migrate"], d);
    expect(JSON.parse(second.stdout)).toMatchObject({ user: "kept" });
    const auth = JSON.parse(await readFile(path.join(d.userConfigDir, "auth.json"), "utf8"));
    expect(auth.apiKeys).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
    expect(auth.modelRouting.categories.review).toEqual({ mode: "model", target: { providerId: "anthropic", modelId: "claude-x" } });
  });
});
