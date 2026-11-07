import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { flowCommand } from "./flow";

const originalCwd = process.cwd();
const originalLog = console.log;
let root = "";
const service = createFlowService({
  tracker: null,
  healthGate: async () => ({ status: "pass", reasons: [] }),
  now: () => new Date("2026-10-20T10:00:00Z"),
});

afterEach(async () => {
  console.log = originalLog;
  process.chdir(originalCwd);
  process.exitCode = 0;
  if (root) await rm(root, { recursive: true, force: true });
});

test("base set updates the recorded base through the CLI and journals the reason", async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-base-cli-"));
  await mkdir(path.join(root, ".metaproject"));
  const { flow } = await service.init({ cwd: root, title: "Retargeted", baseBranch: "fix/round2" });
  process.chdir(root);
  const output: string[] = [];
  console.log = (...parts: unknown[]) => void output.push(parts.join(" "));
  await flowCommand(["base", "set", flow.id, "--base", "main", "--reason", "PR retargeted after release"]);
  expect(process.exitCode ?? 0).toBe(0);
  expect((await service.get({ cwd: root, id: flow.id })).baseBranch).toBe("main");
  expect(output.join("\n")).toContain("main");
});

test("base set refuses a missing reason without changing the base", async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-base-cli-refuse-"));
  await mkdir(path.join(root, ".metaproject"));
  const { flow } = await service.init({ cwd: root, title: "Retargeted", baseBranch: "fix/round2" });
  process.chdir(root);
  console.log = () => {};
  await flowCommand(["base", "set", flow.id, "--base", "main"]);
  expect(process.exitCode).toBe(1);
  expect((await service.get({ cwd: root, id: flow.id })).baseBranch).toBe("fix/round2");
});

test("help documents base set and explicit fix round lineage", async () => {
  const output: string[] = [];
  console.log = (...parts: unknown[]) => void output.push(parts.join(" "));
  await flowCommand(["--help"]);
  expect(output.join("\n")).toContain("--fix-of");
});
