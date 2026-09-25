// Flow 313 (W4 portability), review round 2 fix (R1-F20 remainder, shared
// with `./symlink-safety`): `installSurfaces`/`uninstallSurfaces` used to
// `readFile`/`writeFile` a JSON settings file straight through ANY symlink on
// its path — a symlink planted under the project root (by a bundle import,
// or any other writer) could redirect a JSON surface's write to a file
// outside the project root entirely. These pin the fix: an ESCAPING symlink
// is refused with no write, and an ordinary IN-REPO symlink (a common repo
// layout, e.g. a shared `.agents` config directory symlinked from `.claude`)
// is followed normally — mirroring `markdown-block.test.ts`'s F8 tests for
// the sibling markdown-block write path.

import { existsSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { createSettingsFileOwner, installSurfaces, uninstallSurfaces } from "./settings-file";
import type { Settings, SurfaceAdapter } from "./types";

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-settings-file-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const RELATIVE_PATH = ".claude/settings.json";

function fakeSurface(): SurfaceAdapter {
  return {
    id: "fake-surface",
    flag: "block",
    subsystem: "ctx-guard",
    sentinel: "keryx-fake-surface",
    confidence: "verified",
    sourceDocs: [],
    slots: [],
    relativePath: RELATIVE_PATH,
    merge: (settings: Settings) => ({ ...settings, fakeSurfaceInstalled: true }),
    strip: (settings: Settings) => {
      const next = { ...settings };
      delete next.fakeSurfaceInstalled;
      return next;
    },
  };
}

describe("R1-F20 remainder / shared symlink-safety: installSurfaces/uninstallSurfaces refuse an escaping symlink", () => {
  test("install refuses a symlinked parent directory whose real path leaves root, and writes nothing", async () => {
    await withTempDir(async (root) => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "keryx-settings-file-outside-"));
      try {
        await mkdir(root, { recursive: true });
        symlinkSync(outsideDir, path.join(root, ".claude"));

        const owner = createSettingsFileOwner(RELATIVE_PATH, [fakeSurface()]);
        const { errors } = await installSurfaces(root, RELATIVE_PATH, ["fake-surface"], owner);

        expect(errors.length).toBe(1);
        expect(errors[0]).toContain("symlink");
        expect(existsSync(path.join(outsideDir, "settings.json"))).toBe(false);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test("uninstall refuses the same escaping symlink and never touches the outside file", async () => {
    await withTempDir(async (root) => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), "keryx-settings-file-outside-"));
      try {
        await mkdir(root, { recursive: true });
        symlinkSync(outsideDir, path.join(root, ".claude"));
        const outsideFile = path.join(outsideDir, "settings.json");
        await writeFile(outsideFile, "{}\n", "utf8");

        const owner = createSettingsFileOwner(RELATIVE_PATH, [fakeSurface()]);
        const { errors } = await uninstallSurfaces(root, RELATIVE_PATH, ["fake-surface"], owner);

        expect(errors.length).toBe(1);
        expect(errors[0]).toContain("symlink");
        expect(await readFile(outsideFile, "utf8")).toBe("{}\n");
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  test("an in-repo symlinked parent directory (real path stays inside root) is followed, not refused", async () => {
    await withTempDir(async (root) => {
      const realDir = path.join(root, ".agents-real");
      await mkdir(realDir, { recursive: true });
      symlinkSync(realDir, path.join(root, ".claude"));

      const owner = createSettingsFileOwner(RELATIVE_PATH, [fakeSurface()]);
      const { errors } = await installSurfaces(root, RELATIVE_PATH, ["fake-surface"], owner);

      expect(errors).toEqual([]);
      const written = await readFile(path.join(realDir, "settings.json"), "utf8");
      expect(JSON.parse(written)).toEqual({ fakeSurfaceInstalled: true });
    });
  });
});
