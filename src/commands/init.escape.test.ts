// Terminal-escape containment for `keryx init` (flow 127).
//
// The init banner prints the project directory's basename, and this branch newly
// makes init a registry entry point, so a directory name carrying ANSI escapes
// reaches the operator's terminal through it.
//
// It lives in its own file rather than in projects.escape.test.ts because these
// are `keryx init`'s output paths, not `keryx projects`' — the previous coverage
// claim was wrong partly because it counted sites it never reached.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initCommand } from "./init";

const ESC = "";
const BEL = "";
const HOSTILE = `${ESC}]0;PWNED${BEL}${ESC}[2J`;

let base = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalCwd = "";
let originalXdg: string | undefined;

function controlCharacters(text: string): string[] {
  return [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "keryx-init-escape-"));
  originalCwd = process.cwd();
  originalXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(base, "config");

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

describe("keryx init emits no terminal control characters", () => {
  test("the banner, from a hostile directory name", async () => {
    const hostile = path.join(base, `proj${HOSTILE}ect`);
    mkdirSync(hostile, { recursive: true });
    process.chdir(hostile);

    await initCommand(["--yes"]);

    const output = captured.join("\n").replace(/\n/g, "");
    // Not vacuous: the banner must actually have been printed.
    expect(captured.join("")).toContain("workspace in");
    expect(controlCharacters(output)).toEqual([]);
  }, 120_000);

  test("the update banner, on a second init in the same directory", async () => {
    const hostile = path.join(base, `re${HOSTILE}init`);
    mkdirSync(hostile, { recursive: true });
    process.chdir(hostile);

    await initCommand(["--yes"]);
    captured = [];
    await initCommand(["--yes"]);

    const output = captured.join("\n").replace(/\n/g, "");
    expect(captured.join("")).toContain("workspace in");
    expect(controlCharacters(output)).toEqual([]);
  }, 120_000);
});
