// `keryx flow complete` prints the uncommitted-changes note only after a PASSED
// completion, and the note never changes the exit code.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { completionStateNote } from "./flow";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
let root = "";

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function keryx(args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${out}${err}` };
}

async function trackedDirtyFlow(status: "done" | "in-progress"): Promise<{ id: string; dir: string }> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  const service = createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-29T10:00:00Z"),
  });
  const { flow, dir: created } = await service.init({ cwd: root, title: "Complete note" });
  const dir = path.join(root, ".metaproject", "flows", path.basename(created));
  const raw = JSON.parse(await readFile(path.join(dir, "flow.json"), "utf8")) as Record<string, unknown>;
  raw["status"] = status;
  await writeFile(path.join(dir, "flow.json"), JSON.stringify(raw, null, 2));
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed");
  await writeFile(path.join(dir, "journal.md"), "closing entry\n");
  return { id: flow.id, dir };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-complete-uncommitted-"));
  await git("init", "-q");
});

afterEach(async () => {
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

test("a passed completion gets the note; the exit code is left exactly as it was", async () => {
  const { id } = await trackedDirtyFlow("done");
  process.exitCode = 0;
  const text = await completionStateNote(root, { passed: true, flow: { id, status: "done" } });
  expect(text).toContain(`flow ${id} has uncommitted changes`);
  expect(text).toContain("nothing gates on this");
  expect(process.exitCode ?? 0).toBe(0);

  process.exitCode = 7;
  await completionStateNote(root, { passed: true, flow: { id, status: "done" } });
  expect(process.exitCode).toBe(7);
});

test("a refused completion gets no note", async () => {
  const { id } = await trackedDirtyFlow("in-progress");
  expect(await completionStateNote(root, { passed: false, flow: { id, status: "in-progress" } })).toBeNull();
});

test("the real command prints no note when the completion is refused, and still exits non-zero", async () => {
  const { id } = await trackedDirtyFlow("in-progress");
  const done = await keryx(["flow", "complete", id, "--merged", "deadbeef"]);
  expect(done.code).not.toBe(0);
  expect(done.output).not.toContain("uncommitted changes");
}, 60_000);
