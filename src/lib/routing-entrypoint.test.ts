import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { pathExists } from "./fs";
import { InstallCrashSignal, InstallPlanBlockedError, readInstallJournal } from "./install-plan";
import {
  planRoutingEntrypointPair,
  writeRoutingEntrypointPair,
} from "./routing-entrypoint";
import type { RoutingEntrypointOptions } from "./templates";

const OPTIONS: RoutingEntrypointOptions = {
  enableGdgraph: false,
  enableGdctx: true,
  enableGdwiki: false,
  enableGdskills: false,
  enableHealth: false,
  enableTesting: false,
  enableMemory: false,
  enableTasks: false,
  enableSecurity: true,
  ruleSources: ["AGENTS.md"],
  hasDistilledEntrypoints: false,
};

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-routing-plan-"));
  return path.join(root, ".metaproject");
}

/**
 * A pid that certainly belongs to no live process. A just-exited child is not
 * safe here: it can still be an unreaped zombie, which `kill(pid, 0)` reports
 * as alive. INT32_MAX is above every platform pid_max, so it is always ESRCH.
 */
function deadPid(): number {
  const pid = 2_147_483_647;
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    alive = typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
  expect(alive).toBe(false);
  return pid;
}

test("planning the routing pair writes neither member nor a journal", async () => {
  const metaprojectRoot = await fixture();
  try {
    const plan = await planRoutingEntrypointPair(metaprojectRoot, OPTIONS, { intent: "update" });
    expect(plan.steps.map((step) => step.id)).toEqual(["routing:full", "routing:index"]);
    expect(plan.steps.every((step) => step.outcome === "create")).toBe(true);
    expect(await pathExists(path.join(metaprojectRoot, "routing.md"))).toBe(false);
    expect(await pathExists(path.join(metaprojectRoot, "index.md"))).toBe(false);
    expect(await readInstallJournal(metaprojectRoot)).toBeUndefined();
  } finally {
    await rm(path.dirname(metaprojectRoot), { recursive: true, force: true });
  }
});

test("a crash between the router and its pointer resumes instead of restarting", async () => {
  const metaprojectRoot = await fixture();
  try {
    await expect(
      writeRoutingEntrypointPair(metaprojectRoot, OPTIONS, {
        intent: "init",
        writerVersion: "9.9.9",
        beforeStepMutation: (id) => {
          if (id === "routing:index") {
            throw new InstallCrashSignal("simulated crash between steps");
          }
        },
      }),
    ).rejects.toThrow(InstallCrashSignal);

    const crashed = await readInstallJournal(metaprojectRoot);
    expect(crashed?.steps["routing:full"]?.status).toBe("completed");
    expect(crashed?.steps["routing:index"]?.status).toBe("begun");
    expect(await pathExists(path.join(metaprojectRoot, "routing.md"))).toBe(true);
    expect(await pathExists(path.join(metaprojectRoot, "index.md"))).toBe(false);

    const notices: string[] = [];
    const pair = await writeRoutingEntrypointPair(metaprojectRoot, OPTIONS, {
      intent: "init",
      writerVersion: "9.9.9",
      onNotice: (line) => notices.push(line),
    });
    expect(notices.join("\n")).toContain("not rolled back");
    expect(await readFile(path.join(metaprojectRoot, "index.md"), "utf8")).toBe(pair.index);
    expect(await readFile(path.join(metaprojectRoot, "routing.md"), "utf8")).toBe(pair.routing);
    const resumedJournal = await readInstallJournal(metaprojectRoot);
    expect(resumedJournal?.steps["routing:index"]?.status).toBe("completed");
  } finally {
    await rm(path.dirname(metaprojectRoot), { recursive: true, force: true });
  }
});

// A killed process runs no `finally`, so the resume the lifecycle promises must
// not be gated behind waiting out the writer lock left by the crash it recovers.
test("a lock left by a process that no longer exists does not delay the resume", async () => {
  const metaprojectRoot = await fixture();
  try {
    const lockPath = path.join(metaprojectRoot, ".routing-entrypoint.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: deadPid(), token: "abandoned" }),
      "utf8",
    );

    const startedAt = Date.now();
    const pair = await writeRoutingEntrypointPair(metaprojectRoot, OPTIONS, { intent: "update" });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(await readFile(path.join(metaprojectRoot, "index.md"), "utf8")).toBe(pair.index);
  } finally {
    await rm(path.dirname(metaprojectRoot), { recursive: true, force: true });
  }
}, 20_000);

test("a lock whose owner is still alive is still honoured", async () => {
  const metaprojectRoot = await fixture();
  try {
    const lockPath = path.join(metaprojectRoot, ".routing-entrypoint.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "live" }),
      "utf8",
    );

    let refusal: unknown;
    try {
      await writeRoutingEntrypointPair(metaprojectRoot, OPTIONS, { intent: "update" });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as Error | undefined)?.message).toContain("Timed out waiting for lock");
    expect(await pathExists(lockPath)).toBe(true);
    expect(await pathExists(path.join(metaprojectRoot, "index.md"))).toBe(false);
  } finally {
    await rm(path.dirname(metaprojectRoot), { recursive: true, force: true });
  }
}, 20_000);

test("a routing file another version wrote and cannot account for blocks with both versions named", async () => {
  const metaprojectRoot = await fixture();
  try {
    await writeRoutingEntrypointPair(metaprojectRoot, OPTIONS, {
      intent: "init",
      writerVersion: "0.0.1",
    });
    await writeFile(path.join(metaprojectRoot, "routing.md"), "# hand edited\n", "utf8");

    let blocked: unknown;
    try {
      await writeRoutingEntrypointPair(metaprojectRoot, OPTIONS, {
        intent: "update",
        writerVersion: "9.9.9",
      });
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(InstallPlanBlockedError);
    expect((blocked as Error).message).toContain("0.0.1");
    expect((blocked as Error).message).toContain("9.9.9");
    expect((blocked as Error).message).toContain("--accept-version");
    expect(await readFile(path.join(metaprojectRoot, "routing.md"), "utf8")).toBe("# hand edited\n");

    const pair = await writeRoutingEntrypointPair(metaprojectRoot, OPTIONS, {
      intent: "update",
      writerVersion: "9.9.9",
      resolution: "accept-version",
    });
    expect(await readFile(path.join(metaprojectRoot, "routing.md"), "utf8")).toBe(pair.routing);
  } finally {
    await rm(path.dirname(metaprojectRoot), { recursive: true, force: true });
  }
});
