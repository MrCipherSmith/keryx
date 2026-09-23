// Flow 303 (AC8): the first-run `/help` marker persists in the per-user
// keryx config dir, hermetically — each test gets its OWN temp dir (never
// the shared preload-redirected root; two tests in one process must not see
// each other's marker).

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { helpFirstRunShown, markHelpFirstRunShown, resolveFirstRunHelp, shouldOpenFirstRunHelp } from "./help-first-run";

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

// PR #669 review, HIGH 1: the marker used to be written only on the branch
// that opened the modal, so a first run WITH a provider already connected
// was never marked and re-ran the (slow, network) probe on every later
// launch, forever. `resolveFirstRunHelp` folds the decision, the probe and
// the marker write into one function so that bug is structurally impossible
// to reintroduce — these three cases are exactly the ones the fix names.
describe("resolveFirstRunHelp (AC8, HIGH 1 fix)", () => {
  test("first run, no provider connected -> opens the modal AND marks", async () => {
    const marked: number[] = [];
    const tab = await resolveFirstRunHelp({
      shown: false,
      probe: async () => 0,
      mark: () => marked.push(1),
    });
    expect(tab).toBe("connect");
    expect(marked).toEqual([1]);
  });

  test("first run, a provider IS already connected -> does NOT open, but still marks", async () => {
    const marked: number[] = [];
    const tab = await resolveFirstRunHelp({
      shown: false,
      probe: async () => 1,
      mark: () => marked.push(1),
    });
    expect(tab).toBeUndefined();
    // The exact bug this replaces: this must not be empty.
    expect(marked).toEqual([1]);
  });

  test("a later run (already shown) -> the probe is never called, and nothing is re-marked", async () => {
    let probeCalls = 0;
    let markCalls = 0;
    const tab = await resolveFirstRunHelp({
      shown: true,
      probe: async () => {
        probeCalls += 1;
        return 0;
      },
      mark: () => {
        markCalls += 1;
      },
    });
    expect(tab).toBeUndefined();
    expect(probeCalls).toBe(0);
    expect(markCalls).toBe(0);
  });

  test("a slow probe does not stop resolveFirstRunHelp from eventually resolving and marking", async () => {
    let resolveProbe: ((n: number) => void) | undefined;
    const slowProbe = new Promise<number>((resolve) => {
      resolveProbe = resolve;
    });
    const marked: number[] = [];
    const pending = resolveFirstRunHelp({
      shown: false,
      probe: () => slowProbe,
      mark: () => marked.push(1),
    });
    // Nothing marked yet — the probe genuinely has not resolved.
    await Promise.resolve();
    expect(marked).toEqual([]);

    resolveProbe?.(0);
    const tab = await pending;
    expect(tab).toBe("connect");
    expect(marked).toEqual([1]);
  });

  test("the shell dispatches it as a background task, never awaited inline in the startup sequence", () => {
    // Structural guard against reintroducing the HIGH 1 bug: an `await` here
    // would once again let a ~10s-per-provider probe delay every later step
    // of startup. `void resolveFirstRunHelp({...}).then(...)` is the
    // non-blocking shape; a literal `await resolveFirstRunHelp(` is the
    // regression.
    const source = readFileSync(new URL("./tui-shell.ts", import.meta.url), "utf8");
    expect(source).toContain("void resolveFirstRunHelp({");
    expect(source).not.toContain("await resolveFirstRunHelp(");
  });
});
