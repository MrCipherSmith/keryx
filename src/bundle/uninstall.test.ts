// Flow 313 (W4 portability), T6 — uninstall.ts: removes only unmodified
// bundle-managed files, keeps human-modified ones with a warning.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  // R1-F9: uninstall must never trust a ledger key verbatim — a planted or
  // hand-edited `applied-state.json` (not gitignored pre-fix) with a
  // `../../victim.txt` key, or a key under a symlinked directory, must be
  // refused rather than deleted.
  describe("R1-F9: ledger keys are re-validated before any read/unlink", () => {
    test("a ../ ledger key is refused; the file it points at outside the scope root is untouched", async () => {
      const victimPath = path.join(root, "victim.txt");
      writeFileSync(victimPath, "do not delete me");
      const evilRelPath = "../../../victim.txt";
      // Craft the ledger by hand — a real `applyBundlePlan` could never
      // produce this key, but a planted/checked-in ledger could.
      await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
        schemaVersion: 1,
        entries: { [evilRelPath]: { bundleId: "keryx-project-evil", sha256: sha256Hex(Buffer.from("do not delete me")), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z" } },
      });

      const result = await uninstallBundle({ bundleId: "keryx-project-evil", targetScope: "project", projectRoot, homeDir, env: {} });
      expect(result.ok).toBe(false);
      expect(result.refusals[0]?.reason).toBe("corrupt-ledger");
      expect(existsSync(victimPath)).toBe(true);
      expect(readFileSync(victimPath, "utf8")).toBe("do not delete me");
    });

    test("a ledger key under a symlinked directory is refused; the symlink target is untouched", async () => {
      const outsideDir = path.join(root, "outside");
      mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, "SKILL.md");
      writeFileSync(outsideFile, "outside content");
      const linkedDir = path.join(projectRoot, ".metaproject", "skills", "linked");
      mkdirSync(path.join(projectRoot, ".metaproject", "skills"), { recursive: true });
      symlinkSync(outsideDir, linkedDir);

      await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
        schemaVersion: 1,
        entries: {
          "skills/linked/SKILL.md": { bundleId: "keryx-project-evil", sha256: sha256Hex(Buffer.from("outside content")), kind: "skill", appliedAt: "2026-09-24T00:00:00.000Z" },
        },
      });

      const result = await uninstallBundle({ bundleId: "keryx-project-evil", targetScope: "project", projectRoot, homeDir, env: {} });
      expect(result.ok).toBe(false);
      expect(result.refusals[0]?.reason).toBe("symlink-refused");
      expect(existsSync(outsideFile)).toBe(true);
      expect(readFileSync(outsideFile, "utf8")).toBe("outside content");
    });
  });

  // R1-F29: the ledger-read-failure reason must be the named `corrupt-ledger`
  // reason, not the misleading `not-a-bundle` (a ledger is not a bundle at
  // all, so that reason string actively pointed a caller the wrong way).
  test("R1-F29: a corrupt ledger file is refused with reason corrupt-ledger", async () => {
    const ledgerPath = appliedStatePath("project", { projectRoot, homeDir, env: {} });
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, "{ this is not valid json");
    const result = await uninstallBundle({ bundleId: "keryx-project-x", targetScope: "project", projectRoot, homeDir, env: {} });
    expect(result.ok).toBe(false);
    expect(result.refusals[0]?.reason).toBe("corrupt-ledger");
  });
});
