import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoutingTable } from "./table";
import {
  applyRoutingV2Migration,
  createRoutingV2MigrationPlan,
  deactivateRoutingV2,
  proposeRoutingV2Categories,
  readActiveRoutingV2Layers,
  rollbackRoutingV2Migration,
  routingV2ActivationPath,
  type RoutingV2MigrationFaultPoint,
  type RoutingV2RollbackFaultPoint,
} from "./migration-v2";

const roots: string[] = [];

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
    await writeFile(f.userFile, `${JSON.stringify({ ...current, refreshedCredential: true }, null, 2)}\n`, { mode: 0o600 });
    expect(readActiveRoutingV2Layers(f.cwd, f.configDir)).toEqual({ project: f.project, user: f.user });
    await expect(rollbackRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir })).rejects.toThrow("changed after activation");
  });

  test("rollback resumes after a crash between restores", async () => {
    const f = await fixture();
    const plan = await createRoutingV2MigrationPlan({ cwd: f.cwd, configDir: f.configDir, project: f.project, user: f.user });
    await applyRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir });
    const failAt = (point: RoutingV2RollbackFaultPoint) => {
      if (point === "after-project-restore") throw new Error("simulated rollback crash");
    };
    await expect(rollbackRoutingV2Migration(plan, { confirmed: true, cwd: f.cwd, configDir: f.configDir, fault: failAt })).rejects.toThrow("simulated rollback crash");
    expect(() => readActiveRoutingV2Layers(f.cwd, f.configDir)).toThrow("digest mismatch");
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
