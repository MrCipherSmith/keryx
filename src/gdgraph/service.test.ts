import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createGdgraphService } from "./service";

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-svc-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "src", "b.ts"), "import { a } from './a';\nexport const b = a;\n");
  await writeFile(path.join(root, "src", "c.ts"), "import { b } from './b';\nexport const c = b;\n");
  return root;
}

test("AC5.3/T-1 — service.affected is a pure in-process method (transport-independent)", async () => {
  const root = await makeProject();
  try {
    const service = createGdgraphService();
    await service.build(root);
    // depth 2 closure of a: b (hop1) + c (hop2).
    const affected = await service.affected(root, "src/a.ts", { depth: 2 });
    expect(affected.dependents).toEqual(["src/b.ts", "src/c.ts"]);
    // default depth (config) = 1 ⇒ only direct dependents.
    const shallow = await service.affected(root, "src/a.ts");
    expect(shallow.dependents).toEqual(["src/b.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC5.3/T-1 — service.repomap writes artifacts/repomap.md deterministically", async () => {
  const root = await makeProject();
  try {
    const service = createGdgraphService();
    await service.build(root);
    const first = await service.repomap(root, { budget: 2000 });
    expect(first.path).toContain(path.join("artifacts", "repomap.md"));
    expect(first.tokens).toBeLessThanOrEqual(2000);
    const second = await service.repomap(root, { budget: 2000 });
    expect(second.content).toBe(first.content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service.query returns cycles + orphans over the built graph", async () => {
  const root = await makeProject();
  try {
    const service = createGdgraphService();
    await service.build(root);
    const cycles = await service.query(root, "cycles");
    expect(Array.isArray(cycles)).toBe(true);
    const orphans = await service.query(root, "orphans");
    expect(Array.isArray(orphans)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
