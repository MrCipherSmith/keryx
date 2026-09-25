// Flow 271 (agent bus P0): the session lease across REAL processes.
//
// Every shell here is `bun src/cli.ts shell --no-tui --chat` from the working
// tree, in a throwaway git project with HOME / XDG_* / KERYX_DATA_DIR pointed at
// a temp dir, and `--provider deepseek --model unused` so nothing is detected or
// dialled: chat mode opens (and leases) its session before any turn, and no turn
// is ever sent. stdin is a pipe (never a TTY), which is the non-interactive path.
//
// Proves AC1 (two `-c` shells), AC2 (non-TTY `-r <id>` refusal and `--fork`),
// AC5 (SIGSTOP → stale, `--take-over`; SIGKILL → silent reclaim, with the
// test-only `KERYX_SESSION_LEASE_STALE_MS` / `_HEARTBEAT_MS` knobs, which the
// shell honours only with `KERYX_TEST_LEASE_TIMING=1`), AC7 (SIGTERM, SIGINT
// and `/exit` remove the lease directory) and review F1 (a woken holder that
// lost its lease says so and writes nothing more).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { shortSessionId } from "../session/store";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const SHELL_ARGS = ["shell", "--provider", "deepseek", "--model", "unused", "--no-tui", "--chat"];
/** Short liveness for AC5: a stopped holder reads stale after 600 ms. */
const STALE_MS = 600;
const SHORT_LEASE_ENV = {
  KERYX_TEST_LEASE_TIMING: "1",
  KERYX_SESSION_LEASE_STALE_MS: String(STALE_MS),
  KERYX_SESSION_LEASE_HEARTBEAT_MS: "150",
};

/** `env` without the short-lease knobs: the D-09 defaults (15 s stale). */
function defaultTimingEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  for (const key of Object.keys(SHORT_LEASE_ENV)) delete out[key];
  return out;
}
/** Bound on waiting for a holder to read stale (polled, never slept). */
const STALE_WAIT_MS = 10_000;
const WAIT_MS = 15_000;

interface Sandbox {
  root: string;
  cwd: string;
  dataDir: string;
  env: Record<string, string>;
}

interface Shell {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  pid: number;
  /** stdout + stderr seen so far. */
  output: () => string;
  stderr: () => string;
}

const sandboxes: Sandbox[] = [];
const children: Shell[] = [];

function makeSandbox(extraEnv: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-lease-proc-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  const dataDir = path.join(root, "data");
  for (const dir of [home, cwd, dataDir]) Bun.spawnSync(["mkdir", "-p", dir]);
  Bun.spawnSync(["git", "init", "-q", "."], { cwd });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    KERYX_DATA_DIR: dataDir,
    TMPDIR: tmpdir(),
    NO_COLOR: "1",
    ...(process.env.NODE_EXTRA_CA_CERTS === undefined ? {} : { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
    ...extraEnv,
  };
  const sandbox = { root, cwd, dataDir, env };
  sandboxes.push(sandbox);
  return sandbox;
}

function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  })();
}

/** A shell whose stdin stays open until the test ends it. */
function startShell(sb: Sandbox, args: string[]): Shell {
  // R3 (flow 319 CI regression): SAFE_BUN_SPAWN_ARGS between "bun" and CLI
  // makes execArgv already carry the safe flags on THIS FIRST process, so
  // src/lib/safe-exec.ts's ensureSafeBunExec returns immediately instead of
  // spawning a re-exec'd wrapper — `proc.pid` below is the actual `keryx`
  // process, the same shape the shipped shebang launches. Without this, the
  // pid this test signals (SIGKILL/SIGSTOP) is a WRAPPER's pid, not the
  // process actually holding the session lease the test asserts about.
  const proc = Bun.spawn(["bun", ...SAFE_BUN_SPAWN_ARGS, CLI, ...SHELL_ARGS, ...args], {
    cwd: sb.cwd,
    env: sb.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = { text: "" };
  const err = { text: "" };
  collect(proc.stdout, out);
  collect(proc.stderr, err);
  const shell: Shell = { proc, pid: proc.pid, output: () => out.text + err.text, stderr: () => err.text };
  children.push(shell);
  return shell;
}

/** Run a command to completion (stdin at EOF). */
function runToExit(
  sb: Sandbox,
  argv: string[],
  env: Record<string, string> = sb.env,
): { code: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", ...SAFE_BUN_SPAWN_ARGS, CLI, ...argv], {
    cwd: sb.cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: WAIT_MS,
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** `<dataDir>/sessions/<projectKey>`: the one project this sandbox has. */
function projectDir(sb: Sandbox): string | undefined {
  const root = path.join(sb.dataDir, "sessions");
  if (!existsSync(root)) return undefined;
  const key = readdirSync(root).find((name) => !name.startsWith("."));
  return key === undefined ? undefined : path.join(root, key);
}

function sessionIds(sb: Sandbox): string[] {
  const dir = projectDir(sb);
  if (dir === undefined) return [];
  return readdirSync(dir).filter((name) => !name.startsWith(".") && statSync(path.join(dir, name)).isDirectory());
}

function leaseDir(sb: Sandbox, id: string): string {
  return path.join(projectDir(sb) ?? "", id, "active.lease");
}

function ownerPid(sb: Sandbox, id: string): number | undefined {
  try {
    const owner = JSON.parse(readFileSync(path.join(leaseDir(sb, id), "owner.json"), "utf8")) as { pid: number };
    return owner.pid;
  } catch {
    return undefined;
  }
}

function heartbeatAt(sb: Sandbox, id: string): number | undefined {
  try {
    const owner = JSON.parse(readFileSync(path.join(leaseDir(sb, id), "owner.json"), "utf8")) as {
      heartbeatAt: string;
    };
    const at = Date.parse(owner.heartbeatAt);
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}

/** The session whose lease names `pid`, once it appears. */
function waitForLeaseOf(sb: Sandbox, shell: Shell): Promise<string> {
  return waitFor(`the lease of pid ${shell.pid}\n${shell.output()}`, () =>
    sessionIds(sb).find((id) => ownerPid(sb, id) === shell.pid),
  );
}

function snapshot(dir: string): Record<string, { bytes: string; mtimeMs: number }> {
  const out: Record<string, { bytes: string; mtimeMs: number }> = {};
  for (const name of ["context.jsonl", "archive.jsonl", "summary.json"]) {
    const file = path.join(dir, name);
    out[name] = { bytes: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs };
  }
  return out;
}

function kill(shell: Shell, signal: NodeJS.Signals | number = "SIGKILL"): void {
  try {
    process.kill(shell.pid, signal);
  } catch {
    // already gone
  }
}

afterEach(async () => {
  for (const shell of children.splice(0)) {
    kill(shell, "SIGCONT");
    kill(shell, "SIGKILL");
    await shell.proc.exited;
  }
  for (const sb of sandboxes.splice(0)) rmSync(sb.root, { recursive: true, force: true });
});

// SIGSTOP/SIGCONT and POSIX signal exit codes: not on Windows.
describe.skipIf(process.platform === "win32")("session lease across processes (flow 271)", () => {
  test("AC1: a second `-c` shell opens a different session and names the one it skipped", async () => {
    const sb = makeSandbox();
    const a = startShell(sb, ["-c"]);
    const x = await waitForLeaseOf(sb, a);

    const b = startShell(sb, ["-c"]);
    const y = await waitForLeaseOf(sb, b);

    expect(y).not.toBe(x);
    expect(ownerPid(sb, x)).toBe(a.pid);
    expect(ownerPid(sb, y)).toBe(b.pid);
    await waitFor("the skipped-session line", () => b.output().includes("Skipped session"));
    expect(b.output()).toContain(`Skipped session ${shortSessionId(x)}`);
    expect(b.output()).toContain(`(pid ${a.pid})`);
  }, 30_000);

  test("AC2: non-TTY `-r <id>` on a live holder exits non-zero, names --fork, writes nothing; --fork leases a fork", async () => {
    const sb = makeSandbox();
    const a = startShell(sb, ["-c"]);
    const x = await waitForLeaseOf(sb, a);
    const xDir = path.join(projectDir(sb) ?? "", x);
    const before = snapshot(xDir);

    const refused = runToExit(sb, [...SHELL_ARGS, "-r", x]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("--fork");
    expect(snapshot(xDir)).toEqual(before);
    expect(ownerPid(sb, x)).toBe(a.pid);

    const forked = startShell(sb, ["-r", x, "--fork"]);
    const f = await waitForLeaseOf(sb, forked);
    expect(f).not.toBe(x);
    expect(existsSync(path.join(projectDir(sb) ?? "", f))).toBe(true);
    expect(ownerPid(sb, x)).toBe(a.pid);
    expect(snapshot(xDir)).toEqual(before);
  }, 30_000);

  test("AC5: a SIGSTOPped holder reads stale; -c skips it; --take-over reclaims it; --take-over on a live holder is refused", async () => {
    const sb = makeSandbox(SHORT_LEASE_ENV);
    const a = startShell(sb, ["-c"]);
    const x = await waitForLeaseOf(sb, a);
    kill(a, "SIGSTOP");

    // Poll the CLI rather than sleep a fixed time past staleMs: a loaded runner
    // can delay the last heartbeat or the list itself.
    await waitFor(
      `sessions list to report ${x} stale`,
      () => {
        const listed = runToExit(sb, ["sessions", "list", "--json"]);
        if (listed.code !== 0) return false;
        const rows = (JSON.parse(listed.stdout) as { sessions: { id: string; live?: string }[] }).sessions;
        return rows.find((row) => row.id === x)?.live === "stale";
      },
      STALE_WAIT_MS,
    );

    const b = startShell(sb, ["-c"]);
    const y = await waitForLeaseOf(sb, b);
    expect(y).not.toBe(x);
    await waitFor("the skipped-session line", () => b.output().includes("Skipped session"));
    expect(b.output()).toContain(`Skipped session ${shortSessionId(x)}`);
    expect(b.output()).toContain("(stale)");

    const taker = startShell(sb, ["-r", x, "--take-over"]);
    await waitFor(`--take-over to hold ${x}\n${taker.output()}`, () => ownerPid(sb, x) === taker.pid);

    // The taker is live (heartbeating every 150 ms): a second --take-over is
    // refused. That second shell judges with the DEFAULT 15 s staleMs, not the
    // short 600 ms, so a loaded runner delaying the taker's heartbeats cannot
    // make it read stale (review F7).
    const refused = runToExit(sb, [...SHELL_ARGS, "-r", x, "--take-over"], defaultTimingEnv(sb.env));
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("--fork");
    expect(ownerPid(sb, x)).toBe(taker.pid);

    // The stopped holder wakes. Its next heartbeat finds the lease is not its
    // own: it says so once, stops saving the session, and on exit leaves the
    // taker's lease alone (review F1). No turn is sent (nothing is dialled in
    // this test), so "writes nothing" is checked as the session files staying
    // byte-identical while A is awake; the per-turn guard is unit-tested in
    // shell-lease.test.ts.
    const xDir = path.join(projectDir(sb) ?? "", x);
    const beforeWake = snapshot(xDir);
    kill(a, "SIGCONT");
    await waitFor(`the stopped holder to report the take-over\n${a.output()}`, () =>
      a.output().includes(`session ${shortSessionId(x)} was taken over by`),
    );
    expect(a.output()).toContain(`(pid ${taker.pid})`);
    expect(snapshot(xDir)).toEqual(beforeWake);
    kill(a, "SIGTERM");
    await a.proc.exited;
    expect(ownerPid(sb, x)).toBe(taker.pid);
    expect(snapshot(xDir)).toEqual(beforeWake);
  }, 30_000);

  test("AC5: after SIGKILL the lease is reclaimed silently by a plain `-r <id>`", async () => {
    const sb = makeSandbox(SHORT_LEASE_ENV);
    const a = startShell(sb, ["-c"]);
    const x = await waitForLeaseOf(sb, a);
    kill(a, "SIGKILL");
    await a.proc.exited;
    expect(existsSync(leaseDir(sb, x))).toBe(true);
    // Wait until the dead holder's last heartbeat is older than staleMs, read
    // from owner.json itself instead of a fixed sleep.
    await waitFor(
      "the dead holder's heartbeat to age past staleMs",
      () => {
        const at = heartbeatAt(sb, x);
        return at !== undefined && Date.now() - at > STALE_MS;
      },
      STALE_WAIT_MS,
    );

    const b = startShell(sb, ["-r", x]);
    await waitFor(`-r to reclaim ${x}\n${b.output()}`, () => ownerPid(sb, x) === b.pid);
    expect(b.output()).not.toContain("--fork");
  }, 30_000);

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    test(`AC7: ${signal} removes the lease directory`, async () => {
      const sb = makeSandbox();
      const a = startShell(sb, ["-c"]);
      const x = await waitForLeaseOf(sb, a);
      kill(a, signal);
      expect(await a.proc.exited).toBe(code);
      expect(existsSync(leaseDir(sb, x))).toBe(false);
    }, 30_000);
  }

  test("AC7: `/exit` removes the lease directory", async () => {
    const sb = makeSandbox();
    const a = startShell(sb, ["-c"]);
    const x = await waitForLeaseOf(sb, a);
    a.proc.stdin.write("/exit\n");
    await a.proc.stdin.flush();
    expect(await a.proc.exited).toBe(0);
    expect(existsSync(leaseDir(sb, x))).toBe(false);
  }, 30_000);
});
