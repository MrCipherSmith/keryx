import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseShellCliFlags, shellCommand } from "./shell";

describe("Shell CLI validation before startup", () => {
  for (const arg of ["--help", "-h"]) {
    test(`${arg} never starts version lookup or a shell surface`, async () => {
      const events: string[] = [];
      await shellCommand([arg], {
        isTty: true,
        checkVersion: async () => {
          events.push("version");
          return { status: "up-to-date", currentVersion: "test", latestVersion: "test", source: "cache" };
        },
        launchAgent: async () => { events.push("agent"); return true; },
        launchChat: async () => { events.push("chat"); return true; },
      });
      expect(events).toEqual([]);
    });
  }

  for (const args of [
    ["--provder", "fixture"], ["unexpected"],
    ["--provider"], ["--model"], ["--base-url"], ["--permission-mode"],
    ["--provider", "--chat"], ["--model", ""],
    ["--permission-mode", "yolo"],
    ["--continue", "--resume", "session"], ["-r", "-c"],
    ["--agent", "--chat"],
  ]) {
    test(`rejects ${JSON.stringify(args)} with usage advice before startup`, async () => {
      expect(() => parseShellCliFlags(args)).toThrow(/keryx shell --help/);
      let started = false;
      await expect(shellCommand(args, {
        isTty: true,
        checkVersion: async () => {
          started = true;
          return { status: "up-to-date", currentVersion: "test", latestVersion: "test", source: "cache" };
        },
        launchAgent: async () => { started = true; return true; },
        launchChat: async () => { started = true; return true; },
      })).rejects.toThrow(/keryx shell --help/);
      expect(started).toBe(false);
    });
  }

  test("preserves optional resume picker and documented alias precedence", () => {
    expect(parseShellCliFlags(["-r", "--no-tui"])).toMatchObject({ resumePick: true, wantTui: false });
    expect(parseShellCliFlags(["--no-tui", "--tui", "--trust", "--auto"])).toMatchObject({ wantTui: true, permissionModeFlag: "auto" });
    expect(parseShellCliFlags(["--chat", "--ask"])).toMatchObject({ modeFlag: false, permissionModeFlag: "ask" });
  });
});

test("actual CLI help and errors exit without credentials or Keryx file writes", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-shell-cli-"));
  try {
    for (const [args, exitCode] of [
      [["--help"], 0], [["-h"], 0], [["--provder", "fixture"], 1], [["--provider"], 1],
    ] as const) {
      const result = spawnSync(process.execPath, [path.resolve(import.meta.dir, "../cli.ts"), "shell", ...args], {
        cwd, encoding: "utf8", timeout: 10_000, input: "",
        env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", XDG_CONFIG_HOME: path.join(cwd, "config"), XDG_CACHE_HOME: path.join(cwd, "cache") },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exitCode);
      expect(result.stdout + result.stderr).toContain(exitCode === 0 ? "Usage: keryx shell" : "keryx shell --help");
      // Source execution can populate Bun's own transpiler cache. It is not
      // Keryx configuration/session state and is absent from compiled builds.
      const entries = readdirSync(cwd, { recursive: true }).map(String);
      expect(entries.filter((entry) => entry !== "cache" && entry !== path.join("cache", "bun") && !entry.startsWith(`cache${path.sep}bun${path.sep}`))).toEqual([]);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
