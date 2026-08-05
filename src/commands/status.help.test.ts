// `keryx status --help` prints help instead of running (#243).
//
// The dispatch table dropped the argument list, so `--help` reached nothing and
// the report ran. Harmless for a read-only command; the reason to fix it is the
// reflex it teaches for commands that are not read-only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { statusCommand } from "./status";

let base = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalCwd = "";

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "keryx-status-help-"));
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

describe("keryx status", () => {
  test("--help prints usage and does not run the report", async () => {
    await statusCommand(["--help"]);

    const text = captured.join("\n");
    expect(text).toContain("Usage:");
    expect(text).toContain("keryx status");
    expect(text).not.toContain("Metaproject:");
  });

  test("-h is the same door", async () => {
    await statusCommand(["-h"]);

    expect(captured.join("\n")).toContain("Usage:");
  });

  test("no arguments still runs the report", async () => {
    await statusCommand();

    // An uninitialized directory: the report says so rather than printing help.
    expect(captured.join("\n")).toContain("Metaproject: not initialized");
  });
});
