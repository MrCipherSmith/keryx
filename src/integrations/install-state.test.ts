// R700-06: `recordSurfaceInstalled` must be idempotent — a second call that
// records the exact same surface (same paths, same on-disk content) must not
// rewrite install-state.json at all, so `keryx update` run twice in a row
// (with nothing else changing) produces no diff.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import { installStatePath, readInstallState, recordSurfaceInstalled } from "./install-state";

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-install-state-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Explicit clock advances: filesystem latency must not decide whether timestamps differ.
let recordedTime = Date.parse("2026-10-13T08:43:35.000Z");
async function recordAtNextTime(...args: Parameters<typeof recordSurfaceInstalled>): Promise<void> {
  const timestamp = new Date(recordedTime += 1000).toISOString();
  const clock = spyOn(Date.prototype, "toISOString").mockReturnValue(timestamp);
  try {
    await recordSurfaceInstalled(...args);
  } finally {
    clock.mockRestore();
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

    await recordAtNextTime(root, "claude", {
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

    await recordAtNextTime(root, "claude", {
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

    await recordAtNextTime(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const firstState = await readInstallState(root, "claude");
    const firstInstalledAt = firstState?.installedModules.find((m) => m.moduleId === "integrations")?.installedAt;
    expect(firstInstalledAt).toBeTruthy();

    await recordAtNextTime(root, "claude", {
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

    await recordAtNextTime(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const firstState = await readInstallState(root, "claude");

    await recordAtNextTime(root, "claude", {
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

    await recordAtNextTime(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const firstState = await readInstallState(root, "claude");

    await writeFile(path.join(root, ".claude", "settings.json"), '{"hooks":{"changed":true}}\n', "utf8");
    await recordAtNextTime(root, "claude", {
      moduleId: "integrations",
      writtenPaths: [".claude/settings.json"],
      managedSentinel: true,
    });
    const secondState = await readInstallState(root, "claude");

    expect(secondState?.recordedAt).not.toBe(firstState?.recordedAt);
  });
});


test("changed content is persisted even when writes share a timestamp", async () => {
  await withTempDir(async (root) => {
    await initMetaproject(root);
    await mkdir(path.join(root, ".claude"), { recursive: true });
    const file = path.join(root, ".claude", "settings.json");
    const clock = spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-13T08:43:35.947Z");
    try {
      const entry = { moduleId: "integrations", writtenPaths: [".claude/settings.json"], managedSentinel: true };
      await writeFile(file, '{"hooks":{}}\n', "utf8");
      await recordSurfaceInstalled(root, "claude", entry);
      const first = await readInstallState(root, "claude");
      const firstBytes = await readFile(installStatePath(root, "claude"), "utf8");
      await writeFile(file, '{"hooks":{"changed":true}}\n', "utf8");
      await recordSurfaceInstalled(root, "claude", entry);
      const second = await readInstallState(root, "claude");
      expect(second?.recordedAt).toBe(first?.recordedAt);
      expect(second?.installedModules[0]?.installedAt).toBe(first?.installedModules[0]?.installedAt);
      expect(second?.installedModules[0]?.sha256).not.toEqual(first?.installedModules[0]?.sha256);
      expect(await readFile(installStatePath(root, "claude"), "utf8")).not.toBe(firstBytes);
    } finally {
      clock.mockRestore();
    }
  });
});
