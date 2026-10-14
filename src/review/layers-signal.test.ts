import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { layersLockPath } from "./layers";
import { createLayersFixture, git, type LayersFixture } from "./layers.test-helpers";

let fixture: LayersFixture;
beforeEach(async () => {
  fixture = await createLayersFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

const HANG = "await new Promise(() => {});";

/** Where the child stops: the hook that never returns, and the line it writes first so the test knows it is there. */
const PHASES: Record<string, string> = {
  "the sweep that follows the lock": `git: async (cwd, args) => { if (args.includes("list")) { writeFileSync(READY, "1"); ${HANG} } return defaultLayerDeps.git(cwd, args); },`,
  "the graph build": `buildGraph: async () => { writeFileSync(READY, "1"); ${HANG} },`,
  "the wiki refresh": `refreshWiki: async () => { writeFileSync(READY, "1"); ${HANG} },`,
  "the memory index": `indexMemory: async () => { writeFileSync(READY, "1"); ${HANG} },`,
  "the checkout's removal after the build": `git: async (cwd, args) => { if (args.includes("remove") && !globalThis.HELD) { globalThis.HELD = true; writeFileSync(READY, "1"); await new Promise((resolve) => setTimeout(resolve, 20000)); } return defaultLayerDeps.git(cwd, args); },`,
  "the layers.json write":`writeLayers: async () => { writeFileSync(READY, "1"); ${HANG} },`,
};

const registered = (): string[] =>
  git(fixture.root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));

describe("a signal at any phase of a refresh leaves nothing behind", () => {
  for (const [phase, hook] of Object.entries(PHASES)) {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      test(`${signal} during ${phase} releases the lock and removes the checkout and the staging directory`, async () => {
        const ready = path.join(fixture.root, "ready.flag");
        const script = path.join(fixture.root, "child.ts");
        await writeFile(
          script,
          [
            `import { writeFileSync } from "node:fs";`,
            `import { defaultLayerDeps, refreshLayers } from ${JSON.stringify(path.resolve(import.meta.dir, "layers.ts"))};`,
            `const READY = ${JSON.stringify(ready)};`,
            `await refreshLayers({ projectRoot: ${JSON.stringify(fixture.root)}, packageDir: ${JSON.stringify(fixture.packageDir)}, deps: {`,
            `  ${hook}`,
            `} });`,
          ].join("\n"),
        );
        const child = spawn(process.execPath, ["run", script], { stdio: "ignore" });
        const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, killedBy) => resolve(killedBy)));
        try {
          const deadline = Date.now() + 30_000;
          while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          expect(existsSync(ready)).toBe(true);
          expect(existsSync(layersLockPath(fixture.packageDir))).toBe(true);

          child.kill(signal);
          expect(await exited).toBe(signal);

          expect(existsSync(layersLockPath(fixture.packageDir))).toBe(false);
          expect(registered()).toHaveLength(1);
          const names = await readdir(path.join(fixture.packageDir, "layers"));
          expect(names.filter((name) => name.startsWith("graph.") && name !== "graph")).toEqual([]);
        } finally {
          child.kill("SIGKILL");
        }
      }, 60_000);
    }
  }
});
