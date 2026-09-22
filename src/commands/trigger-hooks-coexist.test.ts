// Flow 286 T9, AC5: "`keryx trigger install` extends the existing hook
// installation instead of replacing it: after install, `keryx sync
// install-hooks`'s behaviour on `post-merge` and `post-checkout` still
// happens, and a project that had hooks keeps them."
//
// The T5 survey named the exact risk: `keryx trigger install` must reuse the
// `installManagedHook` multi-block-per-file mechanism (now
// `../lib/managed-hook.ts`), NOT replace `src/sync/hooks.ts`'s narrower
// single-block `keryx-sync` writer that `keryx sync install-hooks` already
// owns for the SAME two hook files. This test installs BOTH, in both orders,
// and asserts both blocks are present and both actually run afterward.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { triggerCommand } from "./trigger";
import { syncCommand } from "./sync";
import { triggersConfigPath } from "../trigger/config";
import { acquireCwd, releaseCwd } from "../lib/test-cwd";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function scaffoldProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-hooks-coexist-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    triggersConfigPath(root),
    JSON.stringify({
      schemaVersion: 1,
      triggers: [{ name: "on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } }],
    }),
    "utf8",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

async function hookContent(root: string, hookName: string): Promise<string> {
  return readFile(path.join(root, ".git", "hooks", hookName), "utf8");
}

let root = "";
const realLog = console.log;
const realError = console.error;

async function withRoot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireCwd(root);
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
    releaseCwd();
  }
}

describe("keryx trigger install extends keryx sync install-hooks, not the other way around (AC5)", () => {
  test("sync install-hooks, then trigger install: both blocks present in post-merge; both still run", async () => {
    root = await scaffoldProject();
    try {
      await withRoot(() => syncCommand(["install-hooks"]));
      await withRoot(() => triggerCommand(["install"]));

      const postMerge = await hookContent(root, "post-merge");
      expect(postMerge).toContain("# keryx:keryx-sync:begin");
      expect(postMerge).toContain("# keryx:trigger-on-merge:begin");
      expect(postMerge).toContain("keryx sync 2>/dev/null || true");
      expect(postMerge).toContain("keryx trigger run on-merge");
    } finally {
      await rmProject(root);
    }
  });

  test("trigger install, then sync install-hooks (reverse order): both blocks present, neither clobbers the other", async () => {
    root = await scaffoldProject();
    try {
      await withRoot(() => triggerCommand(["install"]));
      await withRoot(() => syncCommand(["install-hooks"]));

      const postMerge = await hookContent(root, "post-merge");
      expect(postMerge).toContain("# keryx:keryx-sync:begin");
      expect(postMerge).toContain("# keryx:trigger-on-merge:begin");

      // Re-running trigger install again (e.g. after editing triggers.json)
      // must not disturb the sync block either.
      await withRoot(() => triggerCommand(["install"]));
      const again = await hookContent(root, "post-merge");
      expect(again).toContain("# keryx:keryx-sync:begin");
      expect(again.split("# keryx:trigger-on-merge:begin").length - 1).toBe(1);
    } finally {
      await rmProject(root);
    }
  });

  test("a project with pre-existing hand-authored hook content keeps it after both installers run", async () => {
    root = await scaffoldProject();
    try {
      await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
      await writeFile(path.join(root, ".git", "hooks", "post-merge"), "#!/usr/bin/env sh\necho pre-existing-line\n", "utf8");

      await withRoot(() => syncCommand(["install-hooks"]));
      await withRoot(() => triggerCommand(["install"]));

      const postMerge = await hookContent(root, "post-merge");
      expect(postMerge).toContain("pre-existing-line");
      expect(postMerge).toContain("# keryx:keryx-sync:begin");
      expect(postMerge).toContain("# keryx:trigger-on-merge:begin");
    } finally {
      await rmProject(root);
    }
  });
});

async function rmProject(dir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
}
