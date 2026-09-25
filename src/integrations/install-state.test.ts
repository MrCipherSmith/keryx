// R700-06: `recordSurfaceInstalled` must be idempotent — a second call that
// records the exact same surface (same paths, same on-disk content) must not
// rewrite install-state.json at all, so `keryx update` run twice in a row
// (with nothing else changing) produces no diff.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { installStatePath, readInstallState, recordSurfaceInstalled } from "./install-state";

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-install-state-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function initMetaproject(root: string): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
}

test("a second recordSurfaceInstalled call with unchanged content does not rewrite the file (mtime and bytes both stable)", async () => {
  await withTempDir(async (root) => {
    await initMetaproject(root);
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.json"), '{"hooks":{}}\n', "utf8");

    await recordSurfaceInstalled(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });

    const statePath = installStatePath(root, "claude");
    const firstBytes = await readFile(statePath, "utf8");
    const firstStat = await stat(statePath);
    // Ensure the clock has moved on so a spurious rewrite would be
    // detectable via mtime even if byte comparison had a blind spot.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await recordSurfaceInstalled(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });

    const secondBytes = await readFile(statePath, "utf8");
    const secondStat = await stat(statePath);

    expect(secondBytes).toBe(firstBytes);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });
});

test("installedAt is kept from the first install across a no-op re-record", async () => {
  await withTempDir(async (root) => {
    await initMetaproject(root);
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.json"), '{"hooks":{}}\n', "utf8");

    await recordSurfaceInstalled(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const firstState = await readInstallState(root, "claude");
    const firstInstalledAt = firstState?.installedModules.find((m) => m.moduleId === "integrations")?.installedAt;
    expect(firstInstalledAt).toBeTruthy();

    await recordSurfaceInstalled(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const secondState = await readInstallState(root, "claude");
    const secondInstalledAt = secondState?.installedModules.find((m) => m.moduleId === "integrations")?.installedAt;

    expect(secondInstalledAt).toBe(firstInstalledAt);
  });
});

test("a real content change (different written path) still rewrites the file and bumps recordedAt", async () => {
  await withTempDir(async (root) => {
    await initMetaproject(root);
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.json"), '{"hooks":{}}\n', "utf8");
    await writeFile(path.join(root, ".claude", "extra.json"), "{}\n", "utf8");

    await recordSurfaceInstalled(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const firstState = await readInstallState(root, "claude");

    await recordSurfaceInstalled(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json", ".claude/extra.json"],
      managedSentinel: true,
    });
    const secondState = await readInstallState(root, "claude");

    expect(secondState?.recordedAt).not.toBe(firstState?.recordedAt);
    expect(secondState?.installedModules.find((m) => m.moduleId === "integrations")?.writtenPaths).toEqual([
      ".claude/settings.json",
      ".claude/extra.json",
    ]);
  });
});

test("a changed on-disk hash (same paths, different content) still rewrites the file", async () => {
  await withTempDir(async (root) => {
    await initMetaproject(root);
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.json"), '{"hooks":{}}\n', "utf8");

    await recordSurfaceInstalled(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const firstState = await readInstallState(root, "claude");

    await writeFile(path.join(root, ".claude", "settings.json"), '{"hooks":{"changed":true}}\n', "utf8");
    await recordSurfaceInstalled(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const secondState = await readInstallState(root, "claude");

    expect(secondState?.recordedAt).not.toBe(firstState?.recordedAt);
  });
});
