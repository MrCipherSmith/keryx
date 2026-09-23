// Flow 303 (AC8): the first-run `/help` marker persists in the per-user
// keryx config dir, hermetically — each test gets its OWN temp dir (never
// the shared preload-redirected root; two tests in one process must not see
// each other's marker).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { helpFirstRunShown, markHelpFirstRunShown, shouldOpenFirstRunHelp } from "./help-first-run";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-help-first-run-"));
  roots.push(dir);
  return dir;
}

describe("AC8: first-run help marker", () => {
  test("not shown by default (no marker file yet)", async () => {
    const dir = await tempDir();
    expect(helpFirstRunShown(dir)).toBe(false);
  });

  test("shown after marking, and stays shown", async () => {
    const dir = await tempDir();
    markHelpFirstRunShown(dir);
    expect(helpFirstRunShown(dir)).toBe(true);
    // Idempotent: marking twice is still "shown", never an error.
    markHelpFirstRunShown(dir);
    expect(helpFirstRunShown(dir)).toBe(true);
  });

  test("two isolated config dirs do not see each other's marker", async () => {
    const a = await tempDir();
    const b = await tempDir();
    markHelpFirstRunShown(a);
    expect(helpFirstRunShown(a)).toBe(true);
    expect(helpFirstRunShown(b)).toBe(false);
  });

  test("shouldOpenFirstRunHelp: not shown yet, no provider connected -> opens (AC8, case 1)", () => {
    expect(shouldOpenFirstRunHelp(false, 0)).toBe(true);
  });

  test("shouldOpenFirstRunHelp: not shown yet, but a provider IS connected -> does not open", () => {
    expect(shouldOpenFirstRunHelp(false, 1)).toBe(false);
    expect(shouldOpenFirstRunHelp(false, 3)).toBe(false);
  });

  test("shouldOpenFirstRunHelp: already shown, no provider connected -> never again (AC8, case 2)", () => {
    expect(shouldOpenFirstRunHelp(true, 0)).toBe(false);
  });

  test("shouldOpenFirstRunHelp: already shown AND a provider connected -> still never again", () => {
    expect(shouldOpenFirstRunHelp(true, 1)).toBe(false);
  });

  test("a corrupt marker file is treated as not-shown, not as an error", async () => {
    const dir = await tempDir();
    markHelpFirstRunShown(dir);
    expect(helpFirstRunShown(dir)).toBe(true);
    const { writeFileSync } = await import("node:fs");
    const { keryxConfigDir } = await import("../lib/config-dir");
    writeFileSync(path.join(keryxConfigDir(dir), "help-first-run.json"), "not json", "utf8");
    expect(helpFirstRunShown(dir)).toBe(false);
  });
});
