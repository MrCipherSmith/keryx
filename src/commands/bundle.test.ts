// Flow 313 (W4 portability), T10 — `keryx bundle export|import|inspect|verify|uninstall`.
// In-process command tests: export -> verify -> inspect -> import (dry-run
// writes nothing; a real import writes and prints) -> uninstall, refusal exit
// codes, and the `--force` path. Every test runs against temp directories
// with `KERYX_HOME` pointed at a temp home so nothing touches the real
// `~/.keryx/`.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { bundleCommand } from "./bundle";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let originalKeryxHome: string | undefined;

beforeEach(() => {
  originalKeryxHome = process.env.KERYX_HOME;
});

afterEach(async () => {
  if (originalKeryxHome === undefined) delete process.env.KERYX_HOME;
  else process.env.KERYX_HOME = originalKeryxHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let captured: string[] = [];
let capturedErr: string[] = [];
let originalLog: typeof console.log;
let originalErr: typeof console.error;

function install(): void {
  captured = [];
  capturedErr = [];
  originalLog = console.log;
  originalErr = console.error;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => capturedErr.push(parts.map(String).join(" "));
  process.exitCode = 0;
}

function restore(): void {
  console.log = originalLog;
  console.error = originalErr;
}

async function makeSourceProject(): Promise<string> {
  const root = await makeTempDir("keryx-bundle-src-");
  await mkdir(path.join(root, ".metaproject", "skills", "acme-widget"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "skills", "acme-widget", "SKILL.md"),
    "---\nname: acme-widget\ndescription: Build acme widgets\n---\nBody text.\n",
    "utf8",
  );
  return root;
}

function lastJson(): unknown {
  return JSON.parse(captured.join("\n"));
}

describe("keryx bundle export -> verify -> inspect -> import -> uninstall", () => {
  test("full lifecycle across two project roots, with a temp KERYX_HOME", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProject();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "test-bundle", bundleDir, "--json"], sourceRoot);
      expect(process.exitCode).toBe(0);
      expect(capturedErr).toEqual([]);
      const exportResult = lastJson() as { ok: boolean; bundleId: string; entries: number };
      expect(exportResult.ok).toBe(true);
      expect(exportResult.bundleId).toBe("test-bundle");
      expect(exportResult.entries).toBe(1);
      expect(existsSync(path.join(bundleDir, "bundle.json"))).toBe(true);
    } finally {
      restore();
    }

    // verify
    install();
    try {
      await bundleCommand(["verify", bundleDir, "--json"], sourceRoot);
      expect(process.exitCode).toBe(0);
      const verifyResult = lastJson() as { ok: boolean; bundleId: string };
      expect(verifyResult.ok).toBe(true);
      expect(verifyResult.bundleId).toBe("test-bundle");
    } finally {
      restore();
    }

    const targetRoot = await makeTempDir("keryx-bundle-target-");

    // inspect against a fresh target: entry should be "new"
    install();
    try {
      await bundleCommand(["inspect", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const inspectResult = lastJson() as { ok: boolean; entries: Array<{ bucket: string }> };
      expect(inspectResult.ok).toBe(true);
      expect(inspectResult.entries[0]?.bucket).toBe("new");
    } finally {
      restore();
    }

    // dry-run import: writes nothing
    install();
    try {
      await bundleCommand(["import", bundleDir, "--dry-run", "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      expect(existsSync(path.join(targetRoot, ".metaproject", "skills", "acme-widget", "SKILL.md"))).toBe(false);
    } finally {
      restore();
    }

    // real import: writes and prints
    install();
    try {
      await bundleCommand(["import", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const importResult = lastJson() as { ok: boolean; bundleId: string; written: string[] };
      expect(importResult.ok).toBe(true);
      expect(importResult.written).toEqual(["project:skills/acme-widget/SKILL.md"]);
      const written = await readFile(path.join(targetRoot, ".metaproject", "skills", "acme-widget", "SKILL.md"), "utf8");
      expect(written).toContain("acme-widget");
    } finally {
      restore();
    }

    // uninstall
    install();
    try {
      await bundleCommand(["uninstall", "test-bundle", "--target-scope", "project", "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const uninstallResult = lastJson() as { ok: boolean; removed: string[] };
      expect(uninstallResult.ok).toBe(true);
      expect(uninstallResult.removed).toEqual(["skills/acme-widget/SKILL.md"]);
      expect(existsSync(path.join(targetRoot, ".metaproject", "skills", "acme-widget", "SKILL.md"))).toBe(false);
    } finally {
      restore();
    }
  });

  test("re-importing after a hand-edit conflicts, and --force overwrites it", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProject();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "force-bundle", bundleDir, "--json"], sourceRoot);
    } finally {
      restore();
    }

    const targetRoot = await makeTempDir("keryx-bundle-target-");

    install();
    try {
      await bundleCommand(["import", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
    } finally {
      restore();
    }

    // Hand-edit the written file outside Keryx's own write.
    const writtenPath = path.join(targetRoot, ".metaproject", "skills", "acme-widget", "SKILL.md");
    await writeFile(writtenPath, "hand-edited content\n", "utf8");

    // Re-importing the same bundle now conflicts and refuses.
    install();
    try {
      await bundleCommand(["import", bundleDir, "--json"], targetRoot);
      expect(process.exitCode).toBe(1);
      const refused = lastJson() as { ok: boolean; refusals: Array<{ reason: string }> };
      expect(refused.ok).toBe(false);
      expect(refused.refusals.some((r) => r.reason === "unresolved-conflict")).toBe(true);
      // Nothing was written over the hand edit.
      expect(await readFile(writtenPath, "utf8")).toBe("hand-edited content\n");
    } finally {
      restore();
    }

    // --force names the conflicting entry and overwrites it.
    install();
    try {
      await bundleCommand(["import", bundleDir, "--force", "skills/acme-widget/SKILL.md", "--json"], targetRoot);
      expect(process.exitCode).toBe(0);
      const forced = lastJson() as { ok: boolean; written: string[] };
      expect(forced.ok).toBe(true);
      expect(forced.written).toEqual(["project:skills/acme-widget/SKILL.md"]);
      expect(await readFile(writtenPath, "utf8")).toContain("acme-widget");
    } finally {
      restore();
    }
  });
});

describe("keryx bundle — refusal and usage exit codes", () => {
  test("export with an unknown --scope is a usage error, exit 2", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;
    const root = await makeTempDir("keryx-bundle-usage-");

    install();
    try {
      await bundleCommand(["export", "--scope", "nonsense", path.join(root, "out")], root);
      expect(process.exitCode).toBe(2);
      expect(capturedErr.join("\n")).toContain("--scope must be one of");
    } finally {
      restore();
    }
  });

  test("export with no --scope at all is a usage error, exit 2", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;
    const root = await makeTempDir("keryx-bundle-usage-");

    install();
    try {
      await bundleCommand(["export", path.join(root, "out")], root);
      expect(process.exitCode).toBe(2);
    } finally {
      restore();
    }
  });

  test("verify on a bundle with a tampered checksum fails closed, exit 1", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;

    const sourceRoot = await makeSourceProject();
    const bundleDir = path.join(await makeTempDir("keryx-bundle-out-"), "bundle-out");

    install();
    try {
      await bundleCommand(["export", "--scope", "project", "--id", "tamper-bundle", bundleDir, "--json"], sourceRoot);
    } finally {
      restore();
    }

    // Tamper with an exported file's bytes, same length, without updating
    // bundle.json's checksum — this trips checksum-mismatch specifically
    // rather than the (also-refusing) size-mismatch path.
    const original = await readFile(path.join(bundleDir, "skills", "acme-widget", "SKILL.md"), "utf8");
    await writeFile(path.join(bundleDir, "skills", "acme-widget", "SKILL.md"), "X".repeat(original.length), "utf8");

    install();
    try {
      await bundleCommand(["verify", bundleDir, "--json"], sourceRoot);
      expect(process.exitCode).toBe(1);
      const result = lastJson() as { ok: boolean; entries: Array<{ status: string }> };
      expect(result.ok).toBe(false);
      expect(result.entries.some((e) => e.status === "checksum-mismatch")).toBe(true);
    } finally {
      restore();
    }
  });

  test("uninstall requires --target-scope, exit 2", async () => {
    const home = await makeTempDir("keryx-bundle-home-");
    process.env.KERYX_HOME = home;
    const root = await makeTempDir("keryx-bundle-usage-");

    install();
    try {
      await bundleCommand(["uninstall", "some-bundle"], root);
      expect(process.exitCode).toBe(2);
    } finally {
      restore();
    }
  });
});
