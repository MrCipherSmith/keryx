// Acceptance: the model routing engine is the only engine and is on by default.
// No activation marker, no opt-in flag: an unconfigured project resolves every
// category from the built-in baseline, user and trusted project layers apply as
// soon as they are written, and writes land under the canonical `modelRouting`
// key without touching anything else in `auth.json` or `routing.config.json`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROUTING_CATEGORIES } from "./table";
import {
  approveProjectRouting,
  loadRouting,
  readRoutingSettings,
  setRoutingCategory,
  unsetRoutingCategory,
  updateRoutingLayer,
} from "./settings";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-routing-settings-project-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "keryx-routing-settings-config-"));
  roots.push(cwd, configDir);
  return {
    cwd,
    configDir,
    authFile: path.join(configDir, "auth.json"),
    projectFile: path.join(cwd, "routing.config.json"),
  };
}

const MODEL = { providerId: "anthropic", modelId: "claude-x" } as const;

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("primary routing is the default engine", () => {
  test("an unconfigured project still gets a routing config: every category resolves from the built-in baseline", async () => {
    const f = await fixture();
    const config = loadRouting(f.cwd, f.configDir);
    expect(config.schemaVersion).toBe(2);
    for (const category of ROUTING_CATEGORIES) {
      expect(config.categories[category]).toEqual({ mode: "baseline" });
      expect(config.categorySources[category]).toBe("builtin");
    }
    expect(existsSync(path.join(f.configDir, "routing-v2"))).toBe(false);
  });

  test("a canonical user layer applies without any activation marker", async () => {
    const f = await fixture();
    await writeFile(f.authFile, JSON.stringify({
      apiKeys: { ANTHROPIC_API_KEY: "sk-test" },
      modelRouting: { schemaVersion: 2, categories: { review: { mode: "model", target: MODEL } } },
    }));
    const config = loadRouting(f.cwd, f.configDir);
    expect(config.categories.review).toEqual({ mode: "model", target: MODEL });
    expect(config.categorySources.review).toBe("user");
  });

  test("a project layer applies only after trust approval, and an edit voids the approval", async () => {
    const f = await fixture();
    await writeFile(f.projectFile, JSON.stringify({
      reviewChunks: { maxFiles: 3 },
      modelRouting: { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } },
    }));
    const before = readRoutingSettings({ cwd: f.cwd, configDir: f.configDir });
    expect(before.project.trusted).toBe(false);
    expect(before.notices.join("\n")).toContain("keryx routing trust");
    expect(loadRouting(f.cwd, f.configDir).categorySources.review).toBe("builtin");

    const approval = approveProjectRouting({ cwd: f.cwd, configDir: f.configDir });
    expect(approval.ok).toBe(true);
    expect(loadRouting(f.cwd, f.configDir).categories.review).toEqual({ mode: "class", modelClass: "expert" });
    expect(loadRouting(f.cwd, f.configDir).categorySources.review).toBe("project");

    await writeFile(f.projectFile, JSON.stringify({
      modelRouting: { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "frontier" } } },
    }));
    expect(loadRouting(f.cwd, f.configDir).categorySources.review).toBe("builtin");
    expect(readRoutingSettings({ cwd: f.cwd, configDir: f.configDir }).project.trusted).toBe(false);
  });

  test("a malformed canonical layer is a surfaced error, never a silent baseline", async () => {
    const f = await fixture();
    await writeFile(f.authFile, JSON.stringify({ modelRouting: { schemaVersion: 2, categories: { review: { mode: "sideways" } } } }));
    expect(() => loadRouting(f.cwd, f.configDir)).toThrow(/categories\.review\.mode is invalid/);
    await writeFile(f.authFile, JSON.stringify({}));
    await writeFile(f.projectFile, "{ not json");
    expect(() => loadRouting(f.cwd, f.configDir)).toThrow(/routing\.config\.json/);
  });

  test("category writes use the canonical key and keep unrelated auth and project settings byte-for-byte", async () => {
    const f = await fixture();
    const auth = { apiKeys: { ANTHROPIC_API_KEY: "sk-test" }, provider: "anthropic", model: "claude-y", oauth: { token: "t" } };
    await writeFile(f.authFile, JSON.stringify(auth));
    await writeFile(f.projectFile, JSON.stringify({ reviewChunks: { maxFiles: 3 } }));

    await setRoutingCategory("user", { cwd: f.cwd, configDir: f.configDir }, "review", { mode: "model", target: MODEL });
    await setRoutingCategory("project", { cwd: f.cwd, configDir: f.configDir }, "docs", { mode: "class", modelClass: "light" });

    const authAfter = await readJson(f.authFile);
    expect(authAfter).toEqual({ ...auth, modelRouting: { schemaVersion: 2, categories: { review: { mode: "model", target: MODEL } } } });
    expect(authAfter.routingV2).toBeUndefined();
    const projectAfter = await readJson(f.projectFile);
    expect(projectAfter).toEqual({
      reviewChunks: { maxFiles: 3 },
      modelRouting: { schemaVersion: 2, categories: { docs: { mode: "class", modelClass: "light" } } },
    });

    await unsetRoutingCategory("user", { cwd: f.cwd, configDir: f.configDir }, "review");
    expect((await readJson(f.authFile)).modelRouting).toEqual({ schemaVersion: 2, categories: {} });
    expect(loadRouting(f.cwd, f.configDir).categorySources.review).toBe("builtin");
  });

  test("layer replacement is guarded by the settings revision", async () => {
    const f = await fixture();
    const location = { cwd: f.cwd, configDir: f.configDir };
    const { revision } = readRoutingSettings(location);
    const next = { schemaVersion: 2 as const, categories: { quick: { mode: "class" as const, modelClass: "light" as const } } };
    const updated = await updateRoutingLayer({ ...location, scope: "user", expectedRevision: revision, next });
    expect(updated.status).toBe("updated");
    await expect(updateRoutingLayer({ ...location, scope: "user", expectedRevision: revision, next: { schemaVersion: 2 } }))
      .rejects.toThrow(/revision conflict/);
    expect(loadRouting(f.cwd, f.configDir).categories.quick).toEqual({ mode: "class", modelClass: "light" });
  });
});
