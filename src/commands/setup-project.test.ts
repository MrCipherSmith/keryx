import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

async function fixture(run: (root: string, env: Record<string, string | undefined>) => Promise<void>) {
  const temp = await mkdtemp(path.join(tmpdir(), "keryx-setup-json-"));
  const root = path.join(temp, "repo");
  try {
    await mkdir(root);
    await run(root, { ...process.env, XDG_DATA_HOME: path.join(temp, "data"), APPDATA: path.join(temp, "data") });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function setup(root: string, env: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, ...SAFE_BUN_SPAWN_ARGS, cli, "setup", ...args, "--json"], {
    cwd: root, env, stdout: "pipe", stderr: "pipe",
  });
  return { exit: child.exitCode, json: JSON.parse(child.stdout.toString()) };
}

test("setup checks an approved plan, preserves the Git ignore file and applies the previewed Markdown", async () => {
  await fixture(async (root, env) => {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root, env }).exitCode).toBe(0);
    const request = JSON.stringify({
      schemaVersion: 1, gitignore: true, sharedAgents: true,
      modules: { gdgraph: false, gdctx: false, gdwiki: false, gdskills: false, health: false, testing: false, memory: false, tasks: false, security: false },
    });
    const state = setup(root, env, "inspect");
    expect(state.exit).toBe(0);
    expect(state.json).toMatchObject({ schemaVersion: 1, operation: "inspect", state: "uninitialized" });

    const initial = setup(root, env, "plan", "--request", request);
    expect(initial.json).toMatchObject({ schemaVersion: 1, status: "ready", mode: "init" });
    expect(existsSync(path.join(root, ".metaproject"))).toBe(false);
    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);

    const ignore = path.join(root, ".gitignore");
    await writeFile(ignore, "user-cache/");
    const stale = setup(root, env, "apply", "--request", request, "--plan-id", initial.json.planId);
    expect(stale.exit).toBe(1);
    expect(stale.json.error.code).toBe("stale-plan");
    expect(existsSync(path.join(root, ".metaproject"))).toBe(false);
    expect(await readFile(ignore, "utf8")).toBe("user-cache/");

    const fresh = setup(root, env, "plan", "--request", request);
    expect(fresh.json.gitignore.after).toBe("user-cache/\n/.metaproject/\n");
    const claude = (fresh.json.entrypoints as Array<{ path: string; after?: string }>).find(({ path }) => path === "CLAUDE.local.md");
    const agents = (fresh.json.entrypoints as Array<{ path: string; after?: string }>).find(({ path }) => path === "AGENTS.md");
    if (claude?.after === undefined || agents?.after === undefined) throw new Error("Missing entrypoint previews");

    const applied = setup(root, env, "apply", "--request", request, "--plan-id", fresh.json.planId);
    expect(applied.exit).toBe(0);
    expect(applied.json).toMatchObject({ status: "completed", journaled: true, steps: [
      { id: "init", status: "completed" },
      { id: "gitignore", status: "completed" },
    ] });
    expect(await readFile(ignore, "utf8")).toBe(fresh.json.gitignore.after);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toBe(claude.after);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(agents.after);
    expect(setup(root, env, "inspect").json).toMatchObject({
      state: "initialized", compatibility: "current", lastApply: { status: "completed" },
    });
  });
}, 30_000);

test("setup diagnoses wrong roots and malformed manifests without silently applying", async () => {
  await fixture(async (root, env) => {
    const meta = path.join(root, ".metaproject");
    const nested = path.join(root, "src");
    await mkdir(meta);
    await mkdir(nested);
    await writeFile(path.join(meta, "metaproject.json"), "{");
    expect(setup(root, env, "inspect").json).toMatchObject({
      state: "incomplete", findings: [expect.objectContaining({ id: "invalid-manifest" })],
    });
    const request = '{"schemaVersion":1}';
    const plan = setup(root, env, "plan", "--request", request);
    expect(plan.json.status).toBe("blocked");
    expect(setup(root, env, "apply", "--request", request, "--plan-id", plan.json.planId).json.error.code).toBe("blocked-plan");
    expect(setup(nested, env, "plan", "--request", request).json).toMatchObject({
      status: "blocked", blocked: [expect.objectContaining({ id: "nested-folder" })],
    });
    expect(setup(root, env, "plan", "--request", '{"schemaVersion":1,"actions":["anything"]}').json.error.code).toBe("invalid-request");
    expect(await readFile(path.join(meta, "metaproject.json"), "utf8")).toBe("{");
  });
}, 30_000);

test("update previews preserved opt-in settings and refuses a newer writer", async () => {
  await fixture(async (root, env) => {
    const meta = path.join(root, ".metaproject");
    await mkdir(path.join(meta, "runtime", "install"), { recursive: true });
    await writeFile(path.join(meta, "metaproject.json"), JSON.stringify({ modules: { mcp: { enabled: true }, tasks: { enabled: false } } }));
    const request = '{"schemaVersion":1,"actions":["wikiIndex"],"graph":"rebuild"}';
    const plan = setup(root, env, "plan", "--request", request);
    expect(plan.json).toMatchObject({ status: "ready", mode: "update", steps: [
      { id: "update", status: "ready" },
      { id: "graph", status: "skipped" },
      { id: "wikiIndex", status: "skipped" },
    ], effects: { fetchRuntime: false, runCustomHooks: false, pruneWorktrees: false } });
    expect(plan.json.modules).toContainEqual(expect.objectContaining({ name: "mcp", selected: true }));
    expect(plan.json.modules).toContainEqual(expect.objectContaining({ name: "tasks", selected: false }));

    await writeFile(path.join(meta, "runtime", "install", "journal.json"), JSON.stringify({
      schemaVersion: "1.0", writerVersion: "999.0.0", steps: {},
    }));
    expect(setup(root, env, "inspect").json.compatibility).toBe("newer");
    expect(setup(root, env, "plan", "--request", request).json).toMatchObject({
      status: "blocked", blocked: [expect.objectContaining({ id: "newer-project-writer" })],
    });
  });
}, 30_000);
