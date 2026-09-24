// Flow 313 (W4 portability), T6 — uninstall.ts: removes only unmodified
// bundle-managed files, keeps human-modified ones with a warning.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appliedStatePath, writeAppliedState } from "./applied-state";
import { sha256Hex } from "./checksum";
import { uninstallBundle } from "./uninstall";

let root: string;
let projectRoot: string;
let homeDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-uninstall-"));
  projectRoot = path.join(root, "project");
  homeDir = path.join(root, "home");
  mkdirSync(path.join(projectRoot, ".metaproject", "agents"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("uninstallBundle", () => {
  test("removes an unmodified bundle-managed file and drops it from the ledger", async () => {
    const filePath = path.join(projectRoot, ".metaproject", "agents", "a.md");
    writeFileSync(filePath, "managed content");
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 1,
      entries: { "agents/a.md": { bundleId: "keryx-project-x", sha256: sha256Hex(Buffer.from("managed content")), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z" } },
    });

    const result = await uninstallBundle({ bundleId: "keryx-project-x", targetScope: "project", projectRoot, homeDir, env: {} });
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual(["agents/a.md"]);
    expect(existsSync(filePath)).toBe(false);
  });

  test("keeps a human-modified file with reason user-modified", async () => {
    const filePath = path.join(projectRoot, ".metaproject", "agents", "a.md");
    writeFileSync(filePath, "human edited content");
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 1,
      entries: { "agents/a.md": { bundleId: "keryx-project-x", sha256: sha256Hex(Buffer.from("original content")), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z" } },
    });

    const result = await uninstallBundle({ bundleId: "keryx-project-x", targetScope: "project", projectRoot, homeDir, env: {} });
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([{ path: "agents/a.md", reason: "user-modified" }]);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("human edited content");
  });

  test("reports a missing file and drops it from the ledger without error", async () => {
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 1,
      entries: { "agents/gone.md": { bundleId: "keryx-project-x", sha256: "a".repeat(64), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z" } },
    });
    const result = await uninstallBundle({ bundleId: "keryx-project-x", targetScope: "project", projectRoot, homeDir, env: {} });
    expect(result.missing).toEqual(["agents/gone.md"]);
  });

  test("only removes entries for the named bundleId", async () => {
    const filePath = path.join(projectRoot, ".metaproject", "agents", "a.md");
    writeFileSync(filePath, "managed content");
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 1,
      entries: { "agents/a.md": { bundleId: "keryx-project-other", sha256: sha256Hex(Buffer.from("managed content")), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z" } },
    });
    const result = await uninstallBundle({ bundleId: "keryx-project-x", targetScope: "project", projectRoot, homeDir, env: {} });
    expect(result.removed).toEqual([]);
    expect(existsSync(filePath)).toBe(true);
  });
});
