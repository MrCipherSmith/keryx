import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importProjectRules } from "./import-rules";
import { INDEX_THRESHOLD_BYTES, type ProjectContextResolution, resolveProjectContext } from "./context-resolver";

const FIXTURE = path.join(import.meta.dir, "__fixtures__", "vantage-rules");
const TARGET = "src/features/panel/Panel.tsx";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function vantageProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-vantage-fixture-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject", "data", "gdskills"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  await importProjectRules({ projectRoot: root, from: path.join(FIXTURE, "rules"), link: false });
  return root;
}

const resolve = (root: string, maxBytes?: number): Promise<ProjectContextResolution> =>
  resolveProjectContext({ projectRoot: root, files: [TARGET], for: "implement", ...(maxBytes !== undefined ? { maxBytes } : {}) });

test("a .tsx target gets the scoped rules must_read and the index listed, matching the committed expected output", async () => {
  const result = await resolve(await vantageProject());
  const expected = JSON.parse(await readFile(path.join(FIXTURE, "expected.json"), "utf8")) as {
    files: string[];
    entries: Array<{ path: string; reason: string; tier: string; index?: true }>;
    warnings: string[];
  };
  expect({
    files: result.files,
    entries: result.entries.map((entry) => ({ path: entry.path, reason: entry.reason, tier: entry.tier, ...(entry.index === true ? { index: true } : {}) })),
    warnings: result.warnings,
  } as unknown).toEqual(expected as unknown);
});

test("the index file is bigger than the threshold, is listed without being counted, and the rules scoped to other files are absent", async () => {
  const result = await resolve(await vantageProject());
  const index = result.entries.find((entry) => entry.index === true);
  expect(index?.bytes).toBeGreaterThan(INDEX_THRESHOLD_BYTES);
  expect(index?.tier).toBe("on_demand");
  const scoped = result.entries.filter((entry) => entry.tier === "must_read");
  expect(result.budget.usedBytes).toBe(scoped.reduce((sum, entry) => sum + entry.bytes, 0));
  expect(result.entries.some((entry) => entry.path.endsWith("mobx-stores.mdc") || entry.path.endsWith("testing.mdc"))).toBe(false);
});

test("the cap warning appears exactly when the scoped rules no longer fit", async () => {
  const root = await vantageProject();
  const total = (await resolve(root)).budget.usedBytes;
  const fits = await resolve(root, total);
  expect(fits.budget.exceeded).toBe(false);
  expect(fits.warnings).toEqual([]);
  const over = await resolve(root, total - 1);
  expect(over.budget.exceeded).toBe(true);
  expect(over.warnings.filter((warning) => warning.includes("over the"))).toHaveLength(1);
  expect(over.entries.filter((entry) => entry.tier === "on_demand" && entry.index !== true)).toHaveLength(1);
});
