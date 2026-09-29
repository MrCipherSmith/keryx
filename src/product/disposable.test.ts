// Flow 362, AC3: `.metaproject/data/product/` is disposable. `index` writes
// nowhere else, nothing reads product data from anywhere else, and deleting the
// directory then rebuilding gives an equivalent index.

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { productCommand } from "../commands/product";
import { buildIntentIndex } from "./corpus";
import { copyFixtureRepo } from "./fixtures/repo";
import { loadOpenReport, productDataRoot } from "./service";
import { indexPath, writeIntentIndex } from "./store";

const roots: string[] = [];
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;

async function project(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

async function snapshot(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(full, base));
    else out[path.relative(base, full)] = await readFile(full, "utf8");
  }
  return out;
}

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the product data directory is disposable", () => {
  test("`index` writes only under `.metaproject/data/product/`", async () => {
    const root = await project();
    const before = await snapshot(root);
    process.chdir(root);
    console.log = () => {};
    await productCommand(["index"]);
    const after = await snapshot(root);
    const added = Object.keys(after).filter((file) => !(file in before));
    expect(added).toEqual([path.join(".metaproject", "data", "product", "index.json")]);
    for (const file of Object.keys(before)) expect(after[file]).toBe(before[file] ?? "");
  });

  test("deleting the directory and rebuilding gives the same index", async () => {
    const root = await project();
    await writeIntentIndex(root, await buildIntentIndex(root));
    const first = await readFile(indexPath(root), "utf8");
    await rm(productDataRoot(root), { recursive: true, force: true });
    await expect(stat(productDataRoot(root))).rejects.toThrow();
    await writeIntentIndex(root, await buildIntentIndex(root));
    expect(await readFile(indexPath(root), "utf8")).toBe(first);
  });

  test("with the directory gone, `open` has nothing to read and says how to rebuild", async () => {
    const root = await project();
    await writeIntentIndex(root, await buildIntentIndex(root));
    await rm(productDataRoot(root), { recursive: true, force: true });
    const loaded = await loadOpenReport(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.message).toContain("keryx product index");
  });

  test("the index is a function of the flows and requirements, not of an earlier index", async () => {
    const root = await project();
    await Bun.write(indexPath(root), JSON.stringify({ schemaVersion: 1, intents: [], unusable: 99, failures: ["planted"], counts: {} }));
    const built = await buildIntentIndex(root);
    expect(built.unusable).toBe(1);
    expect(built.failures).toEqual([]);
  });

  test("no source file outside the module reads the product data directory", async () => {
    const repo = path.resolve(import.meta.dir, "..", "..");
    const readers = ["readIntentIndex", "productDataRoot", "data/product"];
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "fixtures" || entry.name === "node_modules") continue;
          await walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const relative = path.relative(repo, full);
          if (relative.startsWith(path.join("src", "product") + path.sep)) continue;
          const text = await readFile(full, "utf8");
          if (readers.some((reader) => text.includes(reader))) offenders.push(relative);
        }
      }
    }
    await walk(path.join(repo, "src"));
    // The registries and the help text name the file in prose; none of them opens it.
    expect(offenders.sort()).toEqual(["src/commands/product.ts", "src/standard/command-registry.ts"]);
  });
});
