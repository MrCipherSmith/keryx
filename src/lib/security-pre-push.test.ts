import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { renderSecurityPrePushHook } from "./templates";
import { renderTestingPrePushHook } from "../testing/templates";

// ---------------------------------------------------------------------------
// Fix 1: managed pre-push blocks must propagate a non-zero exit immediately so
// a FAILING earlier block (e.g. the testing gate) can never be masked by a
// later PASSING block (e.g. security) when both are appended to one hook.
// ---------------------------------------------------------------------------

test("rendered pre-push blocks end their trailing call with `|| exit $?`", () => {
  expect(renderTestingPrePushHook()).toContain(
    "gd_metapro_testing_pre_push || exit $?",
  );
  expect(renderSecurityPrePushHook()).toContain(
    "gd_metapro_security_pre_push || exit $?",
  );
});

async function runSh(script: string): Promise<number> {
  const dir = await mkdtemp(path.join(tmpdir(), "gd-metapro-prepush-exit-"));
  try {
    const file = path.join(dir, "hook");
    await writeFile(file, script, "utf8");
    await chmod(file, 0o755);
    const proc = Bun.spawnSync({ cmd: ["sh", file], stdout: "pipe", stderr: "pipe" });
    return proc.exitCode ?? -1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a failing earlier block fails the whole hook even when a later block passes", async () => {
  // Mirror how installManagedHook concatenates managed blocks: block A fails
  // (exit 1), block B passes (exit 0). With the `|| exit $?` guard the composed
  // hook must exit non-zero.
  const composedWithGuard = [
    "#!/usr/bin/env sh",
    "block_a() { return 1; }",
    "block_a || exit $?",
    "block_b() { return 0; }",
    "block_b || exit $?",
    "",
  ].join("\n");
  expect(await runSh(composedWithGuard)).not.toBe(0);

  // Control: bare trailing calls (the pre-fix behaviour) silently swallow the
  // earlier failure because the script status is the LAST command's.
  const composedBare = [
    "#!/usr/bin/env sh",
    "block_a() { return 1; }",
    "block_a",
    "block_b() { return 0; }",
    "block_b",
    "",
  ].join("\n");
  expect(await runSh(composedBare)).toBe(0);

  // A passing earlier block must still let a later block run and decide.
  const composedBothPass = [
    "#!/usr/bin/env sh",
    "block_a() { return 0; }",
    "block_a || exit $?",
    "block_b() { return 0; }",
    "block_b || exit $?",
    "",
  ].join("\n");
  expect(await runSh(composedBothPass)).toBe(0);
});

// ---------------------------------------------------------------------------
// Fix 3: the security pre-push hook must read the refs git passes on stdin and
// scan EVERY new commit of a push (not just HEAD), including the new-ref
// (all-zero remote sha) first-push case.
// ---------------------------------------------------------------------------

test("rendered security hook reads stdin and handles the new-ref (zero-sha) case", () => {
  const hook = renderSecurityPrePushHook();
  // Reads the per-ref stdin lines.
  expect(hook).toMatch(/while\s+read\s+-r\s+local_ref\s+local_sha\s+remote_ref\s+remote_sha/);
  // Detects an all-zero sha (new ref / deleted ref) via a POSIX case glob.
  expect(hook).toContain("*[!0]*");
  // New-ref path falls back to the empty tree when there is no remote history.
  expect(hook).toContain("git hash-object -t tree /dev/null");
  // Deduplicates the changed-file list before scanning.
  expect(hook).toContain("sort -u");
  // Preserves the tracked-range heuristic as a fallback when stdin is empty.
  expect(hook).toContain("@{push}");
  // Degrades gracefully on version skew: probes `security status` and skips the
  // gate (rather than blocking every push) when the installed gd-metapro predates
  // the `security` command.
  expect(hook).toContain("security status >/dev/null 2>&1");
});

test("security hook scans every commit of a first push, not just HEAD", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-prepush-scan-"));
  try {
    const git = (args: string[]) =>
      Bun.spawnSync({
        cmd: ["git", ...args],
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

    git(["init", "-q"]);
    // Two commits, each introducing a distinct file. On a first push both must
    // be scanned; the old HEAD-only heuristic would have scanned only file-b.
    await writeFile(path.join(root, "file-a.txt"), "alpha\n", "utf8");
    git(["add", "file-a.txt"]);
    git(["commit", "-q", "-m", "add a"]);
    await writeFile(path.join(root, "file-b.txt"), "beta\n", "utf8");
    git(["add", "file-b.txt"]);
    git(["commit", "-q", "-m", "add b"]);

    const localSha = new TextDecoder()
      .decode(git(["rev-parse", "HEAD"]).stdout)
      .trim();

    // A fake `gd-metapro` on PATH records every file it is asked to scan and
    // exits 0 (advisory), so we can observe the computed changed-file set.
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const scanLog = path.join(root, "scanned.log");
    const fakeCli = [
      "#!/usr/bin/env sh",
      "# args: security scan <file> --source trusted-project",
      `if [ "$1" = "security" ] && [ "$2" = "scan" ]; then`,
      `  printf '%s\\n' "$3" >> "${scanLog}"`,
      "fi",
      "exit 0",
      "",
    ].join("\n");
    const fakePath = path.join(binDir, "gd-metapro");
    await writeFile(fakePath, fakeCli, "utf8");
    await chmod(fakePath, 0o755);

    const hookPath = path.join(root, "run-hook");
    await writeFile(hookPath, `#!/usr/bin/env sh\n${renderSecurityPrePushHook()}`, "utf8");
    await chmod(hookPath, 0o755);

    const zero = "0".repeat(40);
    const proc = Bun.spawnSync({
      cmd: ["sh", hookPath],
      cwd: root,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdin: new TextEncoder().encode(
        `refs/heads/main ${localSha} refs/heads/main ${zero}\n`,
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Advisory: the hook allows the push.
    expect(proc.exitCode).toBe(0);

    const scanned = await Bun.file(scanLog).text().catch(() => "");
    expect(scanned).toContain("file-a.txt");
    expect(scanned).toContain("file-b.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
