import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoutingTable } from "./table";
import {
  applyRoutingV2Migration,
  createRoutingV2MigrationPlan,
  deactivateRoutingV2,
  proposeRoutingV2Categories,
  readActiveRoutingV2Settings,
  readActiveRoutingV2Layers,
  rollbackRoutingV2Migration,
  routingV2ActivationPath,
  updateActiveRoutingV2Layer,
  type RoutingV2MigrationFaultPoint,
  type RoutingV2RollbackFaultPoint,
} from "./migration-v2";

const roots: string[] = [];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-routing-v2-migration-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const configDir = path.join(root, "config");
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await chmod(configDir, 0o700);
  const projectFile = path.join(cwd, "routing.config.json");
  const userFile = path.join(configDir, "auth.json");
  const projectBytes = '{"keep":"project","categories":{"coding":{"kind":"model","providerId":"anthropic","modelId":"claude-sonnet"}}}\n';
  const userBytes = '{"apiKeys":{"anthropic":"secret-value"},"keep":"user","routing":{"quick":{"kind":"session-default"}}}\n';
  await writeFile(projectFile, projectBytes);
  await writeFile(userFile, userBytes, { mode: 0o600 });
  const project = {
    schemaVersion: 2 as const,
    categories: { coding: { mode: "model" as const, target: { providerId: "anthropic", modelId: "claude-sonnet" } } },
  };
  const user = { schemaVersion: 2 as const, categories: { quick: { mode: "baseline" as const } } };
  return { root, cwd, configDir, projectFile, userFile, projectBytes, userBytes, project, user };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("routing v2 migration", () => {
  test("dry-run is read-only, exact, tamper-evident, and never embeds auth secrets", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });

    expect(JSON.stringify(plan)).not.toContain("secret-value");
    expect(plan.diff.map((entry) => entry.path)).toEqual(["/modelRouting", "/routingV2"]);
    expect(plan.rollback.targets.user).toMatchObject({ path: f.userFile, existed: true, digest: plan.targets.user.inputDigest });
    expect(plan.planDigest).toHaveLength(64);
    expect(await readFile(f.projectFile, "utf8")).toBe(f.projectBytes);
    expect(await readFile(f.userFile, "utf8")).toBe(f.userBytes);
    expect(await Bun.file(routingV2ActivationPath(f.cwd, f.configDir)).exists()).toBe(false);
  });

  test("apply requires explicit confirmation and zero unresolved mappings", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({
      cwd: f.cwd,
      configDir: f.configDir,
      project: f.project,
      user: f.user,
      unresolved: [{ code: "provider-default", message: "materialize a model or choose a class" }],
    });
    await expect(applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).rejects.toThrow("unresolved");
    const clean = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await expect(applyRoutingV2Migration(clean, { confirmed: false, cwd: f.cwd, configDir: f.configDir })).rejects.toThrow("confirmation");
  });

  test("apply rejects a stale or tampered plan", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await expect(applyRoutingV2Migration(plan, { confirmed: true, cwd: path.join(f.root, "other-project"), configDir: f.configDir })).rejects.toThrow("invalid projectRoot");
    await writeFile(f.projectFile, `${f.projectBytes.trim()} `);
    await expect(applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).rejects.toThrow("stale");
    await expect(applyRoutingV2Migration({ ...plan, migrationId: "tampered" }, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).rejects.toThrow("digest");
  });

  test("apply rejects an internally inconsistent plan even with a recomputed envelope digest", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    const changed = { ...plan, diff: plan.diff.map((entry) => entry.layer === "project" ? { ...entry, after: null } : entry) };
    const { planDigest: _oldDigest, ...body } = changed;
    const tampered = { ...body, planDigest: digest(body) } as typeof plan;
    await expect(applyRoutingV2Migration(tampered, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).rejects.toThrow("diff does not match");
  });

  test("malformed source config blocks dry-run without creating trusted state", async () => {
    const f = await fixture();
    await writeFile(f.projectFile, "{not-json");
    await expect(createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user })).rejects.toThrow("malformed JSON");
    expect(await Bun.file(routingV2ActivationPath(f.cwd, f.configDir)).exists()).toBe(false);
  });

  test("apply preserves legacy data, activates last, and is idempotent", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    expect(await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "applied" });
    expect(await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "already-applied" });

    const project = JSON.parse(await readFile(f.projectFile, "utf8"));
    const user = JSON.parse(await readFile(f.userFile, "utf8"));
    expect(project).toMatchObject({ keep: "project", categories: expect.any(Object), modelRouting: f.project });
    expect(user).toMatchObject({ keep: "user", apiKeys: { anthropic: "secret-value" }, routingV2: f.user });
    expect(readActiveRoutingV2Layers(f.cwd, f.configDir)).toEqual({ project: f.project, user: f.user });
    if (process.platform !== "win32") expect((await stat(routingV2ActivationPath(f.cwd, f.configDir))).mode & 0o777).toBe(0o600);
  });

  test("a crash before activation leaves legacy active and the same plan resumes", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    const failAt = (point: RoutingV2MigrationFaultPoint) => {
      if (point === "after-project-write") throw new Error("simulated crash");
    };
    await expect(applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir, fault: failAt })).rejects.toThrow("simulated crash");
    expect(readActiveRoutingV2Layers(f.cwd, f.configDir)).toBeUndefined();
    expect(await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "applied" });
  });

  test("concurrent project edits at transaction seams are preserved and never activated", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await expect(applyRoutingV2Migration(plan, {
      confirmed: true,
      cwd: f.cwd,
      configDir: f.configDir,
      fault: async (point) => {
        if (point === "after-backup") await writeFile(f.projectFile, '{"concurrent":"must-survive"}\n');
      },
    })).rejects.toThrow("became stale");
    expect(await readFile(f.projectFile, "utf8")).toBe('{"concurrent":"must-survive"}\n');
    expect(await Bun.file(routingV2ActivationPath(f.cwd, f.configDir)).exists()).toBe(false);

    const retry = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await expect(applyRoutingV2Migration(retry, {
      confirmed: true,
      cwd: f.cwd,
      configDir: f.configDir,
      fault: async (point) => {
        if (point !== "before-activation") return;
        const current = JSON.parse(await readFile(f.projectFile, "utf8"));
        await writeFile(f.projectFile, `${JSON.stringify({ ...current, modelRouting: { schemaVersion: 2, categories: { coding: { mode: "baseline" } } } }, null, 2)}\n`);
      },
    })).rejects.toThrow("verification failed");
    expect(await Bun.file(routingV2ActivationPath(f.cwd, f.configDir)).exists()).toBe(false);
  });

  test("null and already-identical target layers are no-op writes but may be activated", async () => {
    const f = await fixture();
    const oneLayer = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project });
    expect(oneLayer.targets.user.writeRequired).toBe(false);
    await applyRoutingV2Migration(oneLayer, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    expect((JSON.parse(await readFile(f.userFile, "utf8")) as Record<string, unknown>).routingV2).toBeUndefined();
    await rollbackRoutingV2Migration(oneLayer, { confirmed: true, cwd: f.cwd, configDir: f.configDir });

    const projectBytes = `${JSON.stringify({ keep: "project", modelRouting: f.project })}\n`;
    const userBytes = `${JSON.stringify({ keep: "user", routingV2: f.user })}\n`;
    await writeFile(f.projectFile, projectBytes);
    await writeFile(f.userFile, userBytes, { mode: 0o600 });
    const identical = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    expect([identical.targets.project.writeRequired, identical.targets.user.writeRequired]).toEqual([false, false]);
    await applyRoutingV2Migration(identical, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    expect(await readFile(f.projectFile, "utf8")).toBe(projectBytes);
    expect(await readFile(f.userFile, "utf8")).toBe(userBytes);
  });

  test("migration refuses project and auth symlinks", async () => {
    const f = await fixture();
    const shared = path.join(f.root, "shared.json");
    await writeFile(shared, "{}\n");
    await rm(f.projectFile);
    await symlink(shared, f.projectFile);
    await expect(createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project })).rejects.toThrow("non-symlink");

    await rm(f.projectFile);
    await writeFile(f.projectFile, "{}\n");
    await rm(f.userFile);
    await symlink(path.join(f.root, "missing-auth.json"), f.userFile);
    await expect(createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project })).rejects.toThrow("non-symlink");
  });

  test("rollback restores exact bytes, flips the marker, and is idempotent", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    expect(await rollbackRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "rolled-back" });
    expect(await rollbackRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "already-rolled-back" });
    expect(await readFile(f.projectFile, "utf8")).toBe(f.projectBytes);
    expect(await readFile(f.userFile, "utf8")).toBe(f.userBytes);
    expect(readActiveRoutingV2Layers(f.cwd, f.configDir)).toBeUndefined();
  });

  test("rollback refuses to overwrite a post-activation concurrent edit", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    const current = JSON.parse(await readFile(f.userFile, "utf8"));
    const concurrentBytes = `${JSON.stringify({ ...current, refreshedCredential: true }, null, 2)}\n`;
    await writeFile(f.userFile, concurrentBytes, { mode: 0o600 });
    const marker = routingV2ActivationPath(f.cwd, f.configDir);
    const [projectBefore, markerBefore] = await Promise.all([readFile(f.projectFile, "utf8"), readFile(marker, "utf8")]);
    expect(readActiveRoutingV2Layers(f.cwd, f.configDir)).toEqual({ project: f.project, user: f.user });
    await expect(rollbackRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).rejects.toThrow("changed after activation");
    expect(await readFile(f.userFile, "utf8")).toBe(concurrentBytes);
    expect(await readFile(f.projectFile, "utf8")).toBe(projectBefore);
    expect(await readFile(marker, "utf8")).toBe(markerBefore);
    expect(readActiveRoutingV2Layers(f.cwd, f.configDir)).toEqual({ project: f.project, user: f.user });
  });

  test("rollback resumes after a crash between restores", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    const active = readActiveRoutingV2Layers(f.cwd, f.configDir);
    const failAt = (point: RoutingV2RollbackFaultPoint) => {
      if (point === "after-project-restore") throw new Error("simulated rollback crash");
    };
    await expect(rollbackRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir, fault: failAt })).rejects.toThrow("simulated rollback crash");
    expect(readActiveRoutingV2Layers(f.cwd, f.configDir)).toEqual(active);
    expect(await rollbackRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "rolled-back" });
    expect(await readFile(f.projectFile, "utf8")).toBe(f.projectBytes);
    expect(await readFile(f.userFile, "utf8")).toBe(f.userBytes);
  });

  test("a fresh reviewed plan may replace an explicit rolled-back marker", async () => {
    const f = await fixture();
    const first = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(first, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    await rollbackRoutingV2Migration(first, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    const second = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    expect(await applyRoutingV2Migration(second, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "applied" });
  });

  test("deactivation changes only the marker and preserves edited configs", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    const project = `${(await readFile(f.projectFile, "utf8")).trim()} `;
    const userRoot = JSON.parse(await readFile(f.userFile, "utf8"));
    const user = `${JSON.stringify({ ...userRoot, refreshedCredential: true }, null, 2)}\n`;
    await writeFile(f.projectFile, project);
    await writeFile(f.userFile, user, { mode: 0o600 });

    expect(await deactivateRoutingV2({ confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "deactivated" });
    expect(await deactivateRoutingV2({ confirmed: true, cwd: f.cwd, configDir: f.configDir })).toMatchObject({ status: "already-deactivated" });
    expect(await readFile(f.projectFile, "utf8")).toBe(project);
    expect(await readFile(f.userFile, "utf8")).toBe(user);
    expect(readActiveRoutingV2Layers(f.cwd, f.configDir)).toBeUndefined();
  });

  test("active layer edits use expected revisions and preserve unrelated auth state", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    const before = readActiveRoutingV2Settings(f.cwd, f.configDir);
    expect(before).toBeDefined();
    if (before === undefined) throw new Error("expected active settings");
    const next = { schemaVersion: 2 as const, categories: { coding: { mode: "baseline" as const } } };
    const updated = await updateActiveRoutingV2Layer({
      cwd: f.cwd,
      configDir: f.configDir,
      layer: "project",
      expectedRevision: before.revision,
      next,
    });
    expect(updated.status).toBe("updated");
    expect(updated.revision).not.toBe(before.revision);
    expect(readActiveRoutingV2Settings(f.cwd, f.configDir)).toEqual({
      layers: { project: next, user: f.user },
      revision: updated.revision,
    });
    expect(JSON.parse(await readFile(f.userFile, "utf8"))).toMatchObject({ apiKeys: { anthropic: "secret-value" } });
    const restored = await updateActiveRoutingV2Layer({
      cwd: f.cwd,
      configDir: f.configDir,
      layer: "project",
      expectedRevision: updated.revision,
      next: f.project,
    });
    expect(restored.revision).not.toBe(before.revision);
    await expect(rollbackRoutingV2Migration(plan, {
      confirmed: true,
      cwd: f.cwd,
      configDir: f.configDir,
    })).rejects.toThrow("edited after migration");
    const files = [f.projectFile, f.userFile, routingV2ActivationPath(f.cwd, f.configDir)];
    const bytesBefore = await Promise.all(files.map((file) => readFile(file, "utf8")));
    await expect(updateActiveRoutingV2Layer({
      cwd: f.cwd,
      configDir: f.configDir,
      layer: "project",
      expectedRevision: before.revision,
      next,
    })).rejects.toThrow("revision conflict");
    expect(await Promise.all(files.map((file) => readFile(file, "utf8")))).toEqual(bytesBefore);
    expect(readActiveRoutingV2Settings(f.cwd, f.configDir)?.revision).toBe(restored.revision);
  });

  test("active user edits merge against refreshed credentials", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    const active = readActiveRoutingV2Settings(f.cwd, f.configDir);
    if (active === undefined) throw new Error("expected active settings");
    const current = JSON.parse(await readFile(f.userFile, "utf8"));
    await writeFile(f.userFile, `${JSON.stringify({ ...current, apiKeys: { anthropic: "rotated-secret" } }, null, 2)}\n`, { mode: 0o600 });
    const next = { schemaVersion: 2 as const, categories: { quick: { mode: "class" as const, modelClass: "light" as const } } };
    const result = await updateActiveRoutingV2Layer({
      cwd: f.cwd,
      configDir: f.configDir,
      layer: "user",
      expectedRevision: active.revision,
      next,
    });
    expect(result.status).toBe("updated");
    expect(JSON.parse(await readFile(f.userFile, "utf8"))).toMatchObject({
      apiKeys: { anthropic: "rotated-secret" },
      routingV2: next,
    });
  });

  test("an interrupted active edit is recovered and a retry is idempotent", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    const active = readActiveRoutingV2Settings(f.cwd, f.configDir);
    if (active === undefined) throw new Error("expected active settings");
    const next = { schemaVersion: 2 as const, categories: { coding: { mode: "baseline" as const } } };
    const request = { cwd: f.cwd, configDir: f.configDir, layer: "project" as const, expectedRevision: active.revision, next };
    await expect(updateActiveRoutingV2Layer({
      ...request,
      fault: (point) => {
        if (point === "after-config-write") throw new Error("simulated edit crash");
      },
    })).rejects.toThrow("simulated edit crash");
    expect(readActiveRoutingV2Settings(f.cwd, f.configDir)).toEqual(active);
    const recovered = await updateActiveRoutingV2Layer(request);
    expect(recovered.status).toBe("already-applied");
    expect(await Bun.file(`${routingV2ActivationPath(f.cwd, f.configDir)}.edit.json`).exists()).toBe(false);
    expect(readActiveRoutingV2Settings(f.cwd, f.configDir)?.layers.project).toEqual(next);
  });
});

describe("legacy category proposal", () => {
  test("preserves pins, makes baseline explicit, and surfaces ambiguous defaults and env overrides", () => {
    const legacy: RoutingTable = {
      coding: { kind: "model", providerId: "anthropic", modelId: "claude-sonnet" },
      quick: { kind: "session-default" },
      review: { kind: "provider-default", providerId: "openai" },
    };
    const proposed = proposeRoutingV2Categories(legacy, { subagentModelOverride: "openai/gpt-5" });
    expect(proposed.categories.coding).toEqual({ mode: "model", target: { providerId: "anthropic", modelId: "claude-sonnet" } });
    expect(proposed.categories.quick).toEqual({ mode: "baseline" });
    expect(proposed.categories.docs).toEqual({ mode: "baseline" });
    expect(proposed.unresolved.map((item) => item.code)).toEqual(["provider-default", "subagent-model-override"]);
  });
});
