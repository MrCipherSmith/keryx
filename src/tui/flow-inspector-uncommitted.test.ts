// The TUI's `/flows` detail tab carries the same uncommitted-closing-state note
// as `keryx flow status`: same condition (done, tracked directory, changes), same
// words (`uncommittedFlowStateNote`), informational only.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService, uncommittedFlowStateNote } from "../flow/service";
import { formatFlowDetailLines } from "./flow-inspector";
import { loadInspectorFlows } from "./inspector-sources";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function doneFlow(status: "done" | "in-progress", commit: boolean): Promise<{ id: string; dir: string }> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-flows-uncommitted-"));
  await git("init", "-q");
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const service = createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-29T10:00:00Z"),
  });
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Closed" });
  const dir = path.basename(created);
  const file = path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  raw["status"] = status;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  if (commit) {
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed");
  }
  await writeFile(path.join(ROOT, ".metaproject", "flows", dir, "journal.md"), "closing entry\n");
  return { id: flow.id, dir };
}

test("a done flow with a tracked, dirty directory shows the same note in the detail tab", async () => {
  const { id, dir } = await doneFlow("done", true);
  const [item] = await loadInspectorFlows(ROOT);
  if (item === undefined) throw new Error("no flow loaded");
  const expected = await uncommittedFlowStateNote(ROOT, id, dir);
  expect(expected).not.toBeNull();
  expect(item.uncommitted).toBe(expected ?? undefined);
  expect(formatFlowDetailLines(item).join("\n")).toContain("nothing gates on this");
});

test("no note for a flow that is not done, or whose directory is untracked", async () => {
  await doneFlow("in-progress", true);
  const [open] = await loadInspectorFlows(ROOT);
  expect(open?.uncommitted).toBeUndefined();
  expect(formatFlowDetailLines(open ?? ({ tasks: [] } as never)).join("\n")).not.toContain("uncommitted changes");
  await rm(ROOT, { recursive: true, force: true });

  await doneFlow("done", false);
  const [local] = await loadInspectorFlows(ROOT);
  expect(local?.uncommitted).toBeUndefined();
});
