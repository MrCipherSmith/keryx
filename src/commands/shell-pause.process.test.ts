// Flow 275 T9: cross-process proofs of pause leases (`src/bus/pause.ts`,
// wired into the readline agent REPL's held-turn gating in `src/commands/
// shell.ts` and the `keryx bus` CLI in `src/commands/bus.ts`).
//
// Every shell here is `bun src/cli.ts shell --provider deepseek --model
// unused --no-tui [--agent]` from the working tree, in a throwaway git
// project with HOME / XDG_* / KERYX_DATA_DIR pointed at a temp dir
// (shell-bus.process.test.ts's sandbox pattern): `--provider`/`--model` skip
// the interactive provider/mode pickers entirely (`runShell`'s own branch —
// see the comment on `SHELL_ARGS` below), so agent mode starts without ever
// touching a TTY prompt. Deliberately AGENT mode, not `--chat`: the `turns`
// held-line gating (`isHeld`/`heldQueue`, specification §4.3, AC5) and the
// `git-publish` shell_exec floor (`executeCall`'s `publishLease`, AC6) both
// live only in `runAgentRepl` — the plain `--chat` REPL (`runShell`) never
// reaches either path, which is why the flow-273/274 bus-wiring templates
// (`shell-bus.process.test.ts`, always `--chat`) never needed to care.
//
// No test here waits for a real model turn to COMPLETE: `--provider deepseek
// --model unused` avoids any provider detection dial-out, but an operator
// line that is actually allowed to run (not held) still reaches
// `runAgentTurn`, which would make a real network call with no credentials
// configured. Every assertion below stops at the turn-START marker
// (`shell.ts`'s own `out("\n  ● keryx\n")`, printed synchronously BEFORE the
// network call) — enough to prove "a turn started" or "no turn started"
// without ever depending on that call's outcome. AC11's git-publish scenario
// goes further still: rather than drive a real `shell_exec` tool call through
// an unconfigured model, a tiny driver script reproduces the exact inputs
// `executeCall` (`src/commands/agent.ts`) builds — `isPublishCommand` and
// `BusClient.leaseView().appliesToMe("git-publish")` — and calls
// `resolveApprovalDecision` (`src/commands/permission-mode.ts`) directly.
//
// Hermetic: every sandbox is a fresh temp git repo with its own HOME / XDG_*
// / KERYX_DATA_DIR per shell, so the bus joined here is never the operator's
// own. Signals are POSIX-only, so the file is skipped on win32.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { cursorAtStart, readEvents } from "../bus/log";
import { listLeases } from "../bus/leases";
import { resolveBusRoot } from "../bus/paths";
import { listPresence } from "../bus/presence";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const PAUSE_MODULE = path.join(REPO_ROOT, "src", "bus", "pause.ts");
const PERMISSION_MODE_MODULE = path.join(REPO_ROOT, "src", "commands", "permission-mode.ts");
const COMMAND_RISK_MODULE = path.join(REPO_ROOT, "src", "lib", "command-risk.ts");

// `--agent` is the default whenever `--provider` is given (see the doc
// comment above) — spelled out here so a future default change cannot
// silently move these shells onto the `--chat` loop, which has none of this
// gating.
const SHELL_ARGS = ["shell", "--provider", "deepseek", "--model", "unused", "--no-tui", "--agent"];

/** Bound on waiting for anything in this file (polled, never slept a fixed time). */
const WAIT_MS = 15_000;
/**
 * Bound for a wait that depends on a PEER shell's own poll cycle noticing and
 * RENDERING a bus event — a pause-request notice, a held notice, a resume/
 * override broadcast line, or a queued turn actually starting once released
 * (every `nudgeUntil` use, and every `waitFor` reading the OTHER shell's
 * `output()` for text a peer's action caused). `WAIT_MS` covers a LOCAL
 * confirmation the SAME process prints synchronously off its own command
 * (`shell.ts`'s `emit()` inside the `/bus pause`/`resume`/`override` handlers
 * — no polling involved, so no reason to budget for it). The peer kind
 * crosses three extra scheduling hops a local wait does not: the other
 * process's `KERYX_BUS_POLL_MS` timer (`POLL_ENV` below) actually firing,
 * its poll reading the shared bus root from disk, and this test's own stdout
 * pipe read noticing the bytes it wrote — any one of which can be starved for
 * seconds at a time on a loaded or throttled CI runner without the process
 * itself being stuck. `WAIT_MS`'s 15s is 60 nominal poll cycles of margin
 * unloaded, which measured CI flakiness (flow flaky-tests, 2026-09; this file
 * failed one such wait at exactly its own ~16s ceiling) shows is not always
 * enough; doubling it costs nothing on a passing run (`waitFor` returns the
 * moment its condition is true, never waits out the ceiling) and stays well
 * inside the 45s per-test timeout.
 */
const PEER_EVENT_WAIT_MS = 30_000;
/** Fast poll so a pause/resume/override propagates to the other shell quickly. */
const POLL_ENV = { KERYX_BUS_POLL_MS: "250" };
/** One {@link nudgeUntil} Enter per poll interval: a fresh drain attempt each time the lease view can have moved. */
const NUDGE_MS = Number(POLL_ENV.KERYX_BUS_POLL_MS);
/**
 * D-09's 15 s presence window, shortened so a SIGKILLed holder's lease can be
 * classified inactive without a real wait — gated exactly like
 * `shell-bus.process.test.ts`'s own `SHORT_BUS_STALE_ENV`
 * (`KERYX_TEST_BUS_TIMING=1`, `src/bus/presence.ts`).
 */
const STALE_MS = 300;
const SHORT_BUS_STALE_ENV = { KERYX_TEST_BUS_TIMING: "1", KERYX_BUS_PRESENCE_STALE_MS: String(STALE_MS) };

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

interface Shell {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  pid: number;
  /** stdout + stderr seen so far. */
  output: () => string;
}

interface BusListJson {
  peers: unknown[];
  leases: { leaseId: string }[];
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

/**
 * A + B share one git repo (one bus root) but each gets its OWN HOME / XDG_*
 * / KERYX_DATA_DIR — same shape as `shell-bus.process.test.ts`'s AC7
 * sandbox, minus the second worktree this dispatch does not need (pause
 * leases are not worktree-scoped).
 */
function makePair(extraEnv: Record<string, string> = {}): { repo: string; envA: Record<string, string>; envB: Record<string, string> } {
  const work = mkdtempSync(path.join(tmpdir(), "keryx-pause-proc-"));
  roots.push(work);
  const repo = path.join(work, "repo");
  initRepo(repo);
  const envA = checkoutEnv(path.join(work, "envA"), extraEnv);
  const envB = checkoutEnv(path.join(work, "envB"), extraEnv);
  return { repo, envA, envB };
}

function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  })();
}

/** A shell whose stdin stays open until the test ends it. */
function startShell(cwd: string, env: Record<string, string>, extraArgs: string[] = []): Shell {
  const proc = Bun.spawn(["bun", CLI, ...SHELL_ARGS, ...extraArgs], {
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

/**
 * Bare-Enter nudges, one per poll interval, until `ready` holds — the drain
 * equivalent of {@link waitFor}, and bounded the same way.
 *
 * readline has no idle wake of its own (`shell.ts`'s own comment on
 * `heldQueue`): a queued line runs only when the REPL comes back around to
 * the top of its loop and calls `drainHeldQueue()` again, and a bare Enter is
 * what makes it do that. The empty line takes its OWN early-continue branch
 * (`shell.ts`: `if (line.trim().length === 0)`), so a nudge starts no turn of
 * its own and costs nothing but a reprinted prompt when the queue is not
 * drainable yet.
 *
 * ONE Enter is not enough, which is the whole reason this helper exists.
 * Printing a release and acting on it are two different moments in the same
 * poll tick: `client.ts`'s `doPoll` renders every addressed event through
 * `onEvent` (that is the `resume:` line this file waits on), THEN advances
 * the cursor, THEN awaits `listPresence`, and only THEN awaits
 * `leaseViewInstance.refresh()` — so for two more filesystem round-trips
 * after B prints the release, B's own `isHeld()` still answers true. A single
 * Enter landing in that window drains nothing, and because nothing else ever
 * wakes readline, the queued line would then never run AT ALL. That is a
 * hang, not a slow pass: the one-shot nudge this replaces failed as a 15 s
 * `waitFor` timeout (never an assertion), about one run in three when the
 * whole terminal leg was competing for the CPU. Retrying the nudge is what
 * makes the drain independent of where that refresh lands — waiting longer
 * before a single Enter would not, since the window is not bounded by
 * anything this test can observe.
 */
async function nudgeUntil(shell: Shell, what: string, ready: () => boolean, timeoutMs = PEER_EVENT_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ready()) return;
    await writeLine(shell, "");
    const nextNudge = Date.now() + NUDGE_MS;
    do {
      await Bun.sleep(25);
      if (ready()) return;
    } while (Date.now() < nextNudge);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${shell.output()}`);
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
async function waitForPresence(cwd: string, count: number): Promise<void> {
  const root = await busRootFor(cwd);
  await waitFor(`${count} presence record(s) at ${root}`, async () => {
    const list = await listPresence(root);
    return list.length === count ? true : undefined;
  });
}

function busListJson(cwd: string, env: Record<string, string>): BusListJson {
  const proc = Bun.spawnSync(["bun", CLI, "bus", "list", "--json"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`keryx bus list --json failed: ${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString()) as BusListJson;
}

/** The literal turn-start marker `runOperatorLine`/the task-notification branch print — never anything else in this REPL (`shell.ts`'s header uses "◆", not "●"). */
const TURN_STARTED = /●\s*keryx/;

afterEach(async () => {
  for (const shell of children.splice(0)) {
    kill(shell, "SIGCONT");
    kill(shell, "SIGKILL");
    await shell.proc.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// SIGKILL and POSIX signal exit codes: not on Windows.
describe.skipIf(process.platform === "win32")("readline pause leases across processes (flow 275 T9, AC11)", () => {
  test("hold and resume: B's operator line is held while A's `turns` lease is active, and runs once A resumes", async () => {
    const { repo, envA, envB } = makePair(POLL_ENV);
    const a = startShell(repo, envA, ["--name", "alpha"]);
    const b = startShell(repo, envB, ["--name", "beta"]);
    await waitForPresence(repo, 2);

    await writeLine(a, "/bus pause @all --scope turns holding for release");
    await waitFor(`A's pause confirmation\n${a.output()}`, () =>
      /bus: paused turns for @all/.test(a.output()) ? true : undefined,
    );
    await waitFor(
      `B's pause-request notice\n${b.output()}`,
      () => (/pause-request: holding for release/.test(b.output()) ? true : undefined),
      PEER_EVENT_WAIT_MS,
    );
    // `leaseViewInstance.refresh()` runs right after the notice is printed,
    // in the same poll tick (`client.ts`'s `doPoll`) but as its own awaited
    // step — one more poll interval of margin so `isHeld()` is certainly
    // current before the next line is sent.
    await Bun.sleep(Number(POLL_ENV.KERYX_BUS_POLL_MS) * 3);

    const beforeHeldLen = b.output().length;
    await writeLine(b, "hello while held");
    await waitFor(
      `B's held notice\n${b.output()}`,
      () => {
        const added = b.output().slice(beforeHeldLen);
        return /turns held by @alpha/.test(added) && /Your line is queued and will run once released/.test(added)
          ? true
          : undefined;
      },
      PEER_EVENT_WAIT_MS,
    );
    // No turn started for the held line: give the (nonexistent) turn a
    // window it would need to print its start marker in, then confirm it
    // never did.
    await Bun.sleep(750);
    expect(b.output().slice(beforeHeldLen)).not.toMatch(TURN_STARTED);

    await writeLine(a, "/bus resume");
    await waitFor(`A's resume confirmation\n${a.output()}`, () =>
      /bus: resumed lease/.test(a.output()) ? true : undefined,
    );
    await waitFor(
      `B reports the release\n${b.output()}`,
      () => (/⇄ \[#\d+\] @alpha resume:/.test(b.output()) ? true : undefined),
      PEER_EVENT_WAIT_MS,
    );

    // The drain happens "at the next prompt or poll" — nudged until it does,
    // because B printing the release does not yet mean B's own `isHeld()`
    // has seen it (see `nudgeUntil`).
    const beforeRunLen = b.output().length;
    await nudgeUntil(b, "the held line to run", () => TURN_STARTED.test(b.output().slice(beforeRunLen)));
  }, 45_000);

  test("override: B's own `/bus override` releases only B while A's lease stays active for other targets", async () => {
    const { repo, envA, envB } = makePair(POLL_ENV);
    const a = startShell(repo, envA, ["--name", "alpha"]);
    const b = startShell(repo, envB, ["--name", "beta"]);
    await waitForPresence(repo, 2);

    await writeLine(a, "/bus pause @all --scope turns overriding test");
    await waitFor(`A's pause confirmation\n${a.output()}`, () =>
      /bus: paused turns for @all/.test(a.output()) ? true : undefined,
    );
    await waitFor(
      `B's pause-request notice\n${b.output()}`,
      () => (/pause-request: overriding test/.test(b.output()) ? true : undefined),
      PEER_EVENT_WAIT_MS,
    );
    await Bun.sleep(Number(POLL_ENV.KERYX_BUS_POLL_MS) * 3);

    const beforeHeldLen = b.output().length;
    await writeLine(b, "line while held");
    await waitFor(
      `B's held notice\n${b.output()}`,
      () => (/turns held by @alpha/.test(b.output().slice(beforeHeldLen)) ? true : undefined),
      PEER_EVENT_WAIT_MS,
    );
    expect(b.output().slice(beforeHeldLen)).not.toMatch(TURN_STARTED);

    const beforeOverrideLen = b.output().length;
    await writeLine(b, "/bus override");
    await waitFor(`B's own override confirmation\n${b.output()}`, () =>
      /bus: overrode lease/.test(b.output().slice(beforeOverrideLen)) ? true : undefined,
    );

    // B's own hold clears immediately — `override()` marks it locally before
    // the event even lands (`pause.ts`'s `createLeaseView`) — and unlike the
    // hold/resume test, `/bus override`'s own handler falls through to the
    // SAME `continue` every slash command shares, which loops back to the top
    // of the REPL and calls `drainHeldQueue()` before waiting for any new
    // input: the queued line runs as part of processing `/bus override`
    // itself, no separate "next prompt" nudge needed here.
    await waitFor(`the held line runs after B's own override\n${b.output()}`, () =>
      TURN_STARTED.test(b.output().slice(beforeOverrideLen)) ? true : undefined,
    );

    // The lease stays active for every OTHER target — proven directly
    // against the lease store and the log, not through a third instance.
    const root = await busRootFor(repo);
    const leases = await listLeases(root);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.targets).toEqual(["*"]);
    const { events } = await readEvents(root, await cursorAtStart(root));
    expect(events.some((e) => e.kind === "override" && e.refs?.leaseId === leases[0]?.leaseId)).toBe(true);
  }, 45_000);

  test("holder killed: SIGKILL of A yields exactly one lease-expired even with concurrent prune observers, and B is no longer held", async () => {
    const { repo, envA, envB } = makePair({ ...POLL_ENV, ...SHORT_BUS_STALE_ENV });
    const a = startShell(repo, envA, ["--name", "alpha"]);
    const b = startShell(repo, envB, ["--name", "beta"]);
    await waitForPresence(repo, 2);

    await writeLine(a, "/bus pause @all --scope turns holder going away");
    await waitFor(`A's pause confirmation\n${a.output()}`, () =>
      /bus: paused turns for @all/.test(a.output()) ? true : undefined,
    );
    await waitFor(
      `B's pause-request notice\n${b.output()}`,
      () => (/pause-request: holder going away/.test(b.output()) ? true : undefined),
      PEER_EVENT_WAIT_MS,
    );
    await Bun.sleep(Number(POLL_ENV.KERYX_BUS_POLL_MS) * 3);

    const root = await busRootFor(repo);
    const [before] = await listLeases(root);
    const leaseId = before?.leaseId;
    expect(leaseId).toBeDefined();

    // Queue a line on B before the kill, so "B is no longer held" can be
    // proven the same way the hold/resume test proves a release: the queued
    // line actually runs.
    const beforeHeldLen = b.output().length;
    await writeLine(b, "queued before the kill");
    await waitFor(
      `B's held notice\n${b.output()}`,
      () => (/turns held by @alpha/.test(b.output().slice(beforeHeldLen)) ? true : undefined),
      PEER_EVENT_WAIT_MS,
    );

    kill(a, "SIGKILL");
    await a.proc.exited;

    // Once A's presence reads `gone` (D-09, shortened by `SHORT_BUS_STALE_ENV`
    // for both the shells above and every CLI child below), the lease is
    // inactive system-wide.
    await waitFor("bus list --json to stop counting the lease active", () => {
      const listed = busListJson(repo, { ...envB, ...SHORT_BUS_STALE_ENV });
      return listed.leases.length === 0 ? true : undefined;
    });

    // Several concurrent `bus prune` observers race to write the
    // `lease-expired` event; `prune.ts`'s delete-before-append ordering
    // under one lock means exactly one of them lands it.
    const pruners = Array.from({ length: 3 }, () =>
      Bun.spawn(["bun", CLI, "bus", "prune"], { cwd: repo, env: { ...envB, ...SHORT_BUS_STALE_ENV }, stdout: "pipe", stderr: "pipe" }),
    );
    const codes = await Promise.all(pruners.map((p) => p.exited));
    for (const code of codes) expect(code).toBe(0);

    const { events } = await readEvents(root, await cursorAtStart(root));
    const expired = events.filter((e) => e.kind === "lease-expired" && e.refs?.leaseId === leaseId);
    expect(expired).toHaveLength(1);
    expect(await listLeases(root)).toHaveLength(0);

    // B is no longer held: the same "next prompt" nudge drains its queue —
    // retried, and here for a second reason on top of the one `nudgeUntil`
    // documents. Everything above about this lease was observed from OTHER
    // processes (`bus list --json`, `bus prune`, the store and the log
    // directly); B learns the holder is gone only from its own next poll, so
    // when the first nudge goes out B may not have polled since the kill at
    // all.
    const beforeRunLen = b.output().length;
    await nudgeUntil(b, "the queued line to run once the holder is gone", () =>
      TURN_STARTED.test(b.output().slice(beforeRunLen)),
    );
  }, 45_000);

  test("git-publish under auto: a driver reproducing B's approval gate resolves to `ask` only while the lease applies", async () => {
    const { repo, envA, envB } = makePair(POLL_ENV);
    const a = startShell(repo, envA, ["--name", "alpha"]);
    // `--auto` is the real posture this scenario is about; the assertions
    // below drive `resolveApprovalDecision` directly rather than through a
    // live `shell_exec` tool call (see the file header comment) — starting B
    // this way keeps the setup faithful to what AC11 describes even though
    // the driver does not read B's in-process `permissionMode` back.
    const b = startShell(repo, envB, ["--auto", "--name", "beta"]);
    await waitForPresence(repo, 2);

    const root = await busRootFor(repo);
    const betaRecord = (await listPresence(root)).find((p) => p.name === "beta");
    expect(betaRecord).toBeDefined();

    const driverDir = mkdtempSync(path.join(tmpdir(), "keryx-publish-gate-"));
    roots.push(driverDir);
    const driver = path.join(driverDir, "driver.ts");
    writeFileSync(
      driver,
      `import { createLeaseView } from ${JSON.stringify(PAUSE_MODULE)};
import { resolveApprovalDecision } from ${JSON.stringify(PERMISSION_MODE_MODULE)};
import { isPublishCommand } from ${JSON.stringify(COMMAND_RISK_MODULE)};
const [root, instanceId, command] = process.argv.slice(2);
const view = createLeaseView({ root, instanceId });
await view.refresh();
const publishLease = isPublishCommand(command) && view.appliesToMe("git-publish");
const decision = resolveApprovalDecision({
  mode: "auto",
  risk: "shell",
  destructive: false,
  credentials: false,
  sacReviewConfirmation: false,
  readOnly: false,
  publishLease,
});
console.log(JSON.stringify({ publishLease, decision }));
`,
      "utf8",
    );

    const runDriver = async (command: string): Promise<{ publishLease: boolean; decision: string }> => {
      const proc = Bun.spawn(["bun", driver, root, betaRecord!.instanceId, command], {
        cwd: repo,
        env: envB,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) throw new Error(`driver exited ${code}: ${await new Response(proc.stderr).text()}`);
      return JSON.parse(stdout) as { publishLease: boolean; decision: string };
    };

    // Baseline: no lease, `auto` bypasses the prompt for a shell command.
    expect(await runDriver("git push --dry-run")).toEqual({ publishLease: false, decision: "auto" });

    await writeLine(a, "/bus pause @all --scope git-publish cutting a release");
    await waitFor(`A's pause confirmation\n${a.output()}`, () =>
      /bus: paused git-publish for @all/.test(a.output()) ? true : undefined,
    );
    await waitFor(
      `B's pause-request notice\n${b.output()}`,
      () => (/pause-request: cutting a release/.test(b.output()) ? true : undefined),
      PEER_EVENT_WAIT_MS,
    );

    // The floor: `auto` still asks for a publish command while the lease applies.
    expect(await runDriver("git push --dry-run")).toEqual({ publishLease: true, decision: "ask" });
    // ADR-0009: a classifier miss never grants — an unrelated command is
    // unaffected by the very same active lease.
    expect(await runDriver("git status")).toEqual({ publishLease: false, decision: "auto" });
  }, 30_000);

  test("the CLI as holder: `keryx bus pause`/`resume` from a terminal; a second CLI pause while active is refused", async () => {
    const work = mkdtempSync(path.join(tmpdir(), "keryx-pause-cli-"));
    roots.push(work);
    const repo = path.join(work, "proj");
    initRepo(repo);
    const env = checkoutEnv(work);

    const pause1 = Bun.spawnSync(["bun", CLI, "bus", "pause", "@all", "--reason", "x", "--json"], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(pause1.exitCode).toBe(0);
    const parsed = JSON.parse(pause1.stdout.toString()) as { leaseId: string };
    expect(typeof parsed.leaseId).toBe("string");

    const pause2 = Bun.spawnSync(["bun", CLI, "bus", "pause", "@all", "--reason", "y"], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(pause2.exitCode).not.toBe(0);
    expect(pause2.stderr.toString()).toContain("lease-already-held");

    const resume = Bun.spawnSync(["bun", CLI, "bus", "resume", parsed.leaseId], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(resume.exitCode).toBe(0);
    expect(resume.stdout.toString()).toContain("resumed lease");

    const root = await busRootFor(repo);
    expect(await listLeases(root)).toHaveLength(0);

    // Once resumed, a fresh CLI pause is no longer refused (the clone-wide
    // limit is "at most one ACTIVE CLI lease", not "ever one").
    const pause3 = Bun.spawnSync(["bun", CLI, "bus", "pause", "@all", "--reason", "z", "--json"], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(pause3.exitCode).toBe(0);
  }, 20_000);
});
