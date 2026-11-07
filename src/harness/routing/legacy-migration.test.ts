// Acceptance: settings written by earlier releases keep their effect under the
// primary routing engine. Three old shapes exist on disk:
//   1. the legacy category table (`auth.json.routing`, `routing.config.json.categories`)
//      with its project approval in `routing-config-trust.json`;
//   2. opt-in engine settings (`auth.json.routingV2`, `routing.config.json.modelRouting`)
//      that only took effect behind an activation marker under `<configDir>/routing-v2/`;
//   3. that marker itself.
// Each is read only by the migration module. Reads convert in memory; the
// explicit migration writes canonical keys once and never clobbers them.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { routingDigest } from "./config";
import { migrateLegacyRouting } from "./legacy-migration";
import { loadRouting, readRoutingSettings, setRoutingCategory } from "./settings";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const cwd = path.resolve(await mkdtemp(path.join(tmpdir(), "keryx-routing-migration-project-")));
  const configDir = path.resolve(await mkdtemp(path.join(tmpdir(), "keryx-routing-migration-config-")));
  roots.push(cwd, configDir);
  return {
    cwd,
    configDir,
    location: { cwd, configDir },
    authFile: path.join(configDir, "auth.json"),
    projectFile: path.join(cwd, "routing.config.json"),
    trustFile: path.join(configDir, "routing-config-trust.json"),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The fingerprint earlier releases recorded for an approved legacy table, recomputed independently. */
function legacyTableFingerprint(table: Record<string, Record<string, string>>): string {
  const categories = Object.keys(table).sort();
  return sha256(JSON.stringify(categories.map((c) => [c, Object.entries(table[c]!).sort(([a], [b]) => a.localeCompare(b))])));
}

async function writeActivationMarker(f: Fixture, project: unknown, user: unknown, engineVersion: 1 | 2 = 2): Promise<void> {
  const dir = path.join(f.configDir, "routing-v2", "activations");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sha256(f.cwd)}.json`);
  const marker = engineVersion === 2
    ? {
        schemaVersion: 2, engineVersion: 2, migrationId: "m-1", planDigest: "p-1", activatedAt: "2026-10-01T00:00:00.000Z",
        projectRoot: f.cwd, configRoot: f.configDir, revision: "r-1",
        targets: {
          project: { path: f.projectFile, digest: "d", fragmentDigest: routingDigest(project ?? null) },
          user: { path: f.authFile, digest: "d", fragmentDigest: routingDigest(user ?? null) },
        },
      }
    : {
        schemaVersion: 2, engineVersion: 1, deactivatedMigrationId: "m-1", planDigest: "p-1",
        deactivatedAt: "2026-10-02T00:00:00.000Z", projectRoot: f.cwd, configRoot: f.configDir,
      };
  await writeFile(file, JSON.stringify(marker), { mode: 0o600 });
  await chmod(file, 0o600);
}

const MODEL = { providerId: "anthropic", modelId: "claude-x" };

describe("legacy category table", () => {
  test("user assignments keep their effect; provider defaults resolve to a concrete model or are reported", async () => {
    const f = await fixture();
    await writeFile(f.authFile, JSON.stringify({
      routing: {
        review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
        docs: { kind: "session-default" },
        quick: { kind: "provider-default", providerId: "ollama" },
      },
    }));
    const settings = readRoutingSettings(f.location);
    expect(settings.user.source).toBe("legacy-table");
    const config = loadRouting(f.cwd, f.configDir);
    expect(config.categories.review).toEqual({ mode: "model", target: MODEL });
    expect(config.categorySources.review).toBe("user");
    expect(config.categories.docs).toEqual({ mode: "baseline" });
    expect(config.categories.quick).toEqual({ mode: "model", target: { providerId: "ollama", modelId: "llama3.1:latest" } });
  });

  test("a provider default with no known model is surfaced as unresolved, never routed on the baseline", async () => {
    const f = await fixture();
    await writeFile(f.authFile, JSON.stringify({
      routing: {
        review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
        planning: { kind: "provider-default", providerId: "no-such-provider" },
      },
    }));
    expect(() => loadRouting(f.cwd, f.configDir)).toThrow(/planning -> no-such-provider \(provider default\) has no known default model/);
    await expect(migrateLegacyRouting(f.location)).rejects.toThrow(/no-such-provider/);
    expect(JSON.parse(await readFile(f.authFile, "utf8")).modelRouting).toBeUndefined();
    await expect(setRoutingCategory("user", f.location, "docs", { mode: "baseline" })).rejects.toThrow(/no-such-provider/);

    await setRoutingCategory("user", f.location, "planning", { mode: "class", modelClass: "expert" });
    const config = loadRouting(f.cwd, f.configDir);
    expect(config.categories.planning).toEqual({ mode: "class", modelClass: "expert" });
    expect(config.categories.review).toEqual({ mode: "model", target: MODEL });
  });

  test("an interrupted activation change refuses migration instead of reading past it", async () => {
    const f = await fixture();
    const user = { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } };
    await writeFile(f.authFile, JSON.stringify({ routingV2: user }));
    await writeActivationMarker(f, undefined, user);
    const marker = path.join(f.configDir, "routing-v2", "activations", `${sha256(f.cwd)}.json`);
    await writeFile(`${marker}.edit.json`, "{}", { mode: 0o600 });
    expect(() => loadRouting(f.cwd, f.configDir)).toThrow(/interrupted routing activation change is pending/);
    await expect(migrateLegacyRouting(f.location)).rejects.toThrow(/interrupted routing activation change/);
  });

  test("opt-in settings edited after activation fail closed rather than applying unapproved content", async () => {
    const f = await fixture();
    const activated = { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } };
    const project = { schemaVersion: 2, classes: { expert: { candidates: [{ target: MODEL, enabled: true, priority: 1 }], selection: "priority", fallbackClasses: [] } } };
    await writeFile(f.authFile, JSON.stringify({ routingV2: { ...activated, categories: { review: { mode: "class", modelClass: "frontier" } } } }));
    await writeActivationMarker(f, { schemaVersion: 2 }, activated);
    expect(() => loadRouting(f.cwd, f.configDir)).toThrow(/no longer matches its activation/);

    await writeFile(f.authFile, JSON.stringify({ routingV2: activated }));
    await writeFile(f.projectFile, JSON.stringify({ modelRouting: project }));
    const settings = readRoutingSettings(f.location);
    expect(settings.project.trusted).toBe(false);
    expect(loadRouting(f.cwd, f.configDir).classes.expert.candidates).toEqual([]);
  });

  test("an approved legacy project table stays trusted; an unapproved one stays ignored", async () => {
    const f = await fixture();
    const table = { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } };
    await writeFile(f.projectFile, JSON.stringify({ categories: table }));
    expect(readRoutingSettings(f.location).project.trusted).toBe(false);
    expect(loadRouting(f.cwd, f.configDir).categorySources.review).toBe("builtin");

    await writeFile(f.trustFile, JSON.stringify({ approvals: { [f.cwd]: legacyTableFingerprint(table) } }));
    const settings = readRoutingSettings(f.location);
    expect(settings.project.source).toBe("legacy-table");
    expect(settings.project.trusted).toBe(true);
    expect(loadRouting(f.cwd, f.configDir).categories.review).toEqual({ mode: "model", target: MODEL });
    expect(loadRouting(f.cwd, f.configDir).categorySources.review).toBe("project");
  });

  test("a malformed legacy entry is surfaced, not dropped", async () => {
    const f = await fixture();
    await writeFile(f.authFile, JSON.stringify({ routing: { review: { kind: "teleport" } } }));
    expect(() => loadRouting(f.cwd, f.configDir)).toThrow(/unknown kind "teleport"/);
  });
});

describe("opt-in engine settings", () => {
  test("activated settings stay effective without the marker gate and win over the legacy table", async () => {
    const f = await fixture();
    const user = { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } };
    const project = { schemaVersion: 2, categories: { docs: { mode: "model", target: MODEL } } };
    await writeFile(f.authFile, JSON.stringify({
      routing: { review: { kind: "model", providerId: "deepseek", modelId: "deepseek-chat" } },
      routingV2: user,
    }));
    await writeFile(f.projectFile, JSON.stringify({ modelRouting: project }));
    await writeActivationMarker(f, project, user);

    const settings = readRoutingSettings(f.location);
    expect(settings.user.source).toBe("opt-in");
    expect(settings.project.trusted).toBe(true);
    const config = loadRouting(f.cwd, f.configDir);
    expect(config.categories.review).toEqual({ mode: "class", modelClass: "expert" });
    expect(config.categories.docs).toEqual({ mode: "model", target: MODEL });
    expect(config.categorySources.docs).toBe("project");
  });

  test("settings the operator deactivated do not come back; the legacy table they returned to applies", async () => {
    const f = await fixture();
    const user = { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } };
    await writeFile(f.authFile, JSON.stringify({
      routing: { review: { kind: "model", providerId: "deepseek", modelId: "deepseek-chat" } },
      routingV2: user,
    }));
    await writeActivationMarker(f, undefined, user, 1);
    const config = loadRouting(f.cwd, f.configDir);
    expect(config.categories.review).toEqual({ mode: "model", target: { providerId: "deepseek", modelId: "deepseek-chat" } });
    expect(readRoutingSettings(f.location).user.source).toBe("legacy-table");
  });
});

describe("project-activated user settings", () => {
  test("stay scoped to the project that activated them unless the operator adopts them globally", async () => {
    const f = await fixture();
    const user = { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } };
    await writeFile(f.authFile, JSON.stringify({ apiKeys: { K: "v" }, routingV2: user }));
    await writeActivationMarker(f, undefined, user);

    const scoped = await migrateLegacyRouting(f.location);
    expect(scoped.user).toBe("project-scoped");
    expect(JSON.parse(await readFile(f.authFile, "utf8")).modelRouting).toBeUndefined();
    expect(loadRouting(f.cwd, f.configDir).categories.review).toEqual({ mode: "class", modelClass: "expert" });

    // Another project never activated them, so they do not apply there.
    const other = path.resolve(await mkdtemp(path.join(tmpdir(), "keryx-routing-migration-other-")));
    roots.push(other);
    expect(loadRouting(other, f.configDir).categorySources.review).toBe("builtin");

    // A category write from the activating project would make them global; it is refused.
    await expect(setRoutingCategory("user", f.location, "docs", { mode: "baseline" })).rejects.toThrow(/activated for this project only/);

    const adopted = await migrateLegacyRouting(f.location, {}, { includeActivatedUser: true });
    expect(adopted.user).toBe("migrated");
    expect(JSON.parse(await readFile(f.authFile, "utf8")).modelRouting).toEqual(user);
    expect(loadRouting(other, f.configDir).categories.review).toEqual({ mode: "class", modelClass: "expert" });
  });
});

describe("explicit migration", () => {
  test("writes canonical keys once, keeps unrelated and legacy settings, carries the project approval", async () => {
    const f = await fixture();
    const table = { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } };
    const auth = {
      apiKeys: { ANTHROPIC_API_KEY: "sk-test" },
      provider: "anthropic",
      routing: { docs: { kind: "model", providerId: "deepseek", modelId: "deepseek-chat" } },
    };
    await writeFile(f.authFile, JSON.stringify(auth));
    await writeFile(f.projectFile, JSON.stringify({ reviewChunks: { maxFiles: 2 }, categories: table }));
    await writeFile(f.trustFile, JSON.stringify({ approvals: { [f.cwd]: legacyTableFingerprint(table) } }));

    const first = await migrateLegacyRouting(f.location);
    expect(first).toMatchObject({ user: "migrated", project: "migrated" });
    const authAfter = JSON.parse(await readFile(f.authFile, "utf8"));
    expect(authAfter).toEqual({
      ...auth,
      modelRouting: { schemaVersion: 2, categories: { docs: { mode: "model", target: { providerId: "deepseek", modelId: "deepseek-chat" } } } },
    });
    const projectAfter = JSON.parse(await readFile(f.projectFile, "utf8"));
    expect(projectAfter).toEqual({
      reviewChunks: { maxFiles: 2 },
      categories: table,
      modelRouting: { schemaVersion: 2, categories: { review: { mode: "model", target: MODEL } } },
    });
    const settings = readRoutingSettings(f.location);
    expect(settings.user.source).toBe("canonical");
    expect(settings.project.source).toBe("canonical");
    expect(settings.project.trusted).toBe(true);

    const authBytes = await readFile(f.authFile, "utf8");
    const projectBytes = await readFile(f.projectFile, "utf8");
    const second = await migrateLegacyRouting(f.location);
    expect(second).toMatchObject({ user: "kept", project: "kept" });
    expect(await readFile(f.authFile, "utf8")).toBe(authBytes);
    expect(await readFile(f.projectFile, "utf8")).toBe(projectBytes);
  });

  test("never clobbers canonical settings that already exist", async () => {
    const f = await fixture();
    const canonical = { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "light" } } };
    await writeFile(f.authFile, JSON.stringify({
      modelRouting: canonical,
      routing: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } },
    }));
    const before = await readFile(f.authFile, "utf8");
    expect(await migrateLegacyRouting(f.location)).toMatchObject({ user: "kept", project: "none" });
    expect(await readFile(f.authFile, "utf8")).toBe(before);
    expect(loadRouting(f.cwd, f.configDir).categories.review).toEqual({ mode: "class", modelClass: "light" });
  });

  test("an unapproved legacy project table is migrated without granting it trust", async () => {
    const f = await fixture();
    await writeFile(f.projectFile, JSON.stringify({ categories: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } } }));
    expect(await migrateLegacyRouting(f.location)).toMatchObject({ project: "migrated" });
    expect(readRoutingSettings(f.location).project.trusted).toBe(false);
    expect(loadRouting(f.cwd, f.configDir).categorySources.review).toBe("builtin");
  });
});
