import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeskRunSnapshot } from "../review/desk-run-types";

const base = "a".repeat(40),
  head = "b".repeat(40);
const cli = path.resolve(import.meta.dir, "../cli.ts");

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
  while [ ! -f "$FIXTURE/continue" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done
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
        ...process.env,
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
    const id = first.runs[0]!.id;
    for (let i = 0; i < 200 && !existsSync(path.join(root, "checking")); i++) await Bun.sleep(25);
    expect(existsSync(path.join(root, "checking"))).toBe(true);
    const second = await call(worktree, "start", ["--base", base, "--head", head]);
    expect(second.runs.map((r) => r.id)).toEqual([id]);
    expect((await call(worktree, "cancel", ["--id", id])).runs[0]!.state).toBe("cancelling");
    writeFileSync(gate, "");
    let state = await call(project, "status");
    for (let i = 0; i < 12 && state.runs[0]?.state !== "cancelled"; i++) {
      await Bun.sleep(50);
      state = await call(project, "status");
    }
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
