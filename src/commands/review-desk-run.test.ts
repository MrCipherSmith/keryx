import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { privateGitEnv } from "../review/autonomous-run";
import { DeskRunStore } from "../review/desk-run-store";
import type { DeskRunSnapshot } from "../review/desk-run-types";

const base = "a".repeat(40),
  head = "b".repeat(40);
const cli = path.resolve(import.meta.dir, "../cli.ts");

// A worker may publish the marker or SQLite commit before the observer subscribes.
// Subscribe first, inspect immediately, then re-read only on filesystem notifications.
async function waitForChange(directory: string, ready: () => boolean, description: string) {
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(directory, check);
    const timeout = setTimeout(() => done(new Error("Timed out waiting for " + description)), 15_000);
    function done(error?: Error) {
      clearTimeout(timeout);
      watcher.close();
      if (error) reject(error); else resolve();
    }
    function check() {
      try { if (ready()) done(); }
      catch (error) { done(error as Error); }
    }
    watcher.once("error", done);
    check();
  });
}

test("two linked worktrees attach to one worker and can cancel while its revision is being verified", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-desk-cli-"));
  const project = path.join(root, "project"),
    worktree = path.join(root, "linked"),
    bin = path.join(root, "bin");
  const gate = path.join(root, "continue");
  mkdirSync(project);
  mkdirSync(bin);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: project,
      stdio: "ignore",
    });
  git("init", "-q");
  git(
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=fixture",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  git("remote", "add", "origin", "https://github.com/fixture/repo.git");
  git("worktree", "add", "-q", "--detach", worktree);
  // Call 1 validates the card. Hold the worker's re-check until a different
  // checkout has attached and cancelled it. Nothing reaches GitHub or a provider.
  const gh = path.join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
if mkdir "$FIXTURE/once" 2>/dev/null; then
  :
elif mkdir "$FIXTURE/checking" 2>/dev/null; then
  i=0
  while [ ! -f "$FIXTURE/continue" ]; do
    if [ "$i" -ge 240 ]; then touch "$FIXTURE/timed-out"; exit 75; fi
    sleep 0.05; i=$((i+1))
  done
fi
echo '{"data":{"viewer":{"login":"viewer"},"repository":{"id":"node","pullRequest":{"state":"OPEN","baseRefOid":"${base}","headRefOid":"${head}"}}}}'
`,
  );
  chmodSync(gh, 0o700);
  const common = [
    "--json",
    "--repo",
    "fixture/repo",
    "--viewer",
    "viewer",
    "--repository-id",
    "node",
    "--number",
    "7",
  ];
  async function call(cwd: string, action: string, extra: string[] = [], commonArgs = common) {
    const proc = Bun.spawn([process.execPath, cli, "review", "desk-run", action, ...commonArgs, ...extra], {
      cwd,
      env: {
        HOME: root,
        APPDATA: root,
        XDG_DATA_HOME: root,
        GIT_ALLOW_PROTOCOL: "file",
        FIXTURE: root,
        KERYX_DATA_DIR: path.join(root, "data"),
        PATH: bin + path.delimiter + process.env.PATH,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exit !== 0) throw new Error(stderr);
    return JSON.parse(stdout) as DeskRunSnapshot;
  }
  try {
    const first = await call(project, "start", ["--base", base, "--head", head]);
    expect(first.runs[0]!.scope).toBe("review-autonomous/fixed-pr/v2");
    const id = first.runs[0]!.id;
    await waitForChange(root, () => existsSync(path.join(root, "checking")), "the worker to enter revision verification");
    const second = await call(worktree, "start", ["--base", base, "--head", head]);
    expect(second.runs.map((r) => r.id)).toEqual([id]);
    expect((await call(worktree, "cancel", ["--id", id])).runs[0]!.state).toBe("cancelling");
    const storePath = path.join(root, "data", "desktop-review");
    const store = new DeskRunStore(storePath, true);
    try {
      writeFileSync(gate, "");
      await waitForChange(storePath, () => store.byId(id)?.run.state === "cancelled", "the worker's terminal commit");
    } finally {
      store.close();
    }
    expect(existsSync(path.join(root, "timed-out"))).toBe(false);
    const state = await call(project, "status");
    expect((await call(project, "status", ["--activity-id", id])).runs.map(run => run.id)).toEqual([id]);
    await expect(call(project, "status", ["--id", id, "--activity-id", id])).rejects.toThrow("desk-run");
    expect(state.runs[0]?.state).toBe("cancelled");
    expect(state.runs[0]?.reason).toContain("cancel");
    await expect(call(project, "start", ["--base", base, "--head", "f".repeat(40)])).rejects.toThrow("stale:");
    await expect(
      call(
        project,
        "status",
        [],
        common.map((s) => (s === "viewer" ? "other" : s)),
      ),
    ).rejects.toThrow("access:");
  } finally {
    writeFileSync(gate, "");
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.platform === "win32")("a delayed GitHub response in one window cannot displace a newer queued revision", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-desk-admission-"));
  const bin = path.join(root, "bin"), project = path.join(root, "project");
  const data = path.join(root, "data"), gate = path.join(root, "release");
  const key = { repo: "fixture/repo", repositoryId: "node", viewer: "viewer", number: 7 };
  const oldHead = "c".repeat(40), newHead = "d".repeat(40);
  mkdirSync(project);
  mkdirSync(bin);
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: project, env: { ...privateGitEnv(), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore",
  });
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/fixture/repo.git");
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh
if [ "$WAIT_FOR_NEWER" = "1" ]; then
  : > "$FIXTURE/waiting"
  n=0
  until [ -f "$FIXTURE/release" ]; do
    if [ "$n" -ge 240 ]; then exit 75; fi
    sleep 0.05
    n=$((n+1))
  done
fi
printf '{"data":{"viewer":{"login":"viewer"},"repository":{"id":"node","pullRequest":{"state":"OPEN","baseRefOid":"${base}","headRefOid":"%s"}}}}\\n' "$FIXTURE_HEAD"
`, { mode: 0o700 });
  const store = new DeskRunStore(path.join(data, "desktop-review"));
  async function startWindow(revision: string, waits: boolean) {
    const child = Bun.spawn([
      process.execPath, ...SAFE_BUN_SPAWN_ARGS, cli, "review", "desk-run", "start", "--json", "--repo", key.repo,
      "--viewer", key.viewer, "--repository-id", key.repositoryId, "--number", "7", "--base", base, "--head", revision,
    ], { cwd: project, env: {
      HOME: root, XDG_DATA_HOME: root, KERYX_DATA_DIR: data, FIXTURE: root, FIXTURE_HEAD: revision,
      WAIT_FOR_NEWER: waits ? "1" : "0", PATH: bin + path.delimiter + process.env.PATH,
    }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, exit };
  }
  let first: ReturnType<typeof startWindow> | undefined;
  try {
    // Occupy the execution slot without launching a provider.
    store.request(project, key, { baseSha: base, headSha: head });
    const active = store.queued(key)!;
    active.pid = process.pid;
    active.run.state = "running";
    store.save(active);
    first = startWindow(oldHead, true);
    await waitForChange(root, () => existsSync(path.join(root, "waiting")), "the older window to validate");
    const newer = await startWindow(newHead, false);
    expect(newer.exit, newer.stderr).toBe(0);
    const admitted = store.queued(key)!;
    expect(admitted.run.headSha).toBe(newHead);
    writeFileSync(gate, "");
    const older = await first;
    expect(older.exit).not.toBe(0);
    expect(older.stderr).toContain("Another review was requested during validation");
    expect(store.queued(key)?.run.id).toBe(admitted.run.id);
  } finally {
    writeFileSync(gate, "");
    await first;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
