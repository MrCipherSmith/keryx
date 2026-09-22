// Flow 286 T15, review finding 1: `open-flow`'s do-not-duplicate check
// (`skipIfOpen`, AC7) used to run `service.list()` + `findEquivalentOpenFlow()`
// + `service.init()` with no lock at all — a TOCTOU race. Two `trigger run`
// firings close together (two hooks, or a hook plus a CI call) could both see
// "nothing open" and both create a flow with the same title. `../flow/
// service.ts`'s own lock only serializes ID minting, not title uniqueness, so
// it never closed this window.
//
// The fix (`runOpenFlow`, `./trigger.ts`) wraps the whole check-then-create
// sequence in `withTriggerRunLock` — the same project-wide lock AC3 already
// uses for `reconcile`/`rebuild`. This test races two REAL `keryx trigger
// run` processes (not a stub of the lock, mirroring
// `trigger-run.e2e.test.ts`'s established real-process-race pattern — a
// sequential test cannot prove this) and asserts exactly one flow directory
// for the template ever lands on disk, whichever outcome each process gets.
//
// `KERYX_TRIGGER_RUN_HOLD_MS` is the same test seam `trigger-run.e2e.test.ts`
// uses: it stretches how long the winner holds the lock once acquired, so the
// second process's attempt reliably lands while the first still holds it,
// rather than depending on two `bun` process start-up times happening to
// overlap by luck. Before the fix, this seam would not have mattered at all —
// the old code never called `withTriggerRunLock` for `open-flow`, so both
// processes would race the unlocked list-then-create sequence regardless and
// could both create a flow.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const TRIGGER_NAME = "open-nightly-sweep";
const TEMPLATE = "nightly sweep";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function scaffoldProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-open-flow-e2e-"));
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
      triggers: [
        {
          name: TRIGGER_NAME,
          on: { kind: "schedule", cron: "0 3 * * *" },
          action: { kind: "open-flow", template: TEMPLATE, skipIfOpen: true },
        },
      ],
    }),
    "utf8",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runTriggerProcess(root: string, env?: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI, "trigger", "run", TRIGGER_NAME], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

test(
  "review finding 1: two real `keryx trigger run` processes racing an open-flow+skipIfOpen entry never both create a flow",
  async () => {
    const root = await scaffoldProject();
    try {
      // Same stretch mechanism `trigger-run.e2e.test.ts` uses for
      // reconcile/rebuild: hold the lock 1.5s once acquired so the second
      // process's attempt reliably lands while the first still holds it,
      // whichever one wins the initial acquisition race (not asserted below
      // — the invariant is "exactly one opens", either order).
      const first = runTriggerProcess(root, { KERYX_TRIGGER_RUN_HOLD_MS: "1500" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = runTriggerProcess(root);

      const [a, b] = await Promise.all([first, second]);
      const results = [a, b];

      // AC2: both processes exit 0 no matter which outcome each got — a lock
      // refusal or "already open" is a clean "nothing done this pass", never
      // a crash.
      for (const r of results) expect(r.exitCode).toBe(0);

      const opened = results.filter((r) => r.stdout.includes("ok — opened flow"));
      const skipped = results.filter((r) => r.stdout.includes("already open for template"));
      const lockRefused = results.filter((r) => r.stdout.includes("holds this project's trigger lock"));

      // Exactly one process actually opened the flow. The other either saw
      // it already open (serialized after the winner released the lock) or
      // was refused the lock outright (serialized while the winner still
      // held it) — both are correct outcomes of the fix. Two "opened" is the
      // TOCTOU bug this test guards against.
      expect(opened).toHaveLength(1);
      expect(skipped.length + lockRefused.length).toBe(1);

      const flowDirs = (await readdir(path.join(root, ".metaproject", "flows"))).filter((d) =>
        d.includes("nightly-sweep"),
      );
      expect(flowDirs).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
