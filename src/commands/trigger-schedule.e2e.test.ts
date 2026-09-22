// Flow 286 T10, AC6: "For a schedule, keryx prints the cron line or the
// systemd timer unit to install and does not run a daemon of its own; the
// printed line is exercised by a test that runs it as the scheduler would."
//
// "As the scheduler would" is specific, not decorative: cron invokes each
// line via `/bin/sh -c '<command>'` with NO controlling TTY and a MINIMAL
// PATH (this test uses `/usr/bin:/bin`, deliberately excluding the
// nvm/bun-managed directory the dev `bun`/`node` used to run this very test
// actually lives in, and excluding wherever a real `keryx` global install
// would be). If the printed command relied on PATH to find `keryx`, or on an
// inherited TTY/environment, it would fail exactly this way and pass any
// looser test. Real subprocess, not a stub of `Bun.spawn`.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function scaffoldProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-schedule-e2e-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "triggers.json"),
    JSON.stringify({
      schemaVersion: 1,
      triggers: [{ name: "nightly-rebuild", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }],
    }),
    "utf8",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

test(
  "AC6: the printed cron command, run by sh -c with no TTY and a minimal PATH, actually performs the pass",
  async () => {
    const root = await scaffoldProject();
    try {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

      // 1. Print the schedule lines exactly as `keryx trigger schedule` would.
      const printProc = Bun.spawn(["bun", CLI, "trigger", "schedule", "nightly-rebuild"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, printExit] = await Promise.all([
        new Response(printProc.stdout).text(),
        new Response(printProc.stderr).text(),
        printProc.exited,
      ]);
      expect(printExit).toBe(0);
      expect(stderr).toBe("");

      const marker = "# cron-command-only: ";
      const line = stdout.split("\n").find((l) => l.startsWith(marker));
      expect(line).toBeDefined();
      const cronCommand = line!.slice(marker.length);

      // The printed command must not depend on PATH to find keryx itself —
      // it bakes in the interpreter that generated it.
      expect(cronCommand).not.toContain("' keryx ");

      // 2. Run EXACTLY that command the way cron would: `/bin/sh -c
      // '<command>'`, no TTY (stdin ignored, stdout/stderr piped rather than
      // inherited from a terminal), and a minimal PATH that excludes the
      // nvm/bun directories this very test process is running from.
      const runProc = Bun.spawn(["/bin/sh", "-c", cronCommand], {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [runOut, runErr, runExit] = await Promise.all([
        new Response(runProc.stdout).text(),
        new Response(runProc.stderr).text(),
        runProc.exited,
      ]);

      if (runExit !== 0) {
        throw new Error(`printed cron command exited ${runExit}\nstdout: ${runOut}\nstderr: ${runErr}`);
      }
      expect(runExit).toBe(0);

      // 3. It actually performed the pass: gdgraph got built, from the
      // fixture's one commit, exactly like the direct `trigger run` e2e test
      // asserts for the SAME action kind.
      const provenance = JSON.parse(
        await readFile(path.join(root, ".metaproject", "data", "gdgraph", ".provenance.json"), "utf8"),
      ) as { commit: string };
      expect(provenance.commit).toBe(commit);

      // 4. Its own output landed in the log file the printed command
      // redirects to (cron would otherwise mail it, or drop it) — not on
      // this process's inherited stdout/stderr, which is exactly what a
      // background cron invocation offers no terminal for.
      const log = await readFile(path.join(root, ".metaproject", "data", "trigger", "nightly-rebuild.schedule.log"), "utf8");
      expect(log.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
