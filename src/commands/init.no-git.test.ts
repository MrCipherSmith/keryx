// `keryx init` in a directory that is not a git repository (#242).
//
// `installManagedHook` returns early when there is no hooks root, but the
// summary rendered its lines from the intent flags, so every git hook read as
// installed while nothing had been written and nothing would ever fire. A user
// who runs `keryx init` before `git init` was told the opposite of the truth.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initCommand } from "./init";

let base = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalCwd = "";
let originalXdg: string | undefined;

function output(): string {
  // Strip SGR so assertions match on text, not on styling.
  return captured.join("\n").replace(/\[[0-9;]*m/g, "");
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "keryx-init-nogit-"));
  originalCwd = process.cwd();
  originalXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(base, "config");
  process.chdir(base);

  captured = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.chdir(originalCwd);
  if (originalXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdg;
  }
  rmSync(base, { recursive: true, force: true });
});

describe("keryx init without a git repository", () => {
  test("does not claim git hooks were installed", async () => {
    await initCommand(["--yes"]);

    // Not vacuous: the workspace itself must have been created.
    expect(existsSync(path.join(base, ".metaproject"))).toBe(true);
    expect(existsSync(path.join(base, ".git"))).toBe(false);

    const text = output();
    expect(text).toContain("Git hooks");
    expect(text).toContain("skipped - not a git repository");
    // The success marker must not appear on any git hook row.
    for (const line of text.split("\n")) {
      if (line.includes("post-commit") || line.includes("pre-push")) {
        expect(line).toContain("skipped - not a git repository");
      }
    }
  }, 120_000);

  test("says how to get them installed", async () => {
    await initCommand(["--yes"]);

    expect(output()).toContain("git init");
  }, 120_000);
});
