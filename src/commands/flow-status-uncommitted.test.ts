// `keryx flow status` appends the uncommitted-closing-state note for a DONE flow
// whose tracked directory is dirty, and prints nothing extra otherwise.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closedFlowStateNote, flowCommand } from "./flow";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
let root = "";
let logs: string[] = [];

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function seedFlow(status: "done" | "in-progress", opts: { commit: boolean; dirty: boolean }): Promise<string> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  const { createFlowService } = await import("../flow/service");
  const service = createFlowService({
    tracker: {
      id: "fake",
      detect: async () => true,
      parseRef: () => null,
      fetchIssue: async () => ({ title: "t", body: "b" }),
      prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
      comment: async () => true,
    },
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-29T10:00:00Z"),
  });
  const { flow, dir: created } = await service.init({ cwd: root, title: "Closed flow" });
  const dir = path.join(root, ".metaproject", "flows", path.basename(created));
  const flowJson = path.join(dir, "flow.json");
  const raw = JSON.parse(await readFile(flowJson, "utf8")) as Record<string, unknown>;
  raw["status"] = status;
  await writeFile(flowJson, JSON.stringify(raw, null, 2));
  if (opts.commit) {
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed");
  }
  if (opts.dirty) await writeFile(path.join(dir, "journal.md"), "closing entry\n");
  return flow.id;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-status-uncommitted-"));
  await git("init", "-q");
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

test("closedFlowStateNote: nothing for a flow that is not done, even when its directory is dirty", async () => {
  const id = await seedFlow("in-progress", { commit: true, dirty: true });
  expect(await closedFlowStateNote(root, { id, status: "in-progress" })).toBeNull();
});

test("closedFlowStateNote: a done flow with a tracked, dirty directory gets the note", async () => {
  const id = await seedFlow("done", { commit: true, dirty: true });
  const text = await closedFlowStateNote(root, { id, status: "done" });
  expect(text).toContain(`flow ${id} has uncommitted state`);
  expect(text).toContain("journal.md");
});

test("closedFlowStateNote: a done flow that is untracked or clean gets nothing", async () => {
  const id = await seedFlow("done", { commit: false, dirty: false });
  expect(await closedFlowStateNote(root, { id, status: "done" })).toBeNull();
});

test("flow status on a done flow with a dirty tracked directory prints the note, exit code untouched", async () => {
  const id = await seedFlow("done", { commit: true, dirty: true });
  process.chdir(root);
  await flowCommand(["status", id]);
  const printed = logs.join("\n");
  expect(printed).toContain("uncommitted state in .metaproject/flows/");
  expect(printed).toContain("nothing gates on this");
  expect(process.exitCode ?? 0).toBe(0);
});

test("flow status on a done flow whose directory is clean prints no note", async () => {
  const id = await seedFlow("done", { commit: true, dirty: false });
  process.chdir(root);
  await flowCommand(["status", id]);
  expect(logs.join("\n")).not.toContain("uncommitted state");
});
