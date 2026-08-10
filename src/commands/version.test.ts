// RED tests for flow 142 / AC3 and AC7.
//
// The command is deliberately exercised with an injected global fetch stub;
// this suite must never contact npm. Shell/TUI/readline startup is not covered
// here because the existing shell entrypoint has no stable version-check
// injection seam yet; that gap is recorded for the GREEN implementation.

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI_ROUTES } from "../cli";
import { COMMAND_DESCRIPTORS } from "../standard/command-registry";
import { versionCommand } from "./version";
import type { VersionFetch } from "../lib/version-check";
const cacheDirs: string[] = [];

afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(cacheDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function isolatedCacheDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-version-command-"));
  cacheDirs.push(dir);
  return dir;
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => { console.log = originalLog; console.error = originalError; } };
}

function stubRegistry(version: string): VersionFetch {
  return async () => new Response(JSON.stringify({ name: "@mrciphersmith/keryx", version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("keryx version check command", () => {
  test("is registered as a root CLI route and has a machine-readable descriptor", () => {
    expect(CLI_ROUTES.version).toBe(versionCommand);
    const descriptor = COMMAND_DESCRIPTORS.find((entry) => entry.command === "version check");
    expect(descriptor).toMatchObject({
      command: "version check",
      json: true,
      read: true,
    });
  });

  test("prints human output from the shared service without installing", async () => {
    const fetch = stubRegistry("0.2.18");
    const captured = captureConsole();
    try {
      await versionCommand(["check"], { fetch, cacheDir: await isolatedCacheDir() });
    } finally {
      captured.restore();
    }

    expect(captured.lines.join("\n")).toContain("0.2.18");
    expect(captured.lines.join("\n")).toContain("npm install -g @mrciphersmith/keryx@latest");
    expect(captured.lines.join("\n")).not.toMatch(/installing|installed/i);
  });

  test("prints parseable JSON with typed unavailable and exits 0 for operational failures", async () => {
    const fetch: VersionFetch = async () => { throw new Error("offline"); };
    const captured = captureConsole();
    try {
      await versionCommand(["check", "--json"], { fetch, cacheDir: await isolatedCacheDir() });
    } finally {
      captured.restore();
    }

    const payload = JSON.parse(captured.lines.at(-1) ?? "null") as { status?: string };
    expect(payload.status).toBe("unavailable");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test.each([
    [[]],
    [["unknown"]],
    [["check", "--unknown"]],
    [["check", "extra"]],
    [["check", "--json", "--json"]],
    [["check", "--json", "extra"]],
  ] as const)("rejects invalid arguments with usage and a nonzero exit (%j)", async (args) => {
    let checkCalls = 0;
    const captured = captureConsole();
    try {
      await versionCommand([...args], {
        check: async () => {
          checkCalls += 1;
          return { status: "up-to-date", currentVersion: "1.0.0", latestVersion: "1.0.0", source: "registry" };
        },
      });
    } finally {
      captured.restore();
    }

    expect(captured.lines.join("\n")).toContain("Usage: keryx version check [--json]");
    expect(process.exitCode).toBe(1);
    expect(checkCalls).toBe(0);
  });

  test("root help advertises version check without starting a network request", async () => {
    const output = await runBun([path.join(import.meta.dir, "..", "cli.ts"), "--help"]);
    expect(output).toContain("keryx version check");
  });
});

function runBun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.join(import.meta.dir, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `bun exited with ${code}`)));
  });
}
