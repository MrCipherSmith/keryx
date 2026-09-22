// Flow 286 T9, AC5: `installTriggerHooks`/`uninstallTriggerHooks`/
// `isTriggerHookInstalled` — the core-zone half of `keryx trigger install` /
// `list`. Coexistence with `keryx sync install-hooks`'s OWN blocks in the
// SAME hook files is proven at the command level, in
// `../commands/trigger-hooks-coexist.test.ts` — this file stays at what this
// module itself owns: which entries get a block, in which hook file, and
// whether one is currently there.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasGitHooksRoot, installTriggerHooks, isTriggerHookInstalled, uninstallTriggerHooks } from "./hooks";
import { loadTriggersConfig, triggersConfigPath } from "./config";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function gitProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-hooks-"));
  git(root, ["init", "-q"]);
  return root;
}

async function writeTriggers(root: string, triggers: unknown[]): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(triggersConfigPath(root), JSON.stringify({ schemaVersion: 1, triggers }), "utf8");
}

describe("installTriggerHooks", () => {
  test("writes one block per EVENT-fired entry, none for schedule or ci", async () => {
    const root = await gitProject();
    await writeTriggers(root, [
      { name: "on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
      { name: "on-commit", on: { kind: "event", event: "post-commit" }, action: { kind: "rebuild" } },
      { name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } },
      { name: "from-ci", on: { kind: "event", event: "ci" }, action: { kind: "reconcile" } },
    ]);

    const results = await installTriggerHooks(root);
    expect(results.map((r) => r.name).sort()).toEqual(["on-commit", "on-merge"]);

    const { triggers } = loadTriggersConfig(root);
    const byName = new Map(triggers.map((t) => [t.name, t]));
    expect(await isTriggerHookInstalled(root, byName.get("on-merge")!)).toBe(true);
    expect(await isTriggerHookInstalled(root, byName.get("on-commit")!)).toBe(true);
    expect(await isTriggerHookInstalled(root, byName.get("nightly")!)).toBe(false);
    expect(await isTriggerHookInstalled(root, byName.get("from-ci")!)).toBe(false);

    const postMerge = await readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");
    expect(postMerge).toContain("# keryx:trigger-on-merge:begin");
    expect(postMerge).toContain("keryx trigger run on-merge");
  });

  test("installs a disabled entry's hook too — `trigger run` refuses it at run time, not the installer", async () => {
    const root = await gitProject();
    await writeTriggers(root, [
      { name: "paused", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" }, enabled: false },
    ]);
    await installTriggerHooks(root);
    const { triggers } = loadTriggersConfig(root);
    expect(await isTriggerHookInstalled(root, triggers[0]!)).toBe(true);
  });

  test("two event-fired entries on the SAME hook file: both blocks coexist", async () => {
    const root = await gitProject();
    await writeTriggers(root, [
      { name: "first", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
      { name: "second", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
    ]);
    await installTriggerHooks(root);
    const content = await readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");
    expect(content).toContain("# keryx:trigger-first:begin");
    expect(content).toContain("# keryx:trigger-second:begin");
  });

  test("re-running install updates the block in place rather than duplicating it", async () => {
    const root = await gitProject();
    await writeTriggers(root, [{ name: "on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } }]);
    await installTriggerHooks(root);
    await installTriggerHooks(root);
    const content = await readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");
    expect(content.split("# keryx:trigger-on-merge:begin").length - 1).toBe(1);
  });

  test("no .git directory: hasGitHooksRoot is false, install writes nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-hooks-nogit-"));
    await writeTriggers(root, [{ name: "on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } }]);
    expect(await hasGitHooksRoot(root)).toBe(false);
    const results = await installTriggerHooks(root);
    expect(results).toEqual([{ name: "on-merge", hook: "post-merge", wrote: false }]);
  });
});

describe("uninstallTriggerHooks", () => {
  test("removes only the trigger blocks, leaving hand-authored content", async () => {
    const root = await gitProject();
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(root, ".git", "hooks", "post-merge"), "#!/usr/bin/env sh\necho hand-authored\n", "utf8");
    await writeTriggers(root, [{ name: "on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } }]);

    await installTriggerHooks(root);
    let content = await readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");
    expect(content).toContain("hand-authored");
    expect(content).toContain("trigger-on-merge");

    await uninstallTriggerHooks(root);
    content = await readFile(path.join(root, ".git", "hooks", "post-merge"), "utf8");
    expect(content).toContain("hand-authored");
    expect(content).not.toContain("trigger-on-merge");
  });
});
