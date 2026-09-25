// Flow 273 T8: cross-process proofs of the readline shell's agent-bus wiring
// (`src/bus/client.ts`'s `joinBus`, wired into `src/commands/shell.ts`).
//
// Every shell here is `bun src/cli.ts shell --provider deepseek --model
// unused --no-tui --chat` from the working tree, in a throwaway git project
// with HOME / XDG_* / KERYX_DATA_DIR pointed at a temp dir (shell-lease.
// process.test.ts's pattern): chat mode opens (and leases) its session, then
// joins the bus, before any turn is ever sent; stdin is a pipe, never a TTY.
//
// Proves:
//   AC6  presence is removed on SIGTERM, SIGINT and `/exit`; a SIGKILLed
//        holder's presence file remains but reads `gone` in `bus list --json`
//        once the D-09 window passes (a test-only knob, gated exactly like
//        the session lease's `KERYX_SESSION_LEASE_STALE_MS`); a SIGSTOPped
//        holder reads `stale` (SIGCONT afterwards);
//   AC7  two readline shells started in two linked worktrees of one clone
//        list each other in `keryx bus list --json`, and a `/bus send @name`
//        from one produces the operator line in the other;
//   AC9  KERYX_BUS=off and a CI environment both print one `bus: off (...)`
//        line, write no presence, and `/exit` still works;
//   AC10 no child environment ever carries the bus instance id or name — a
//        unit-level check of `joinBus` and `resolveShellEnv` directly.
//
// Hermetic: every sandbox is a fresh temp git repo (or worktree) with its own
// HOME / XDG_* / KERYX_DATA_DIR, so the bus joined here is never the
// operator's own. Signals are POSIX-only, so the file is skipped on win32.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { joinBus } from "../bus/client";
import { resolveBusRoot } from "../bus/paths";
import { listPresence } from "../bus/presence";
import type { PresenceRecord } from "../bus/schema";
import { resolveShellEnv } from "../harness/process/shell-spawn";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const SHELL_ARGS = ["shell", "--provider", "deepseek", "--model", "unused", "--no-tui", "--chat"];

/** Bound on waiting for anything in this file (polled, never slept a fixed time). */
const WAIT_MS = 15_000;
/** Fast poll so a `/bus send` line and a presence write are seen quickly (AC7). */
const POLL_ENV = { KERYX_BUS_POLL_MS: "250" };
/**
 * D-09's 15 s presence window, shortened for AC6 so a SIGKILLed/SIGSTOPped
 * holder can be classified without a real wait — gated exactly like the
 * session lease's `KERYX_SESSION_LEASE_STALE_MS`
 * (`KERYX_TEST_BUS_TIMING=1`, `src/bus/presence.ts`).
 */
const STALE_MS = 300;
const SHORT_BUS_STALE_ENV = { KERYX_TEST_BUS_TIMING: "1", KERYX_BUS_PRESENCE_STALE_MS: String(STALE_MS) };

/**
 * Review r1 F8: the SIGSTOP test below needs a heartbeat interval short
 * enough that the record reads LIVE before SIGSTOP — proving the periodic
 * write is actually happening — and a stale window short enough to observe
 * it going STALE again soon after SIGSTOP stops that write. `STALE_MS`
 * above (300ms) paired with the real 5s production heartbeat made the old
 * version of that test pass even withOUT ever sending SIGSTOP, since a 5s
 * heartbeat never refreshes inside a 300ms window regardless. Gated exactly
 * like `SHORT_BUS_STALE_ENV`.
 */
const SIGSTOP_HEARTBEAT_MS = 100;
const SIGSTOP_STALE_MS = 600;
const SIGSTOP_ENV = {
  KERYX_TEST_BUS_TIMING: "1",
  KERYX_BUS_HEARTBEAT_MS: String(SIGSTOP_HEARTBEAT_MS),
  KERYX_BUS_PRESENCE_STALE_MS: String(SIGSTOP_STALE_MS),
};

/** Isolated from the host's git config (hooks, signing, identity rules). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

interface Sandbox {
  root: string;
  cwd: string;
  env: Record<string, string>;
}

interface Shell {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  pid: number;
  /** stdout + stderr seen so far. */
  output: () => string;
}

interface BusListPeer {
  name: string;
  instanceId: string;
  state: "live" | "stale";
}

interface BusListJson {
  peers: BusListPeer[];
}

const roots: string[] = [];
const children: Shell[] = [];

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "ignore", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, "README.md"), "x\n", "utf8");
  git(cwd, "init", "-q", "-b", "main", ".");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "initial");
}

/** A fresh HOME / XDG_* / KERYX_DATA_DIR for one checkout, isolated from the operator's. */
function checkoutEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    KERYX_DATA_DIR: dataDir,
    TMPDIR: tmpdir(),
    NO_COLOR: "1",
    ...(process.env.NODE_EXTRA_CA_CERTS === undefined ? {} : { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
    ...extra,
  };
}

/** A standalone sandbox: its own fresh git repo, HOME, XDG_* and KERYX_DATA_DIR. */
function makeSandbox(extraEnv: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-bus-proc-"));
  roots.push(root);
  const cwd = path.join(root, "proj");
  initRepo(cwd);
  return { root, cwd, env: checkoutEnv(root, extraEnv) };
}

function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  })();
}

/** A shell whose stdin stays open until the test ends it. */
function startShell(cwd: string, env: Record<string, string>, extraArgs: string[] = []): Shell {
  // R3 (flow 319 CI regression): the safe flags between "bun" and CLI keep
  // src/lib/safe-exec.ts's guard from spawning a re-exec'd wrapper, so
  // `proc.pid` below is the real `keryx` process this test's SIGKILL/SIGSTOP
  // (AC6) is meant to reach — not an intermediary that cannot forward either.
  const proc = Bun.spawn(["bun", ...SAFE_BUN_SPAWN_ARGS, CLI, ...SHELL_ARGS, ...extraArgs], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = { text: "" };
  const err = { text: "" };
  collect(proc.stdout, out);
  collect(proc.stderr, err);
  const shell: Shell = { proc, pid: proc.pid, output: () => out.text + err.text };
  children.push(shell);
  return shell;
}

async function waitFor<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

function kill(shell: Shell, signal: NodeJS.Signals | number = "SIGKILL"): void {
  try {
    process.kill(shell.pid, signal);
  } catch {
    // already gone
  }
}

async function writeLine(shell: Shell, line: string): Promise<void> {
  shell.proc.stdin.write(`${line}\n`);
  await shell.proc.stdin.flush();
}

async function busRootFor(cwd: string): Promise<string> {
  return (await resolveBusRoot(cwd)).root;
}

/** Polls `listPresence` until exactly `count` records exist. */
async function waitForPresence(cwd: string, count: number): Promise<PresenceRecord[]> {
  const root = await busRootFor(cwd);
  return waitFor<PresenceRecord[]>(`${count} presence record(s) at ${root}`, async () => {
    const list = await listPresence(root);
    return list.length === count ? list : undefined;
  });
}

async function waitForOnePresence(cwd: string): Promise<PresenceRecord> {
  const [record] = await waitForPresence(cwd, 1);
  if (record === undefined) throw new Error("expected exactly one presence record");
  return record;
}

function busListJson(cwd: string, env: Record<string, string>): BusListJson {
  const proc = Bun.spawnSync(["bun", ...SAFE_BUN_SPAWN_ARGS, CLI, "bus", "list", "--json"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`keryx bus list --json failed: ${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString()) as BusListJson;
}

afterEach(async () => {
  for (const shell of children.splice(0)) {
    kill(shell, "SIGCONT");
    kill(shell, "SIGKILL");
    await shell.proc.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// SIGSTOP/SIGCONT and POSIX signal exit codes: not on Windows.
describe.skipIf(process.platform === "win32")("readline shell agent bus across processes (flow 273 T8)", () => {
  describe("AC7: two readline shells in two linked worktrees of one clone", () => {
    test("list each other in `keryx bus list --json`; `/bus send @name` crosses worktrees", async () => {
      const work = mkdtempSync(path.join(tmpdir(), "keryx-bus-wt-"));
      roots.push(work);
      const repo = path.join(work, "repo");
      initRepo(repo);
      const worktree = path.join(work, "wt");
      git(repo, "worktree", "add", "-q", "-b", "feature", worktree, "main");

      const envA = checkoutEnv(path.join(work, "envA"), POLL_ENV);
      const envB = checkoutEnv(path.join(work, "envB"), POLL_ENV);

      const a = startShell(repo, envA, ["--name", "alpha"]);
      const b = startShell(worktree, envB, ["--name", "beta"]);

      const presence = await waitForPresence(repo, 2);
      expect(presence.map((record) => record.name).sort()).toEqual(["alpha", "beta"]);

      const fromRepo = busListJson(repo, envA);
      const fromWorktree = busListJson(worktree, envB);
      expect(fromRepo.peers.map((peer) => peer.name).sort()).toEqual(["alpha", "beta"]);
      expect(fromWorktree.peers.map((peer) => peer.name).sort()).toEqual(["alpha", "beta"]);

      await writeLine(a, "/bus send @beta hello");
      // review r1 F4: the shared `formatBusEventLine` (`../bus/display.ts`)
      // now renders `⇄ [#seq] @from kind: preview` — seq and shortId, not
      // just the bare `⇄ @from kind: preview` this line used to check for.
      await waitFor(`B to see alpha's line\n${b.output()}`, () =>
        /⇄ \[#\d+\] @alpha notice: hello/.test(b.output()) ? true : undefined,
      );

      await writeLine(a, "/exit");
      await writeLine(b, "/exit");
      expect(await a.proc.exited).toBe(0);
      expect(await b.proc.exited).toBe(0);
    }, 30_000);
  });

  describe("AC6: presence removal on exit, and D-09 liveness after SIGKILL/SIGSTOP", () => {
    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const) {
      test(`${signal} removes the presence record`, async () => {
        const sb = makeSandbox();
        const shell = startShell(sb.cwd, sb.env);
        await waitForOnePresence(sb.cwd);
        kill(shell, signal);
        expect(await shell.proc.exited).toBe(code);
        const root = await busRootFor(sb.cwd);
        expect(await listPresence(root)).toHaveLength(0);
      }, 20_000);
    }

    test("`/exit` over stdin removes the presence record", async () => {
      const sb = makeSandbox();
      const shell = startShell(sb.cwd, sb.env);
      await waitForOnePresence(sb.cwd);
      await writeLine(shell, "/exit");
      expect(await shell.proc.exited).toBe(0);
      const root = await busRootFor(sb.cwd);
      expect(await listPresence(root)).toHaveLength(0);
    }, 20_000);

    test("SIGKILL leaves the presence file; `bus list --json` reads it gone once the D-09 window passes", async () => {
      const sb = makeSandbox();
      const shell = startShell(sb.cwd, sb.env);
      const record = await waitForOnePresence(sb.cwd);
      kill(shell, "SIGKILL");
      await shell.proc.exited;

      const root = await busRootFor(sb.cwd);
      // The dead holder wrote no cleanup: its file is still on disk.
      expect(await listPresence(root)).toHaveLength(1);

      await waitFor("bus list --json to stop listing the killed holder (gone)", () => {
        const listed = busListJson(sb.cwd, { ...sb.env, ...SHORT_BUS_STALE_ENV });
        return listed.peers.some((peer) => peer.instanceId === record.instanceId) ? undefined : true;
      });
    }, 20_000);

    test("SIGSTOP reads stale in `bus list --json`; SIGCONT afterwards", async () => {
      const sb = makeSandbox(SIGSTOP_ENV);
      const shell = startShell(sb.cwd, sb.env);
      const record = await waitForOnePresence(sb.cwd);

      // review r1 F8: prove the record is genuinely live — refreshed by a
      // fast real heartbeat — BEFORE sending SIGSTOP, so the "stale after
      // SIGSTOP" assertion below actually demonstrates the signal stopped
      // the writes, rather than the stale window merely being too tight to
      // ever read live in the first place.
      const livePeer = await waitFor("bus list --json to read the holder live before SIGSTOP", () => {
        const listed = busListJson(sb.cwd, sb.env);
        return listed.peers.find((peer) => peer.instanceId === record.instanceId && peer.state === "live");
      });
      expect(livePeer.state).toBe("live");

      kill(shell, "SIGSTOP");

      const stalePeer = await waitFor("bus list --json to read the stopped holder stale", () => {
        const listed = busListJson(sb.cwd, sb.env);
        return listed.peers.find((peer) => peer.instanceId === record.instanceId && peer.state === "stale");
      });
      expect(stalePeer.state).toBe("stale");

      kill(shell, "SIGCONT");
      kill(shell, "SIGTERM");
      await shell.proc.exited;
    }, 20_000);
  });

  describe("AC9: a disabled bus prints its reason, writes no presence, and `/exit` still works", () => {
    test("KERYX_BUS=off", async () => {
      const sb = makeSandbox({ KERYX_BUS: "off" });
      const shell = startShell(sb.cwd, sb.env);
      await waitFor(`the bus:off line\n${shell.output()}`, () =>
        shell.output().includes("bus: off (KERYX_BUS=off)") ? true : undefined,
      );
      const root = await busRootFor(sb.cwd);
      expect(existsSync(path.join(root, "presence"))).toBe(false);
      await writeLine(shell, "/exit");
      expect(await shell.proc.exited).toBe(0);
    }, 20_000);

    test("a CI environment", async () => {
      const sb = makeSandbox({ CI: "true" });
      const shell = startShell(sb.cwd, sb.env);
      await waitFor(`the bus:off line\n${shell.output()}`, () =>
        shell.output().includes("bus: off (CI environment (CI is set))") ? true : undefined,
      );
      const root = await busRootFor(sb.cwd);
      expect(existsSync(path.join(root, "presence"))).toBe(false);
      await writeLine(shell, "/exit");
      expect(await shell.proc.exited).toBe(0);
    }, 20_000);
  });
});

// Not signal-dependent: runs on every platform.
describe("AC10: no child environment ever carries the bus instance id or name", () => {
  test("joinBus never touches process.env; resolveShellEnv's output never carries the instance id or name", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keryx-bus-env-"));
    roots.push(root);
    const cwd = path.join(root, "project");
    initRepo(cwd);

    const savedDataDir = process.env.KERYX_DATA_DIR;
    process.env.KERYX_DATA_DIR = path.join(root, "data");
    const envBefore = { ...process.env };

    // Real timers are never started: a poll or heartbeat firing after the test
    // moved on would be pure noise, and `leave()` below stops nothing they'd
    // need stopping anyway.
    const noopTimers = { setInterval: () => undefined, clearInterval: () => {} };
    try {
      const joined = await joinBus({
        cwd,
        sessionId: "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f",
        surface: "readline",
        requestedName: "leaktest",
        env: {},
        status: () => ({ status: "idle" as const, activity: "" }),
        onEvent: () => {},
        onPeers: () => {},
        timers: noopTimers,
      });
      try {
        if ("disabled" in joined) throw new Error(`expected the bus to be enabled, was disabled: ${joined.disabled}`);

        // `process.env` is untouched, key or value, by the instance id or name.
        for (const [key, value] of Object.entries(process.env)) {
          expect(key).not.toContain(joined.instanceId);
          expect(key).not.toContain(joined.name);
          if (value !== undefined) {
            expect(value).not.toContain(joined.instanceId);
            expect(value).not.toContain(joined.name);
          }
        }
        expect(process.env).toEqual(envBefore);

        // `resolveShellEnv` (the base env every `shell_exec` child starts
        // from) never carries them either.
        const shellEnv = await resolveShellEnv();
        for (const [key, value] of Object.entries(shellEnv)) {
          expect(key).not.toContain(joined.instanceId);
          expect(key).not.toContain(joined.name);
          expect(value).not.toContain(joined.instanceId);
          expect(value).not.toContain(joined.name);
        }
      } finally {
        if (!("disabled" in joined)) joined.leave();
      }
    } finally {
      if (savedDataDir === undefined) delete process.env.KERYX_DATA_DIR;
      else process.env.KERYX_DATA_DIR = savedDataDir;
    }
  });
});
