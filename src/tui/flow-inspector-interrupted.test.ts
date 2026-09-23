// Flow 299, AC6: the TUI's `/flows` view shows an interrupted completion the
// way `keryx flow status` does. Same condition: `completing` with no live lock
// holder. Same words: `interruptedCompletionLine`.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withFileLock } from "../lib/fs";
import { createFlowService } from "../flow/service";
import { flowLockPathFor, interruptedCompletionLine } from "../flow/store";
import { formatFlowDetailLines, formatFlowListLines, formatFlowListText } from "./flow-inspector";
import { formatSessionFlowLines, loadInspectorFlows } from "./inspector-sources";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

/** A flow whose flow.json says `completing`: what a process that died mid-`complete` leaves behind. */
async function stuckFlow(): Promise<{ id: string; dir: string }> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-flows-interrupted-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const service = createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-23T10:00:00Z"),
  });
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Stuck" });
  const dir = path.basename(created);
  const file = path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  raw["status"] = "completing";
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { id: flow.id, dir };
}

test("/flows marks a lock-free `completing` flow interrupted in the list, the detail tab and the session lines", async () => {
  const { id } = await stuckFlow();
  const [item] = await loadInspectorFlows(ROOT);
  if (item === undefined) throw new Error("no flow loaded");
  expect(item.interrupted).toBe(interruptedCompletionLine(id));

  expect(formatFlowListLines([item], 0)[0]).toContain("completing (interrupted)");
  expect(formatFlowListText([item])).toContain("completing (interrupted)");
  expect(formatSessionFlowLines([item]).join("\n")).toContain("completing (interrupted)");
  const detail = formatFlowDetailLines(item).join("\n");
  expect(detail).toContain(`keryx flow recover ${id}`);
});

test("/flows does not call a completion interrupted while a process holds the flow lock", async () => {
  const { dir } = await stuckFlow();
  await withFileLock(flowLockPathFor(ROOT, dir), async () => {
    const [item] = await loadInspectorFlows(ROOT);
    expect(item?.interrupted).toBeUndefined();
    expect(formatFlowListLines(item ? [item] : [], 0)[0]).not.toContain("interrupted");
  });
});
