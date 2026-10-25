import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadLearningConfig } from "./config";

const roots: string[] = [];
const defaults = { defaultTaskSet: ".metaproject/data/learning/probes/tasks.json", retainRunsPerPattern: 20 };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function load(value?: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "probe-config-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject"));
  if (value !== undefined) await writeFile(path.join(root, ".metaproject/learning.config.json"), JSON.stringify(value));
  return loadLearningConfig(root);
}
test("absent config has defaults and no implicit budget", async () => {
  expect(await load()).toEqual({ schemaVersion: 1, capabilities: { modelExtractor: false }, probe: defaults });
});
for (const probe of [undefined, null, [], 1, "bad", false]) {
  test(`absent/malformed probe block ${JSON.stringify(probe)}`, async () => {
    const config = await load({ capabilities: { modelExtractor: true }, probe });
    expect(config.capabilities.modelExtractor).toBe(true);
    expect(config.probe).toEqual(defaults);
  });
}
for (const patch of [
  { defaultTaskSet: "" }, { defaultTaskSet: 1 }, { maxUsdPerProbe: 0 }, { maxUsdPerProbe: -1 },
  { maxUsdPerProbe: null }, { maxUsdPerProbe: "5" }, { retainRunsPerPattern: -1 }, { retainRunsPerPattern: 1.5 },
]) {
  test(`invalid sibling ignores WHOLE block ${JSON.stringify(patch)}`, async () => {
    const config = await load({ capabilities: { modelExtractor: true }, probe: {
      defaultTaskSet: "custom/tasks.json", maxUsdPerProbe: 5, retainRunsPerPattern: 2, ...patch,
    } });
    expect(config.probe).toEqual(defaults);
    expect(config.capabilities.modelExtractor).toBe(true);
  });
}
for (const probe of [{}, { maxUsdPerProbe: 0.01 }, { retainRunsPerPattern: 0 }, { defaultTaskSet: "custom/tasks.json" }]) {
  test(`partial valid block ${JSON.stringify(probe)}`, async () => {
    expect((await load({ probe })).probe).toEqual({ ...defaults, ...probe });
  });
}
test("config defaults are not shared mutable state", async () => {
  const config = await load();
  config.probe.retainRunsPerPattern = 0;
  expect((await load()).probe).toEqual(defaults);
});
test("unknown probe keys ignored like capability keys", async () => {
  expect((await load({ probe: { extra: true, retainRunsPerPattern: 0 } })).probe).toEqual({ ...defaults, retainRunsPerPattern: 0 });
});
for (const value of [null, [], 1, "bad"]) {
  test(`nonobject root ${JSON.stringify(value)} safely defaults`, async () => {
    expect((await load(value)).probe).toEqual(defaults);
  });
}
