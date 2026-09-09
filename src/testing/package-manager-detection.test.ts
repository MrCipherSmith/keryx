import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTesting } from "./service";

/**
 * F-240-06 (flow 240 T6): a Bun project must not resolve as npm.
 *
 * `detectPackageManager` checked `bun.lockb` only. Bun 1.2 renamed the lockfile
 * to the text `bun.lock`, so a project on current Bun matched no arm and fell
 * through to the `npm` default — this repository included. It was invisible here
 * because `package.json`'s test script happens to contain the word "bun", which
 * `resolveTestCommand` matches one branch EARLIER (`/\bbun\b/i.test(preferred
 * .command)`), so the broken detection was never consulted. These fixtures use a
 * script that says nothing about any package manager, which is what forces the
 * lockfile path to be the thing under test.
 *
 * Asserted through `runTesting` because `detectPackageManager` and
 * `resolveTestCommand` are module-private; `report.runner` is the observable
 * they decide, and it is the value a user actually feels.
 */

async function scaffold(lockfile: string | null): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-pm-detect-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    // Deliberately free of "bun", "vitest", "jest" and friends: the runner must
    // be chosen from the lockfile, not from a word in the script.
    JSON.stringify({ scripts: { test: "echo no-op" } }),
    "utf8",
  );
  if (lockfile) await writeFile(path.join(root, lockfile), "", "utf8");
  return root;
}

async function runnerFor(lockfile: string | null): Promise<string | null> {
  const root = await scaffold(lockfile);
  try {
    const result = await runTesting({
      cwd: root,
      changed: false,
      since: null,
      scope: null,
      kind: null,
      strict: false,
    });
    return result.report.runner;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("F-240-06: bun.lock (Bun >= 1.2) resolves the bun runner", async () => {
  // Before the fix this was "npm-script": no arm matched `bun.lock`, so
  // detection fell through to the npm default.
  expect(await runnerFor("bun.lock")).toBe("bun-script");
});

test("F-240-06: bun.lockb (Bun < 1.2) still resolves the bun runner", async () => {
  // The old name stays legal: a repository pinned to Bun < 1.2, or one that has
  // not re-run `bun install` since upgrading, still carries it. Fixing the new
  // name by replacing the old one would just move the defect.
  expect(await runnerFor("bun.lockb")).toBe("bun-script");
});

test("F-240-06: a project with no bun lockfile does not claim the bun runner", async () => {
  // Non-vacuity: the two assertions above would also hold if detection returned
  // "bun" unconditionally.
  expect(await runnerFor(null)).not.toBe("bun-script");
});
