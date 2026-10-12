import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { acquireCwd, releaseCwd } from "../lib/test-cwd";
import { validateWorkspace } from "../standard/validate";
import { initCommand } from "./init";
import { updateCommand } from "./update";

const SAC_INIT = [
  "--yes",
  "--sac",
  "--no-gdgraph",
  "--no-gdctx",
  "--no-gdwiki",
  "--no-gdskills",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
  "--no-security",
];

let root: string;
let originalLog: typeof console.log;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-sac-dirs-"));
  originalLog = console.log;
  console.log = () => {};
  await acquireCwd(root);
});

afterEach(async () => {
  console.log = originalLog;
  releaseCwd();
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

async function missingModulePathIssues(): Promise<string[]> {
  const result = await validateWorkspace(root);
  return [...result.errors, ...result.warnings]
    .filter((issue) => issue.code === "missing-module-path")
    .map((issue) => issue.message);
}

test("init --sac creates the core and data dirs modules.sac declares", async () => {
  await initCommand(SAC_INIT);

  expect(existsSync(path.join(root, ".metaproject", "core", "sac"))).toBe(true);
  expect(existsSync(path.join(root, ".metaproject", "data", "sac"))).toBe(true);
  expect(await readFile(path.join(root, ".metaproject", "core", "sac", "README.md"), "utf8")).toContain("# SAC Core");
  expect(await missingModulePathIssues()).toEqual([]);
  expect((await validateWorkspace(root)).ok).toBe(true);
});

test("update backfills the sac core and data dirs on a project initialised without them", async () => {
  await initCommand(SAC_INIT);
  await rm(path.join(root, ".metaproject", "core", "sac"), { recursive: true, force: true });
  await rm(path.join(root, ".metaproject", "data", "sac"), { recursive: true, force: true });
  expect((await missingModulePathIssues()).length).toBeGreaterThan(0);

  await updateCommand(["--skip-runtime", "--no-tasks"]);

  expect(existsSync(path.join(root, ".metaproject", "core", "sac", "README.md"))).toBe(true);
  expect(existsSync(path.join(root, ".metaproject", "data", "sac"))).toBe(true);
  expect(await missingModulePathIssues()).toEqual([]);
  expect((await validateWorkspace(root)).ok).toBe(true);
});
