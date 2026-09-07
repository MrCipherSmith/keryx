import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createGdgraphService, UnknownGraphTargetError } from "./service";

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-svc-"));
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

// AFC-10 (flow 234, phase 2): before this task, `service.affected` for a
// target the graph never indexed and a target the graph indexed but found no
// edges for returned byte-identical shapes — `{dependencies: [], dependents:
// [], ranked: []}` — differing only in the echoed-back `target` string.
// Measured directly against this exact fixture: an unknown path
// ("src/does-not-exist.ts") and a real, indexed, edge-less leaf file
// produced the same `{dependencies, dependents, ranked}`. That is the same
// defect class phase 1 closed at eight other sites — a failure rendered as a
// legitimate empty success — so an unknown target must now be reported
// distinguishably instead of silently resolving to an empty result.
test("AFC-10 — service.affected on a target the graph never indexed throws UnknownGraphTargetError, distinct from an indexed-but-edgeless target", async () => {
  const root = await makeProject();
  try {
    await writeFile(path.join(root, "src", "isolated.ts"), "export const iso = 1;\n");
    const service = createGdgraphService();
    await service.build(root);

    // Indexed, legitimately no edges at all: a real success, not an error.
    const indexedNoEdges = await service.affected(root, "src/isolated.ts");
    expect(indexedNoEdges.dependencies).toEqual([]);
    expect(indexedNoEdges.dependents).toEqual([]);

    // Never indexed: must be distinguishable from the above, not the same
    // `{dependencies: [], dependents: []}` shape under a different `target`.
    await expect(service.affected(root, "src/does-not-exist.ts")).rejects.toThrow(UnknownGraphTargetError);
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
