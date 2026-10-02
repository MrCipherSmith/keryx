// Flow 384 (AC7): the `/flows` list and detail carry the two folder-hygiene
// problems `flow check` reports — a short tag beside the row and the check's own
// line in the detail — computed once per list load from `service.check`.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { formatFlowDetailLines, formatFlowListLines, formatFlowListText } from "./flow-inspector";
import { formatHygieneTags, hygieneFromCheck, loadFlowHygiene } from "./flow-hygiene";
import { formatSessionFlowLines, loadInspectorFlows } from "./inspector-sources";
import { formatFlowEntryLines } from "./governance-flows";
import type { FlowGovernance } from "../governance/service";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.trim();
}

const service = createFlowService({
  tracker: null,
  healthGate: async () => ({ status: "pass", reasons: [] }),
  now: () => new Date("2026-10-01T10:00:00Z"),
});

async function repoWithFlow(): Promise<string> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-flow-hygiene-"));
  await git("init", "-q");
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const { dir } = await service.init({ cwd: ROOT, title: "Hygiene" });
  return path.basename(dir);
}

test("hygieneFromCheck keys the check's issues and warnings by folder; tags read as [..] beside the row", () => {
  const map = hygieneFromCheck({
    issues: [
      { flow: "001-a", kind: "duplicate-id", message: "clash" },
      { flow: "002-b", kind: "structure", message: "not hygiene" },
    ],
    warnings: [{ flow: "001-a", kind: "untracked", message: "not committed" }],
  });
  expect([...map.keys()]).toEqual(["001-a"]);
  expect(map.get("001-a")?.tags).toEqual(["dup id", "not committed"]);
  expect(map.get("001-a")?.notes).toEqual(["clash", "not committed"]);
  expect(formatHygieneTags(map.get("001-a"))).toBe("  [dup id] [not committed]");
  expect(formatHygieneTags(undefined)).toBe("");
});

test("a failing check leaves the list untagged instead of failing it", async () => {
  const map = await loadFlowHygiene("/nowhere", async () => {
    throw new Error("boom");
  });
  expect(map.size).toBe(0);
});

test("an uncommitted flow folder shows [not committed] in the list and the check's line in the detail; committing clears it", async () => {
  const dir = await repoWithFlow();
  const [item] = await loadInspectorFlows(ROOT);
  if (item === undefined) throw new Error("no flow loaded");
  expect(item.hygiene?.tags).toEqual(["not committed"]);
  expect(formatFlowListLines([item], 0)[0]).toEndWith("[not committed]");
  expect(formatFlowListText([item])).toContain("[not committed]");
  expect(formatSessionFlowLines([item])[0]).toEndWith("[not committed]");
  expect(formatFlowDetailLines(item).join("\n")).toContain(`flow folder ${dir} is not committed: commit it in the same PR as the code`);

  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  const [committed] = await loadInspectorFlows(ROOT);
  expect(committed?.hygiene).toBeUndefined();
  expect(formatFlowListLines(committed ? [committed] : [], 0)[0]).not.toContain("[");
});

test("a number a remote branch holds under another folder name shows [dup id]; the same folder name does not", async () => {
  const dir = await repoWithFlow();
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  const home = await git("rev-parse", "--abbrev-ref", "HEAD");
  const id = dir.slice(0, 3);
  // A remote branch carrying a DIFFERENT flow under the same number.
  await git("checkout", "-q", "-b", "other");
  await git("rm", "-rq", `.metaproject/flows/${dir}`);
  await mkdir(path.join(ROOT, ".metaproject", "flows", `${id}-2026-09-30-other`), { recursive: true });
  await writeFile(path.join(ROOT, ".metaproject", "flows", `${id}-2026-09-30-other`, "flow.json"), "{}\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "other");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("checkout", "-q", home);
  await git("branch", "-D", "other");

  const [item] = await loadInspectorFlows(ROOT);
  if (item === undefined) throw new Error("no flow loaded");
  expect(item.hygiene?.tags).toEqual(["dup id"]);
  expect(formatFlowListLines([item], 0)[0]).toEndWith("[dup id]");
  expect(formatFlowDetailLines(item).join("\n")).toContain("is also used on origin/main by a different flow");

  // The branch that holds this very folder is the same flow, not a clash.
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  const [same] = await loadInspectorFlows(ROOT);
  expect(same?.hygiene).toBeUndefined();
});

test("the governance entry shows the tag on the row and the line on the selected entry only", () => {
  const flow = {
    id: "007",
    dir: "007-x",
    title: "Seven",
    status: "in-progress",
    summary: { statement: "s", tasksDone: 0, tasksTotal: 1, openTasks: [] },
    effect: { stated: false },
  } as unknown as FlowGovernance;
  const hygiene = { tags: ["not committed" as const], notes: ["flow folder 007-x is not committed: commit it in the same PR as the code"] };
  const base = { check: undefined, checking: false, closing: false, closeResult: undefined, error: undefined, hygiene };
  const selected = formatFlowEntryLines(flow, { ...base, selected: true });
  expect(selected[0]).toBe("▸ 007 in-progress  Seven  [not committed]");
  expect(selected.join("\n")).toContain("flow folder 007-x is not committed");
  const other = formatFlowEntryLines(flow, { ...base, selected: false });
  expect(other[0]).toBe("  007 in-progress  Seven  [not committed]");
  expect(other.join("\n")).not.toContain("flow folder 007-x");
});
