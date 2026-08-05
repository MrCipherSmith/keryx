// `--dry-run` on the orientation hook installer (#241).
//
// The flag was accepted by the shell and parsed by nobody: `install-hook
// --dry-run` wrote the runtime settings file anyway. These tests assert the
// property that matters — after a dry run the filesystem is byte-identical —
// rather than asserting on the wording of the report, which is free to change.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { orientCommand } from "./orient";

let base = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalCwd = "";

// `.claude/settings.json` is where the claude runtime's hook lands.
const CLAUDE_SETTINGS = path.join(".claude", "settings.json");

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "keryx-orient-dry-"));
  originalCwd = process.cwd();
  process.chdir(base);
  captured = [];
  originalLog = console.log;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  process.chdir(originalCwd);
  rmSync(base, { recursive: true, force: true });
});

describe("keryx orient install-hook --dry-run", () => {
  test("writes nothing when the settings file does not exist yet", async () => {
    await orientCommand(["install-hook", "--runtime", "claude", "--dry-run"]);

    expect(existsSync(path.join(base, CLAUDE_SETTINGS))).toBe(false);
    // Not vacuous: it must still report what it would have done.
    expect(captured.join("\n")).toContain("would write");
  });

  test("leaves an existing settings file byte-identical", async () => {
    await orientCommand(["install-hook", "--runtime", "claude"]);
    const settings = path.join(base, CLAUDE_SETTINGS);
    const installed = readFileSync(settings, "utf8");
    expect(installed).not.toBe("");

    captured = [];
    await orientCommand(["install-hook", "--runtime", "claude", "--dry-run"]);

    expect(readFileSync(settings, "utf8")).toBe(installed);
  });

  test("a real install still writes", async () => {
    await orientCommand(["install-hook", "--runtime", "claude"]);

    expect(existsSync(path.join(base, CLAUDE_SETTINGS))).toBe(true);
  });
});

describe("keryx orient uninstall-hook --dry-run", () => {
  test("leaves an installed hook in place", async () => {
    await orientCommand(["install-hook", "--runtime", "claude"]);
    const settings = path.join(base, CLAUDE_SETTINGS);
    const installed = readFileSync(settings, "utf8");

    captured = [];
    await orientCommand(["uninstall-hook", "--runtime", "claude", "--dry-run"]);

    expect(readFileSync(settings, "utf8")).toBe(installed);
    expect(captured.join("\n")).toContain("would strip");
  });

  test("reports nothing to remove when the file is absent", async () => {
    await orientCommand(["uninstall-hook", "--runtime", "claude", "--dry-run"]);

    expect(captured.join("\n")).toContain("nothing to remove");
    expect(existsSync(path.join(base, CLAUDE_SETTINGS))).toBe(false);
  });
});
