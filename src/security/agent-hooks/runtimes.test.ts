import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  installRuntimeHooks,
  uninstallRuntimeHooks,
  resolveRuntimes,
} from "../agent-hooks";
import {
  getRuntime,
  runtimeIds,
  AGENT_CHECK_INPUT_COMMAND,
  AGENT_CHECK_OUTPUT_COMMAND,
} from "./runtimes";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-runtimes-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

// AC5.1 — ≥3 runtimes each emit a validator-checked config routing input/output.
test("AC5.1: every registered runtime installs a validator-clean input/output config", async () => {
  expect(runtimeIds().length).toBeGreaterThanOrEqual(4); // claude + cursor + windsurf + generic-mcp
  await withTempDir(async (root) => {
    for (const id of runtimeIds()) {
      const runtime = getRuntime(id)!;
      await installRuntimeHooks(root, runtime);
      const settings = await readJson(runtime.settingsPath(root));
      expect(runtime.validate(settings)).toEqual([]);
      const flat = JSON.stringify(settings);
      expect(flat).toContain(AGENT_CHECK_INPUT_COMMAND);
      expect(flat).toContain(AGENT_CHECK_OUTPUT_COMMAND);
    }
  });
});

// AC5.2 — installing a 2nd runtime never touches the first runtime's config nor
// pre-existing user keys; re-install is idempotent (no duplicate managed groups).
test("AC5.2: second runtime install preserves user keys + first runtime; re-install idempotent", async () => {
  await withTempDir(async (root) => {
    const cursor = getRuntime("cursor")!;
    // Pre-existing user content in the cursor config.
    await mkdir(path.dirname(cursor.settingsPath(root)), { recursive: true });
    await writeFile(
      cursor.settingsPath(root),
      `${JSON.stringify(
        { editor: "vim", hooks: [{ on: "custom", command: "user-cursor-hook" }] },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Install claude first, then cursor (the "second runtime").
    await installRuntimeHooks(root, getRuntime("claude")!);
    await installRuntimeHooks(root, cursor);

    const cursorSettings = await readJson(cursor.settingsPath(root));
    expect(cursorSettings.editor).toBe("vim");
    const groups = cursorSettings.hooks as Array<{ on?: string; command?: string }>;
    expect(groups.some((g) => g.command === "user-cursor-hook")).toBe(true);
    expect(cursor.validate(cursorSettings)).toEqual([]);

    // Claude config is untouched by the cursor install.
    const claudeSettings = await readJson(getRuntime("claude")!.settingsPath(root));
    expect(getRuntime("claude")!.validate(claudeSettings)).toEqual([]);

    // Idempotent re-install: exactly one managed input group survives.
    await installRuntimeHooks(root, cursor);
    const after = await readJson(cursor.settingsPath(root));
    const managedInputs = (after.hooks as Array<{ on?: string }>).filter(
      (g) => g.on === "input",
    );
    expect(managedInputs.length).toBe(1);
  });
});

// AC5.3 — uninstall removes ONLY the named runtime's managed entries; user
// content and other runtimes stay intact.
test("AC5.3: targeted uninstall removes only the named runtime's managed entries", async () => {
  await withTempDir(async (root) => {
    const cursor = getRuntime("cursor")!;
    await mkdir(path.dirname(cursor.settingsPath(root)), { recursive: true });
    await writeFile(
      cursor.settingsPath(root),
      `${JSON.stringify({ hooks: [{ on: "custom", command: "user-cursor-hook" }] }, null, 2)}\n`,
      "utf8",
    );

    await installRuntimeHooks(root, cursor);
    await installRuntimeHooks(root, getRuntime("windsurf")!);
    await uninstallRuntimeHooks(root, cursor);

    const cursorSettings = await readJson(cursor.settingsPath(root));
    const flat = JSON.stringify(cursorSettings);
    expect(flat).not.toContain(AGENT_CHECK_INPUT_COMMAND);
    expect(flat).not.toContain("security-agent-hooks");
    // User content survives.
    expect((cursorSettings.hooks as Array<{ command?: string }>).some((g) => g.command === "user-cursor-hook")).toBe(true);

    // Windsurf is untouched by the cursor uninstall.
    const windsurf = getRuntime("windsurf")!;
    const windsurfSettings = await readJson(windsurf.settingsPath(root));
    expect(windsurf.validate(windsurfSettings)).toEqual([]);
  });
});

test("resolveRuntimes: 'all' expands to every runtime; unknown ids reported", () => {
  const all = resolveRuntimes(["all"]);
  expect(all.runtimes.map((r) => r.id).sort()).toEqual(runtimeIds().sort());
  expect(all.unknown).toEqual([]);
  const bad = resolveRuntimes(["cursor", "nope"]);
  expect(bad.runtimes.map((r) => r.id)).toEqual(["cursor"]);
  expect(bad.unknown).toEqual(["nope"]);
});
