import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { initCommand } from "../commands/init";
import { runCapabilities, runValidate } from "./service";
import { computeProfiles, evaluateProfiles } from "./profiles";
import type { MetaprojectManifest } from "./types";

// A fast "full-ish" workspace: agent modules (gdgraph) + CI module (health),
// everything else disabled to avoid the testing analyzer and skill install.
const FULL_WORKSPACE_FLAGS = [
  "--yes",
  "--no-gdctx",
  "--no-gdwiki",
  "--no-gdskills",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
];

let previousCwd: string;
let root: string;

beforeEach(async () => {
  previousCwd = process.cwd();
  root = await mkdtemp(path.join(tmpdir(), "gd-metapro-standard-"));
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(root, { recursive: true, force: true });
});

async function initWorkspace(flags: string[] = FULL_WORKSPACE_FLAGS): Promise<void> {
  process.chdir(root);
  await initCommand(flags);
  process.chdir(previousCwd);
}

async function readManifest(): Promise<MetaprojectManifest> {
  const raw = await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8");
  return JSON.parse(raw) as MetaprojectManifest;
}

async function writeManifest(manifest: MetaprojectManifest): Promise<void> {
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

test("validate passes on a well-formed generated workspace", async () => {
  await initWorkspace();

  const result = await runValidate(root);

  expect(result.ok).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("validate fails when standardVersion is missing from the manifest", async () => {
  await initWorkspace();
  const manifest = await readManifest();
  delete manifest.standardVersion;
  await writeManifest(manifest);

  const result = await runValidate(root);

  expect(result.ok).toBe(false);
  expect(result.errors.some((issue) => issue.message.includes("standardVersion"))).toBe(true);
});

test("validate fails when an enabled module's manifest markdown is missing", async () => {
  await initWorkspace();
  await rm(path.join(root, ".metaproject", "modules", "gdgraph.md"), { force: true });

  const result = await runValidate(root);

  expect(result.ok).toBe(false);
  expect(result.errors.some((issue) => issue.code === "missing-module-manifest")).toBe(true);
});

test("validate fails when a declared top-level path does not exist", async () => {
  await initWorkspace();
  const manifest = await readManifest();
  manifest.paths = { ...(manifest.paths ?? {}), data: ".metaproject/does-not-exist" };
  await writeManifest(manifest);

  const result = await runValidate(root);

  expect(result.ok).toBe(false);
  expect(result.errors.some((issue) => issue.code === "missing-declared-path")).toBe(true);
});

test("capabilities returns standardVersion, profiles, and modules with commands", async () => {
  await initWorkspace();

  const { report } = await runCapabilities(root);

  expect(report.standardVersion).toBe("0.1.0");
  expect(report.profiles).toContain("minimal");
  const gdgraph = report.modules.find((module) => module.key === "gdgraph");
  expect(gdgraph?.enabled).toBe(true);
  expect(gdgraph?.commands).toContain("build");
});

test("profile evaluation reports the full profile set for a full workspace", async () => {
  await initWorkspace();
  const manifest = await readManifest();

  const evaluation = await evaluateProfiles(root, manifest);

  expect(evaluation.satisfied).toEqual(["minimal", "agent", "ci", "full"]);
  expect(evaluation.unsatisfiedDeclared).toHaveLength(0);
});

test("profile evaluation does not falsely satisfy 'agent' on a minimal-only workspace", async () => {
  // Regression: the always-created skills/project-rules folder must not make the
  // agent profile look satisfied when no agent-capability module is enabled.
  await initWorkspace([
    "--yes",
    "--no-gdgraph",
    "--no-gdctx",
    "--no-gdwiki",
    "--no-gdskills",
    "--no-memory",
    "--no-health",
    "--no-testing",
    "--no-tasks",
  ]);
  const manifest = await readManifest();

  const evaluation = await evaluateProfiles(root, manifest);

  expect(evaluation.satisfied).toEqual(["minimal"]);
  expect(evaluation.satisfied).not.toContain("agent");
  expect(evaluation.undeclaredSatisfied).toHaveLength(0);
});

test("computeProfiles derives profiles from enabled module keys", () => {
  expect(computeProfiles([])).toEqual(["minimal"]);
  expect(computeProfiles(["gdgraph"])).toEqual(["minimal", "agent"]);
  expect(computeProfiles(["health"])).toEqual(["minimal", "ci"]);
  expect(computeProfiles(["gdgraph", "health"])).toEqual(["minimal", "agent", "ci", "full"]);
});
