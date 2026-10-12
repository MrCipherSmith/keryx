// Flow 384: `keryx flow check` prints a warning line for a flow folder that is
// not committed, after its normal output, and the exit code stays 0; `keryx flow
// list` tags the same row. A clash with a remote branch fails the check.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { addRemoteRef, commitAll, gitRepo } from "../flow/remote-fixtures";
import { createFlowService } from "../flow/service";
import { flowCommand } from "./flow";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
let root = "";
let logs: string[] = [];

async function seedFlow(): Promise<string> {
  const service = createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-10-01T10:00:00Z"),
  });
  const { dir } = await service.init({ cwd: root, title: "Hygiene" });
  return path.basename(dir);
}

beforeEach(async () => {
  root = await gitRepo("keryx-check-hygiene-");
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

test("flow check prints the not-committed warning after 'All flows are consistent', exit code untouched", async () => {
  const dir = await seedFlow();
  process.chdir(root);

  await flowCommand(["check"]);

  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const lines = logs.map((line) => line.replace(ansi, ""));
  const consistent = lines.findIndex((line) => line.includes("All flows are consistent"));
  const warning = lines.findIndex((line) => line.includes(`flow folder ${dir} is not committed: commit it in the same PR as the code`));
  expect(consistent).toBeGreaterThanOrEqual(0);
  expect(warning).toBeGreaterThan(consistent);
  expect(lines[warning]?.trim().startsWith("!")).toBe(true);
  expect(process.exitCode ?? 0).toBe(0);
});

test("flow check prints no warning once the folder is committed", async () => {
  await seedFlow();
  await commitAll(root);
  process.chdir(root);

  await flowCommand(["check"]);

  expect(logs.join("\n")).toContain("All flows are consistent");
  expect(logs.join("\n")).not.toContain("is not committed");
});

test("flow check fails on a number a remote branch holds under another folder, and names the repair", async () => {
  const dir = await seedFlow();
  await commitAll(root);
  await addRemoteRef(root, "origin/main", [`${dir.slice(0, 3)}-2026-09-30-remote-side`]);
  process.chdir(root);

  await flowCommand(["check"]);

  const printed = logs.join("\n");
  expect(printed).toContain("origin/main");
  expect(printed).toContain(`keryx flow renumber ${dir} --to <free id> --reason "<why>"`);
  expect(process.exitCode).toBe(1);
});

test("flow list tags the row of a folder that is not committed", async () => {
  await seedFlow();
  process.chdir(root);

  await flowCommand(["list"]);

  expect(logs.join("\n")).toContain("[not committed]");
});
