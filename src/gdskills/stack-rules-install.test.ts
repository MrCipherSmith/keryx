import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { bundledStacksSourcePath, detectStackPacks, readBundledStackPacks, selectStackPacks, type BundledStackPack } from "./stack-rules-install";

const pack = (id: string, detectionMarkers: string[], parents: string[] = []): BundledStackPack => ({ id, detectionMarkers, extends: parents });

test("a detected pack brings every pack it extends, transitively; undetected packs stay out", () => {
  const packs = [
    pack("ts-js-node", ["typescript", "javascript", "node"]),
    pack("react", ["react"], ["ts-js-node"]),
    pack("mobx", ["mobx"], ["react"]),
    pack("vue", ["vue"], ["ts-js-node"]),
    pack("nextjs-nuxt", ["nextjs", "nuxt"], ["react", "vue"]),
    pack("python", ["python"]),
  ];
  expect(selectStackPacks(packs, { mobx: true })).toEqual(["mobx", "react", "ts-js-node"]);
  expect(selectStackPacks(packs, { nuxt: true })).toEqual(["nextjs-nuxt", "react", "ts-js-node", "vue"]);
  expect(selectStackPacks(packs, { python: true, react: false })).toEqual(["python"]);
  expect(selectStackPacks(packs, {})).toEqual([]);
  // A parent the bundle does not ship is skipped, not invented.
  expect(selectStackPacks([pack("orphan", ["x"], ["missing"])], { x: true })).toEqual(["orphan"]);
});

test("the bundled stacks include the P4 rules-only packs with their detection markers", () => {
  const packs = new Map(readBundledStackPacks(bundledStacksSourcePath()).map((entry) => [entry.id, entry]));
  expect(packs.get("playwright")?.detectionMarkers).toEqual(["playwright"]);
  expect(packs.get("storybook")?.detectionMarkers).toEqual(["storybook"]);
  expect(packs.get("mobx")?.extends).toEqual(["react"]);
  expect(packs.get("react")?.extends).toEqual(["ts-js-node"]);
  expect(packs.get("nestjs")?.extends).toEqual(["ts-js-node"]);
});

test("detection on a real tree: a Storybook + React project selects storybook, react and ts-js-node; a Go project none of them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stack-packs-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { "@storybook/react-vite": "^8.4.0", react: "^18.3.1" } }));
    expect(await detectStackPacks(root)).toEqual(["react", "storybook", "ts-js-node"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const go = await mkdtemp(path.join(tmpdir(), "keryx-stack-packs-"));
  try {
    await writeFile(path.join(go, "go.mod"), "module example.com/fixture\n\ngo 1.22\n");
    const selected = await detectStackPacks(go);
    expect(selected).toContain("go");
    for (const id of ["ts-js-node", "react", "mobx", "nestjs", "playwright", "storybook"]) expect(selected).not.toContain(id);
  } finally {
    await rm(go, { recursive: true, force: true });
  }
});
