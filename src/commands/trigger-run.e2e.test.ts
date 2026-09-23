// Flow 286 T7, AC3: "A second `keryx trigger run` for the same project,
// started while the first is still running, does not corrupt the graph,
// wiki or session store: it either waits for the same lock the interactive
// commands take, or refuses with a clear reason, and a test drives both
// concurrently."
//
// Real `bun` CLI processes, not a stub of the lock (mirrors
// `src/ctx/artifact-race.e2e.test.ts`'s established real-process-race
// pattern for the same reason: `console.log`/`process.exitCode` are globals
// two truly concurrent in-process calls could not be attributed between —
// see `trigger.test.ts` for the sequential, in-process half of this
// command's coverage).
//
// `KERYX_TRIGGER_RUN_HOLD_MS` is the test seam documented in
// `../trigger/run.ts`: it stretches how long the winner of the lock race
// holds it, so the second process's attempt is guaranteed to land while the
// first still holds it, rather than depending on two `bun` process
// start-up times happening to overlap by luck.

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
  const root = await mkdtemp(path.join(tmpdir(), "keryx-trigger-run-e2e-"));
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

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runTriggerProcess(root: string, env?: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI, "trigger", "run", "nightly-rebuild"], {
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
  "AC3: two real `keryx trigger run` processes racing for the project's trigger lock leave the graph intact — one runs, one refuses",
  async () => {
    const root = await scaffoldProject();
    try {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

      // The first process holds the lock for 1.5s once it acquires it — long
      // enough to comfortably outlast the second process's own `bun`
      // start-up, so the second's `mkdir` attempt reliably lands while the
      // first still holds it. Started slightly ahead so it is the one that
      // wins the initial acquisition race (which one wins is not otherwise
      // asserted on below — the invariant is "exactly one runs, exactly one
      // refuses", either order).
      const first = runTriggerProcess(root, { KERYX_TRIGGER_RUN_HOLD_MS: "1500" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = runTriggerProcess(root);

      const [a, b] = await Promise.all([first, second]);
      const results = [a, b];

      const ran = results.filter((r) => r.stdout.includes('ok — "rebuild" completed'));
      const refused = results.filter((r) => r.stdout.includes("holds this project's maintenance lock"));

      expect(ran).toHaveLength(1);
      expect(refused).toHaveLength(1);
      // AC2: a refusal is a clean "nothing done this pass", not a crash —
      // both processes exit 0.
      expect(ran[0]!.exitCode).toBe(0);
      expect(refused[0]!.exitCode).toBe(0);

      // The graph was built exactly once, from the fixture's one commit —
      // not corrupted, not built twice into two different states.
      const provenance = JSON.parse(
        await readFile(path.join(root, ".metaproject", "data", "gdgraph", ".provenance.json"), "utf8"),
      ) as { commit: string };
      expect(provenance.commit).toBe(commit);

      const nodesRaw = await readFile(path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"), "utf8");
      const nodes = nodesRaw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { path?: string });
      expect(nodes.some((node) => node.path === "src/a.ts")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
