// `keryx retention status|sweep` (flow 237 phase 5, T8).
//
// RED first: written against `./retention`, which does not exist yet.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { retentionCommand } from "./retention";

const DAY_MS = 24 * 60 * 60 * 1000;

async function project(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "retention-cmd-"));
}

async function writeAged(filePath: string, content: string, ageDays: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(filePath, when, when);
}

function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

describe("retentionCommand: sweep dry-run is the default", () => {
  test("bare `sweep` with no --apply removes nothing", async () => {
    const cwd = await project();
    await writeAged(path.join(cwd, ".metaproject", "data", "gdctx", "raw", "old.log"), "x", 30);

    const { logs, restore } = captureLogs();
    try {
      await retentionCommand(["sweep", "--json"], { cwd });
    } finally {
      restore();
    }

    const remaining = await readdir(path.join(cwd, ".metaproject", "data", "gdctx", "raw"));
    expect(remaining).toEqual(["old.log"]);
    const report = JSON.parse(logs.join("\n")) as { dryRun: boolean };
    expect(report.dryRun).toBe(true);
  });

  test("--apply actually removes eligible entries", async () => {
    const cwd = await project();
    await writeAged(path.join(cwd, ".metaproject", "data", "gdctx", "raw", "old.log"), "x", 30);

    const { restore } = captureLogs();
    try {
      await retentionCommand(["sweep", "--apply", "--json"], { cwd });
    } finally {
      restore();
    }

    const remaining = await readdir(path.join(cwd, ".metaproject", "data", "gdctx", "raw"));
    expect(remaining).toEqual([]);
  });

  test("--target narrows the sweep to one target id", async () => {
    const cwd = await project();
    await writeAged(path.join(cwd, ".metaproject", "data", "gdctx", "raw", "old.log"), "x", 30);
    await writeAged(path.join(cwd, ".metaproject", "data", "gdctx", "artifacts", "old.md"), "x", 30);

    const { restore } = captureLogs();
    try {
      await retentionCommand(["sweep", "--apply", "--target", "gdctx-raw", "--json"], { cwd });
    } finally {
      restore();
    }

    const rawRemaining = await readdir(path.join(cwd, ".metaproject", "data", "gdctx", "raw"));
    const artifactsRemaining = await readdir(path.join(cwd, ".metaproject", "data", "gdctx", "artifacts"));
    expect(rawRemaining).toEqual([]);
    expect(artifactsRemaining).toEqual(["old.md"]);
  });
});

describe("retentionCommand: sweep overrides", () => {
  test("--max-age-days overrides the age cutoff for this run", async () => {
    const cwd = await project();
    // 5 days old: inside every target's real default (14d), but outside a
    // --max-age-days 1 override for this run.
    await writeAged(path.join(cwd, ".metaproject", "data", "gdctx", "raw", "recent.log"), "x", 5);

    const { restore } = captureLogs();
    try {
      await retentionCommand(["sweep", "--apply", "--max-age-days", "1", "--json"], { cwd });
    } finally {
      restore();
    }

    const remaining = await readdir(path.join(cwd, ".metaproject", "data", "gdctx", "raw"));
    expect(remaining).toEqual([]);
  });
});

describe("retentionCommand: status is read-only", () => {
  test("status reports counts/bytes without touching disk", async () => {
    const cwd = await project();
    await writeAged(path.join(cwd, ".metaproject", "data", "gdctx", "raw", "old.log"), "x".repeat(10), 30);

    const { logs, restore } = captureLogs();
    try {
      await retentionCommand(["status", "--json"], { cwd });
    } finally {
      restore();
    }

    const remaining = await readdir(path.join(cwd, ".metaproject", "data", "gdctx", "raw"));
    expect(remaining).toEqual(["old.log"]);
    const parsed = JSON.parse(logs.join("\n")) as { targets: Array<{ id: string; entriesScanned: number }> };
    const raw = parsed.targets.find((t) => t.id === "gdctx-raw");
    expect(raw?.entriesScanned).toBe(1);
  });
});

describe("retentionCommand: exit codes and help", () => {
  test("an unreachable store exits 1 and never prints a clean success", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, ".metaproject", "data", "gdctx", "raw"), { recursive: true });
    const priorExitCode = process.exitCode;
    process.exitCode = undefined as number | undefined;

    const { logs, restore } = captureLogs();
    try {
      await retentionCommand(["sweep", "--json"], {
        cwd,
        fsDeps: {
          readdir: async (dir: string) => {
            if (dir.endsWith(path.join("gdctx", "artifacts"))) {
              const error = new Error("denied") as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }
            const real = await import("node:fs/promises");
            return real.readdir(dir);
          },
          statEntry: async (entryPath: string, unit: "file" | "directory") => {
            const real = await import("node:fs/promises");
            const info = await real.stat(entryPath);
            return { bytes: unit === "file" ? info.size : 0, mtimeMs: info.mtimeMs };
          },
          remove: async (entryPath: string, unit: "file" | "directory") => {
            const real = await import("node:fs/promises");
            await real.rm(entryPath, { recursive: unit === "directory" });
          },
        },
      });
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    process.exitCode = priorExitCode;
    const report = JSON.parse(logs.join("\n")) as { status: string };
    expect(report.status).toBe("incomplete");
  });

  test("bare `retention` with no subcommand prints help and does not error", async () => {
    const cwd = await project();
    // Bun's `process.exitCode` setter cannot be reset to `undefined` once any
    // earlier test in this process set it to a number (a Bun runtime quirk,
    // not a claim about this command) — `0` is the neutral baseline that
    // reliably round-trips, so use it instead of relying on `undefined`.
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    const { logs, restore } = captureLogs();
    try {
      await retentionCommand([], { cwd });
    } finally {
      restore();
    }
    expect(logs.join("\n")).toContain("retention");
    expect(process.exitCode).toBe(0);
    process.exitCode = priorExitCode;
  });

  test("an unknown subcommand errors and exits 1", async () => {
    const cwd = await project();
    const priorExitCode = process.exitCode;
    process.exitCode = undefined as number | undefined;
    const { restore } = captureLogs();
    try {
      await retentionCommand(["bogus"], { cwd });
    } finally {
      restore();
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = priorExitCode;
  });
});
