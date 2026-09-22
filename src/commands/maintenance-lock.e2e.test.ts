// Flow 290 T10 (AC9, AC10): the shared maintenance lock across REAL processes.
//
// AC9: an interactive `keryx gdgraph build` and a `keryx trigger run rebuild`
// in two real processes — exactly one builds at a time, the triggered one
// records `lock-refused`, the interactive one waits (bounded) and then names
// the holder's pid instead of reporting a build failure.
//
// AC10: `keryx sync --apply` (which calls `gdgraph build` in-process) and a
// triggered `reconcile` complete with a ZERO wait bound — any self-contention
// would surface at once as exit 75.
//
// Ordering is by events, not sleeps: the holder is started with
// `KERYX_MAINTENANCE_LOCK_HOLD_UNTIL=<file>`, writes `<file>.acquired` once it
// is inside the lock, and holds until the test creates `<file>`.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readTriggerRuns } from "../trigger/record";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function scaffoldProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-maint-lock-e2e-"));
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
        { name: "nightly-rebuild", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } },
        { name: "nightly-reconcile", on: { kind: "schedule", cron: "0 3 * * *" }, action: { kind: "reconcile" } },
      ],
    }),
    "utf8",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

interface Proc {
  readonly pid: number;
  readonly done: Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function spawnCli(root: string, args: string[], env: Record<string, string> = {}): Proc {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const done = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { stdout, stderr, exitCode: await proc.exited };
  })();
  return { pid: proc.pid, done };
}

/** Wait for a file the holder writes — an event, observed by polling its existence. */
async function waitForFile(file: string, holder: Proc): Promise<void> {
  let exited = false;
  void holder.done.then(() => {
    exited = true;
  });
  for (;;) {
    try {
      await stat(file);
      return;
    } catch {
      if (exited) throw new Error(`holder exited before writing ${file}: ${JSON.stringify(await holder.done)}`);
      await Bun.sleep(10);
    }
  }
}

test(
  "AC9: interactive `gdgraph build` holds the lock -> a triggered `rebuild` refuses (recorded lock-refused, exit 0); only one builds",
  async () => {
    const root = await scaffoldProject();
    const release = path.join(root, "release-a");
    try {
      const holder = spawnCli(root, ["gdgraph", "build"], { KERYX_MAINTENANCE_LOCK_HOLD_UNTIL: release });
      await waitForFile(`${release}.acquired`, holder);

      const triggered = await spawnCli(root, ["trigger", "run", "nightly-rebuild"]).done;
      expect(triggered.exitCode).toBe(0);
      expect(triggered.stdout).toContain("holds this project's maintenance lock");
      expect(triggered.stdout).toContain(`pid ${holder.pid}`);
      expect(triggered.stdout).not.toContain('"rebuild" completed');

      await writeFile(release, "go\n", "utf8");
      const interactive = await holder.done;
      expect(interactive.exitCode).toBe(0);
      expect(interactive.stdout).toContain("gdgraph build complete");

      const runs = await readTriggerRuns(root);
      expect(runs.state).toBe("present");
      if (runs.state === "present") {
        expect(runs.records.map((r) => r.outcome)).toEqual(["lock-refused"]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test(
  "AC9: a triggered `rebuild` holds the lock -> interactive `gdgraph build` waits its bound, then names the holder pid and exits 75 (not a build failure)",
  async () => {
    const root = await scaffoldProject();
    const release = path.join(root, "release-b");
    try {
      const holder = spawnCli(root, ["trigger", "run", "nightly-rebuild"], { KERYX_MAINTENANCE_LOCK_HOLD_UNTIL: release });
      await waitForFile(`${release}.acquired`, holder);

      const interactive = await spawnCli(root, ["gdgraph", "build"], { KERYX_MAINTENANCE_LOCK_WAIT_MS: "300" }).done;
      expect(interactive.exitCode).toBe(75);
      expect(interactive.stderr).toContain("keryx gdgraph build: not run");
      expect(interactive.stderr).toContain(`pid ${holder.pid}`);
      expect(interactive.stderr).not.toContain("failed");
      expect(interactive.stdout).not.toContain("gdgraph build complete");

      await writeFile(release, "go\n", "utf8");
      const triggered = await holder.done;
      expect(triggered.exitCode).toBe(0);
      expect(triggered.stdout).toContain('"rebuild" completed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test(
  "AC10: `sync --apply` (gdgraph build nested in-process) and a triggered `reconcile` complete with a ZERO wait bound — no self-refusal",
  async () => {
    const root = await scaffoldProject();
    try {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
      const sync = await spawnCli(root, ["sync", "--apply"], { KERYX_MAINTENANCE_LOCK_WAIT_MS: "0" }).done;
      expect(sync.exitCode).toBe(0);
      expect(sync.stderr).not.toContain("not run");
      const provenance = JSON.parse(
        await readFile(path.join(root, ".metaproject", "data", "gdgraph", ".provenance.json"), "utf8"),
      ) as { commit: string };
      expect(provenance.commit).toBe(commit);

      const reconcile = await spawnCli(root, ["trigger", "run", "nightly-reconcile"], {
        KERYX_MAINTENANCE_LOCK_WAIT_MS: "0",
      }).done;
      expect(reconcile.exitCode).toBe(0);
      expect(reconcile.stdout).toContain('"reconcile" completed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
