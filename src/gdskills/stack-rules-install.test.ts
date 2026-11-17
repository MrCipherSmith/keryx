import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  bundledStackPackProblems,
  bundledStacksSourcePath,
  detectStackPacks,
  readBundledStackPacks,
  selectStackPacks,
  stackPackComponent,
  stackPackInstallCommand,
  type BundledStackPack,
} from "./stack-rules-install";

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

test("the opt-in command names the manifest component that installs each pack's rules (review LS-5, LS-6)", () => {
  expect(stackPackComponent("react")).toBe("framework:react");
  expect(stackPackComponent("mobx")).toBe("capability:mobx");
  expect(stackPackComponent("nestjs")).toBe("framework:nestjs");
  expect(stackPackComponent("playwright")).toBe("tool:playwright");
  expect(stackPackComponent("storybook")).toBe("tool:storybook");
  expect(stackPackComponent("ts-js-node")).toBe("lang:ts-js-node");
  expect(stackPackInstallCommand("mobx")).toBe("keryx skills install --profile core --target keryx-shell --with capability:mobx");
  // An unreadable manifest still gives a usable hint.
  expect(stackPackInstallCommand("react", "/no/such/manifest.json")).toBe("keryx skills install --profile core --target keryx-shell --with react");
});

test("the bundled stacks tree reports an unreadable root or a pack.json that does not parse (review LS-3)", async () => {
  expect(bundledStackPackProblems(bundledStacksSourcePath())).toEqual([]);
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stacks-"));
  try {
    expect(bundledStackPackProblems(path.join(root, "missing"))[0]).toContain("could not be read (ENOENT)");
    await mkdir(path.join(root, "broken", "rules"), { recursive: true });
    await writeFile(path.join(root, "broken", "pack.json"), "{ not json");
    await mkdir(path.join(root, "no-rules"), { recursive: true });
    expect(bundledStackPackProblems(root)).toEqual([
      "the bundled broken stack pack has no readable pack.json, so it cannot be selected; its rules were not installed — reinstall keryx, then run `keryx update`",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
