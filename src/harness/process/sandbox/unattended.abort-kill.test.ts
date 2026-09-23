// Flow 301 (F5b, security review): a REAL bwrap integration test proving an
// unattended run's abort actually kills an in-flight `shell_exec`'s sandboxed
// process tree — not just the model turn loop. Before this fix, `maxSeconds`
// expiring while a command was running changed nothing: the bwrap/sh process kept
// going, orphaned, after the dispatcher closed its proxy and deleted its scratch
// directory, until the command's OWN 120s-default deadline eventually caught it.
//
// Skipped wherever a real, working bwrap is not available — mirrors the skip
// condition the other real-sandbox tests in this directory use.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { makeCommandRunner } from "../../tool/builtin/shell-exec-tool";
import { planUnattendedSandbox } from "./unattended";

const projectRoot = process.cwd();

const realSandbox = planUnattendedSandbox({
  worktree: tmpdir(),
  scratchHome: tmpdir(),
  network: false,
  readOnly: [projectRoot],
  env: process.env,
  home: homedir(),
});

/** Every host-wide process whose full command line contains `marker` (best-effort leak check via `ps`, not the namespaced in-sandbox pid). */
function processesMatching(marker: string): string[] {
  const ps = Bun.spawnSync(["ps", "-eo", "pid,ppid,pgid,cmd"], { stdout: "pipe" });
  const text = new TextDecoder().decode(ps.stdout);
  return text
    .split("\n")
    .filter((line) => line.includes(marker) && !line.includes("ps -eo")); // exclude the ps invocation itself
}

describe("F5b: an aborted unattended shell_exec is really killed, not orphaned (real bwrap)", () => {
  let workdir = "";
  let scratchHome = "";

  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
    if (scratchHome) await rm(scratchHome, { recursive: true, force: true });
    workdir = "";
    scratchHome = "";
  });

  test.skipIf(!realSandbox.ok)(
    "aborting ~200ms into a sandboxed `sleep 60` kills it (and any grandchild) within the grace period — none survive, checked by pid/cmdline",
    async () => {
      workdir = await mkdtemp(path.join(tmpdir(), "keryx-abort-kill-work-"));
      scratchHome = await mkdtemp(path.join(tmpdir(), "keryx-abort-kill-home-"));
      const plan = planUnattendedSandbox({
        worktree: workdir,
        scratchHome,
        network: false,
        readOnly: [projectRoot],
        env: process.env,
        home: homedir(),
      });
      if (!plan.ok) throw new Error(`sandbox plan refused: ${plan.reason}`);

      // A unique marker distinguishes THIS test's process tree from any other on a
      // shared host. `ps -eo pid,...,cmd` shows the PID together with the exact
      // command line, so a marker match IS the pid check (`: marker` is the shell
      // no-op builtin — it takes the marker as an argument and spawns nothing, so
      // the marker lands in the wrapped `/bin/sh -c "<this whole string>"`
      // process's own argv, which the host's `ps` sees regardless of the sandbox's
      // mount/pid namespaces). The inner `sleep 60 &` + `wait` gives that shell an
      // actual GRANDCHILD (matching the review's "no grandchild survives" ask) —
      // exactly the shape a real `shell_exec` command like `foo & bar` would have.
      const marker = `keryx-abort-kill-marker-${randomUUID()}`;
      const command = `: ${marker}; sleep 60 & CHILD=$!; wait $CHILD`;

      const run = makeCommandRunner(workdir, async (cmd) => ({
        ok: true,
        plan: { spawnArgs: plan.wrap(["/bin/sh", "-c", cmd]), env: plan.env, netClose: async () => {} },
      }));

      const controller = new AbortController();
      const start = Date.now();
      const resultPromise = run(command, { signal: controller.signal });

      // Confirm the process tree is genuinely running BEFORE aborting — otherwise
      // an empty `ps` result after abort would prove nothing.
      await new Promise((r) => setTimeout(r, 200));
      const runningBeforeAbort = processesMatching(marker);
      expect(runningBeforeAbort.length).toBeGreaterThan(0);

      controller.abort();
      const result = await resultPromise;
      const elapsedMs = Date.now() - start;

      expect(result.isError).toBe(true);
      expect(result.output).toContain("aborted: run time limit");
      // Bounded: the grace period is 2s, plus the 200ms head start: well under the
      // full 60s sleep.
      expect(elapsedMs).toBeLessThan(5_000);

      // The kill already completed (the promise above only resolves after
      // `proc.exited`) — this is confirming, not racing, the teardown.
      const leaked = processesMatching(marker);
      expect(leaked).toEqual([]);
    },
    15_000,
  );
});
