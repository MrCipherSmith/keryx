// Flow 365, AC5: the TUI flow inspector shows the same author `keryx flow status` prints, read
// through the same facade helper, and `unknown` for a flow that never recorded one.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { formatFlowDetailLines } from "./flow-inspector";
import { loadInspectorFlows } from "./inspector-sources";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function seed(): Promise<void> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-flows-author-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const service = createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-29T10:00:00Z"),
  });
  await service.init({ cwd: ROOT, title: "By an agent", slug: "by-agent" });
  await service.init({ cwd: ROOT, title: "By a person", slug: "by-person", outcomeAuthor: "human" });
  const legacy = await service.init({ cwd: ROOT, title: "Before the field", slug: "legacy" });
  const file = path.join(ROOT, legacy.dir, "flow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete raw["outcomeAuthor"];
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

test("the detail lines carry the recorded author, and unknown for a flow without one", async () => {
  await seed();
  const items = await loadInspectorFlows(ROOT);
  const byTitle = new Map(items.map((item) => [item.title, item]));

  const agent = byTitle.get("By an agent");
  const human = byTitle.get("By a person");
  const legacy = byTitle.get("Before the field");
  if (agent === undefined || human === undefined || legacy === undefined) throw new Error("a seeded flow did not load");

  expect(agent.outcomeAuthor).toBe("agent");
  expect(human.outcomeAuthor).toBe("human");
  expect(legacy.outcomeAuthor).toBe("unknown");
  expect(formatFlowDetailLines(agent).join("\n")).toContain("Outcome author  agent");
  expect(formatFlowDetailLines(human).join("\n")).toContain("Outcome author  human");
  expect(formatFlowDetailLines(legacy).join("\n")).toContain("Outcome author  unknown");
});

test("loading the inspector rewrites no flow.json, so a flow without the field stays without it", async () => {
  await seed();
  const files = (await readdir(path.join(ROOT, ".metaproject", "flows"))).map((dir) => path.join(ROOT, ".metaproject", "flows", dir, "flow.json"));
  const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
  await loadInspectorFlows(ROOT);
  const after = await Promise.all(files.map((file) => readFile(file, "utf8")));
  expect(after).toEqual(before);
  expect(before.filter((text) => !text.includes("outcomeAuthor"))).toHaveLength(1);
});
