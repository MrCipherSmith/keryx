// Flow 273 T6: readline wiring of the agent bus (specification §5.1, §5.2,
// §5.4, §7.2's non-pause subset) in the chat REPL (`runShell`). Every test
// runs the REAL `joinBus` (`../bus/client.ts`) over a real temp git repo, with
// `KERYX_DATA_DIR` and the CI/`KERYX_BUS` env isolated per test so the bus
// this REPL joins is never the operator's own — the same isolation
// `shell-lease.test.ts` already uses for the session lease.
//
// `runAgentRepl` (the readline AGENT REPL) has no injection seam and is not
// unit-tested directly anywhere in this file — see its own doc comment and
// the SLATE-3a/SLATE-5 audits in `shell.test.ts`. Its equivalent wiring is
// proven the same way those audits do: by asserting the required literals
// exist, in the required order, in the real source text.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { BusClient } from "../bus/client";
import { presenceDir, presencePath, resolveBusRoot } from "../bus/paths";
import { listPresence, readPresence, writePresence } from "../bus/presence";
import { readEvents, cursorAtStart } from "../bus/log";
import { sendMessage } from "../bus/send";
import type { PresenceRecord } from "../bus/schema";
import { CI_ENV_VARS } from "../capability/external-agents";
import type { ProviderPort } from "../harness/provider/types";
import type { SessionLeaseHandle } from "../session/lease";
import { parseShellCliFlags, runShell, ShellFlagError, shellCommand } from "./shell";
import type { ShellDeps, ShellSessionOpts } from "./shell-types";

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ["KERYX_DATA_DIR", "KERYX_BUS", "KERYX_BUS_POLL_MS", ...CI_ENV_VARS];

function git(dir: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      // Isolated from the host's git config (hooks, signing, identity rules).
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-shell-bus-"));
  cwd = path.join(root, "project");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, "README.md"), "x\n", "utf8");
  git(cwd, "init", "-b", "main");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");

  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // A joinable, enabled bus for every test unless a test says otherwise:
  // isolated storage (never the operator's real bus), no CI-detected
  // disablement (a CI env var may be genuinely set in this very sandbox),
  // no leftover `KERYX_BUS=off` from an earlier test in the same process.
  process.env.KERYX_DATA_DIR = path.join(root, "data");
  delete process.env.KERYX_BUS;
  delete process.env.KERYX_BUS_POLL_MS;
  for (const key of CI_ENV_VARS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function shellDeps(session: ShellSessionOpts): ShellDeps {
  return {
    makeProvider: () => ({}) as ProviderPort,
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => randomUUID(),
    initial: { provider: "fake", model: "fake-model" },
    session,
  };
}

async function* linesFrom(...lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

/** A live peer, written directly (no second real shell process is needed for these tests). */
function peerRecord(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    instanceId: randomUUID(),
    name: "release",
    // This host, this (definitely alive) pid: classifies as `live` under the
    // REAL classification `joinBus` uses in production (no test override).
    pid: process.pid,
    host: hostname(),
    sessionId: randomUUID(),
    checkout: cwd,
    branch: "main",
    surface: "readline",
    status: "idle",
    activity: "",
    startedAt: now,
    heartbeatAt: now,
    keryxVersion: "0.0.0-test",
    ...overrides,
  };
}

describe("--name (AC11, flag validation)", () => {
  test("accepts a well-formed name", () => {
    expect(parseShellCliFlags(["--name", "release"])).toMatchObject({ name: "release" });
  });

  const refused: string[] = ["all", "cli", "system", "Release", "release!", "a".repeat(33)];
  for (const bad of refused) {
    test(`refuses "${bad}" with exit code 2`, () => {
      let thrown: unknown;
      try {
        parseShellCliFlags(["--name", bad]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ShellFlagError);
      expect((thrown as ShellFlagError).exitCode).toBe(2);
    });
  }

  test('a value starting with "-" (e.g. a name-shaped-but-flag-like typo) is refused as a missing value, same as every other flag', () => {
    expect(() => parseShellCliFlags(["--name", "-release"])).toThrow("Missing value for --name");
  });

  test("--help documents --name", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    };
    try {
      await shellCommand(["--help"]);
    } finally {
      console.log = original;
    }
    expect(lines.join("\n")).toContain("--name <name>");
  });
});

describe("runShell bus join (AC1, AC9, readline chat loop)", () => {
  test("joins with the default name and prints the join line", async () => {
    const output: string[] = [];
    await runShell({ lines: linesFrom("/exit"), write: (s) => output.push(s) }, shellDeps({ cwd }));
    expect(output.join("")).toContain("bus: joined as @agent-1 · 0 peers");
  });

  test("--name requests a name; a live peer holding it forces a note", async () => {
    const { root: busRoot } = await resolveBusRoot(cwd);
    await writePresence(busRoot, peerRecord({ name: "release" }));

    const output: string[] = [];
    await runShell(
      { lines: linesFrom("/exit"), write: (s) => output.push(s) },
      shellDeps({ cwd, busName: "release" }),
    );
    const text = output.join("");
    expect(text).toContain("bus: joined as @release-2");
    expect(text).toContain("requested name was already taken");
  });

  test("KERYX_BUS=off prints the reason and writes no presence", async () => {
    process.env.KERYX_BUS = "off";
    const output: string[] = [];
    const busBox: { current: BusClient | undefined } = { current: undefined };
    await runShell(
      { lines: linesFrom("/exit"), write: (s) => output.push(s) },
      shellDeps({ cwd, busBox }),
    );
    expect(output.join("")).toContain("bus: off (KERYX_BUS=off)");
    expect(busBox.current).toBeUndefined();
    const { root: busRoot } = await resolveBusRoot(cwd);
    expect(existsSync(path.join(busRoot, "presence"))).toBe(false);
  });
});

describe("runShell bus events and /bus (AC3, AC4, readline chat loop)", () => {
  test("an event addressed to this instance prints one ⇄ line, via displaySafe", async () => {
    const output: string[] = [];
    const busBox: { current: BusClient | undefined } = { current: undefined };
    await runShell(
      {
        lines: (async function* () {
          const bus = busBox.current;
          if (bus === undefined) throw new Error("expected a joined bus");
          // A peer's CLI-origin notice, addressed to this instance by name —
          // delivered without waiting on the real poll interval.
          await sendMessage(bus.root, {
            toLabel: `@${bus.name}`,
            kind: "notice",
            body: "hello from a peer",
            origin: "cli",
            now: Date.now,
            env: {},
          });
          await bus.pollNow();
          yield "/exit";
        })(),
        write: (s) => output.push(s),
      },
      shellDeps({ cwd, busBox }),
    );
    expect(output.join("")).toContain("⇄ [#1] @cli notice: hello from a peer");
  });

  test("/bus send writes an event with origin operator, resolved to the named peer", async () => {
    const { root: busRoot } = await resolveBusRoot(cwd);
    const peer = peerRecord({ name: "release" });
    await writePresence(busRoot, peer);

    const output: string[] = [];
    await runShell(
      { lines: linesFrom("/bus send @release ship it", "/exit"), write: (s) => output.push(s) },
      shellDeps({ cwd }),
    );
    expect(output.join("")).toContain("bus: sent to @release");

    const { events } = await readEvents(busRoot, await cursorAtStart(busRoot));
    const sent = events.find((event) => event.body === "ship it");
    expect(sent).toBeDefined();
    expect(sent?.from.origin).toBe("operator");
    expect(sent?.from.name).toBe("agent-1");
    expect(sent?.to).toEqual([peer.instanceId]);
    expect(sent?.kind).toBe("notice");
  });

  test("the @name shorthand and /bus ask send the right kinds", async () => {
    const { root: busRoot } = await resolveBusRoot(cwd);
    const peer = peerRecord({ name: "release" });
    await writePresence(busRoot, peer);

    const output: string[] = [];
    await runShell(
      { lines: linesFrom("/bus @release quick note", "/bus ask @release question?", "/exit"), write: (s) => output.push(s) },
      shellDeps({ cwd }),
    );
    const { events } = await readEvents(busRoot, await cursorAtStart(busRoot));
    expect(events.find((e) => e.body === "quick note")?.kind).toBe("notice");
    expect(events.find((e) => e.body === "question?")?.kind).toBe("question");
  });

  test("/bus list shows a live peer; /bus with no peers says so", async () => {
    const output1: string[] = [];
    await runShell({ lines: linesFrom("/bus", "/exit"), write: (s) => output1.push(s) }, shellDeps({ cwd }));
    expect(output1.join("")).toContain("no live or stale peers");

    const { root: busRoot } = await resolveBusRoot(cwd);
    await writePresence(busRoot, peerRecord({ name: "release" }));
    const output2: string[] = [];
    await runShell({ lines: linesFrom("/bus list", "/exit"), write: (s) => output2.push(s) }, shellDeps({ cwd }));
    expect(output2.join("")).toContain("@release");
  });

  test("/bus name refuses a name a live peer already holds (D-06)", async () => {
    const { root: busRoot } = await resolveBusRoot(cwd);
    await writePresence(busRoot, peerRecord({ name: "release" }));

    const output: string[] = [];
    await runShell(
      { lines: linesFrom("/bus name release", "/exit"), write: (s) => output.push(s) },
      shellDeps({ cwd }),
    );
    expect(output.join("")).toContain("bus: name-taken");
  });

  test("/bus name renames this instance when the name is free", async () => {
    const output: string[] = [];
    await runShell(
      { lines: linesFrom("/bus name shipper", "/exit"), write: (s) => output.push(s) },
      shellDeps({ cwd }),
    );
    expect(output.join("")).toContain("bus: renamed to @shipper");
  });

  test("a disabled bus reports 'not joined' for /bus rather than throwing", async () => {
    process.env.KERYX_BUS = "off";
    const output: string[] = [];
    await runShell(
      { lines: linesFrom("/bus list", "/exit"), write: (s) => output.push(s) },
      shellDeps({ cwd }),
    );
    expect(output.join("")).toContain("bus: not joined for this session");
  });
});

describe("runShell leave() and session switching (AC6, AC8, readline chat loop)", () => {
  test("/exit removes the presence record", async () => {
    const busBox: { current: BusClient | undefined } = { current: undefined };
    let root_: string | undefined;
    let instanceId: string | undefined;
    await runShell(
      {
        lines: (async function* () {
          const bus = busBox.current;
          if (bus === undefined) throw new Error("expected a joined bus");
          root_ = bus.root;
          instanceId = bus.instanceId;
          expect(existsSync(presencePath(bus.root, bus.instanceId))).toBe(true);
          yield "/exit";
        })(),
        write: () => {},
      },
      shellDeps({ cwd, busBox }),
    );
    expect(root_).toBeDefined();
    expect(existsSync(presencePath(root_ as string, instanceId as string))).toBe(false);
  });

  test("the normal end-of-input return also removes the presence record", async () => {
    const busBox: { current: BusClient | undefined } = { current: undefined };
    await runShell({ lines: linesFrom(), write: () => {} }, shellDeps({ cwd, busBox }));
    // `joinBus` ran (no lines needed for the join itself); `leave()` on the
    // normal return should have already removed it — `leaveBus()` clears the
    // box too, and the presence directory is left holding no live record.
    expect(busBox.current).toBeUndefined();
    const { root: busRoot } = await resolveBusRoot(cwd);
    expect(await listPresence(busRoot)).toHaveLength(0);
  });

  test("/new moves presence.sessionId to the new session", async () => {
    const busBox: { current: BusClient | undefined } = { current: undefined };
    let root_: string | undefined;
    let instanceId: string | undefined;
    let sessionIdAfterNew: string | undefined;
    await runShell(
      {
        lines: (async function* () {
          const bus = busBox.current;
          if (bus === undefined) throw new Error("expected a joined bus");
          root_ = bus.root;
          instanceId = bus.instanceId;
          const before = await readPresence(bus.root, bus.instanceId);
          yield "/new";
          const after = await readPresence(bus.root, bus.instanceId);
          sessionIdAfterNew = after?.sessionId;
          expect(after?.sessionId).not.toBe(before?.sessionId);
          yield "/exit";
        })(),
        write: () => {},
      },
      shellDeps({ cwd, busBox }),
    );
    expect(sessionIdAfterNew).toBeDefined();
    expect(root_).toBeDefined();
    // Gone now (leave() on the normal return) — sessionId tracking is proven
    // by the in-loop assertion above, this just confirms cleanup still ran.
    expect(existsSync(presencePath(root_ as string, instanceId as string))).toBe(false);
  });
});

describe("runShell bus lease getter (F2, review r1)", () => {
  test("/new refreshes the NEW lease's owner.json with the bus name, not a stale released handle", async () => {
    const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
    const busBox: { current: BusClient | undefined } = { current: undefined };
    let nameOnNewLeaseAfterNew: string | null | undefined;
    let leaseChangedIdentity = false;
    await runShell(
      {
        lines: (async function* () {
          if (busBox.current === undefined) throw new Error("expected a joined bus");
          const before = leaseBox.current;
          yield "/new";
          leaseChangedIdentity = leaseBox.current !== before;
          // `setSession` (called by `/new`) refreshes the lease the getter
          // reads NOW — before F2, the client held the OLD (already-swapped)
          // `lease` value captured at join, so this would still read `null`.
          nameOnNewLeaseAfterNew = leaseBox.current?.owner.name;
          yield "/exit";
        })(),
        write: () => {},
      },
      shellDeps({ cwd, leaseBox, busBox }),
    );
    expect(leaseChangedIdentity).toBe(true);
    expect(nameOnNewLeaseAfterNew).toBe("agent-1");
  });
});

describe("runShell /bus reply (F4, review r1)", () => {
  test("replies by #seq and by an id prefix, addressed to the sender's instance id", async () => {
    const busBox: { current: BusClient | undefined } = { current: undefined };
    const peerId = randomUUID();
    const output: string[] = [];
    let busRoot = "";
    let firstId = "";
    await runShell(
      {
        lines: (async function* () {
          const bus = busBox.current;
          if (bus === undefined) throw new Error("expected a joined bus");
          busRoot = bus.root;
          await writePresence(busRoot, peerRecord({ instanceId: peerId, name: "peera" }));
          await sendMessage(busRoot, {
            toLabel: `@${bus.name}`,
            kind: "notice",
            body: "first",
            origin: "operator",
            from: { instanceId: peerId, name: "peera", origin: "operator" },
            now: Date.now,
            env: {},
          });
          await sendMessage(busRoot, {
            toLabel: `@${bus.name}`,
            kind: "notice",
            body: "second",
            origin: "operator",
            from: { instanceId: peerId, name: "peera", origin: "operator" },
            now: Date.now,
            env: {},
          });
          await bus.pollNow();
          const { events } = await readEvents(busRoot, await cursorAtStart(busRoot));
          firstId = events.find((event) => event.body === "first")?.id ?? "";
          yield "/bus reply 1 by seq";
          yield `/bus reply ${firstId.slice(0, 8)} by prefix`;
          yield "/exit";
        })(),
        write: (s) => output.push(s),
      },
      shellDeps({ cwd, busBox }),
    );
    const text = output.join("");
    expect(text).toContain("bus: replied to @peera");
    expect(text.split("bus: replied to @peera").length - 1).toBe(2);
    const { events } = await readEvents(busRoot, await cursorAtStart(busRoot));
    const replies = events.filter((event) => event.kind === "reply");
    expect(replies).toHaveLength(2);
    for (const reply of replies) expect(reply.to).toEqual([peerId]);
  });

  test("a reply still reaches a sender who renamed since; an unknown ref gets a one-line refusal", async () => {
    const busBox: { current: BusClient | undefined } = { current: undefined };
    const peerId = randomUUID();
    const output: string[] = [];
    let busRoot = "";
    await runShell(
      {
        lines: (async function* () {
          const bus = busBox.current;
          if (bus === undefined) throw new Error("expected a joined bus");
          busRoot = bus.root;
          await writePresence(busRoot, peerRecord({ instanceId: peerId, name: "peera" }));
          await sendMessage(busRoot, {
            toLabel: `@${bus.name}`,
            kind: "notice",
            body: "hello",
            origin: "operator",
            from: { instanceId: peerId, name: "peera", origin: "operator" },
            now: Date.now,
            env: {},
          });
          await bus.pollNow();
          // The sender renames; still live, same instance id.
          await writePresence(busRoot, peerRecord({ instanceId: peerId, name: "peerb" }));
          yield "/bus reply 1 still reaches you";
          // A ref matching no rendered message: refused, one line, loop continues.
          yield "/bus reply zzzzzzzz nope";
          yield "/exit";
        })(),
        write: (s) => output.push(s),
      },
      shellDeps({ cwd, busBox }),
    );
    const text = output.join("");
    // Addressed by the ORIGINAL name/label — the reply itself is routed by
    // instance id underneath, proven by `to` below.
    expect(text).toContain("bus: replied to @peera");
    expect(text).toContain('bus: unknown-message: no rendered message matches "zzzzzzzz"');
    const { events } = await readEvents(busRoot, await cursorAtStart(busRoot));
    const reply = events.find((event) => event.kind === "reply");
    expect(reply?.to).toEqual([peerId]);
  });
});

describe("runShell setSession never escapes the loop (F5, review r1)", () => {
  test("a presence write failure during /new does not crash the loop", async () => {
    const busBox: { current: BusClient | undefined } = { current: undefined };
    const output: string[] = [];
    await runShell(
      {
        lines: (async function* () {
          const bus = busBox.current;
          if (bus === undefined) throw new Error("expected a joined bus");
          const dir = presenceDir(bus.root);
          chmodSync(dir, 0o000);
          try {
            yield "/new";
          } finally {
            chmodSync(dir, 0o700); // restore before cleanup removes `root`
          }
          yield "/exit";
        })(),
        write: (s) => output.push(s),
      },
      shellDeps({ cwd, busBox }),
    );
    // The loop survived the failed write: `/new` still completed and `/exit`
    // still ran to a normal return (no exception escaped `runShell`).
    expect(output.join("")).toContain("New session");
  });
});

describe("runShell bus error reporting (F10, review r1)", () => {
  test("a poll failure is reported once and throttled within the window", async () => {
    const busBox: { current: BusClient | undefined } = { current: undefined };
    const output: string[] = [];
    await runShell(
      {
        lines: (async function* () {
          const bus = busBox.current;
          if (bus === undefined) throw new Error("expected a joined bus");
          // Two events in the SAME poll batch: `onEvent` throws for both
          // (the injected `write` below throws on any rendered `⇄` line), so
          // `onError` fires twice in the same tick — proving both the report
          // AND the per-`where` throttle in one deterministic batch, with no
          // reliance on real poll timing.
          await sendMessage(bus.root, { toLabel: `@${bus.name}`, kind: "notice", body: "one", origin: "cli", now: Date.now, env: {} });
          await sendMessage(bus.root, { toLabel: `@${bus.name}`, kind: "notice", body: "two", origin: "cli", now: Date.now, env: {} });
          await bus.pollNow();
          yield "/exit";
        })(),
        write: (s) => {
          if (s.startsWith("⇄")) throw new Error("render failed");
          output.push(s);
        },
      },
      shellDeps({ cwd, busBox }),
    );
    const failLines = output.filter((line) => line.includes("bus: poll failed"));
    expect(failLines).toHaveLength(1);
    expect(failLines[0]).toContain("render failed");
  });
});

// `runAgentRepl` has no injection seam (see this file's own top-of-file doc
// comment and `shell.test.ts`'s SLATE-3a/SLATE-5 audits) — its equivalent
// wiring is proven the same way: by asserting the required literals exist, in
// the required order, in the real source text.
describe("runAgentRepl bus wiring (source-text audit)", () => {
  const shellSource = readFileSync(path.join(import.meta.dir, "shell.ts"), "utf8");
  const replBodyStart = shellSource.indexOf("async function runAgentRepl(");
  const agentModeBranchStart = shellSource.indexOf("if (agentMode) {");
  const replBody = shellSource.slice(replBodyStart, agentModeBranchStart);

  test("joins the bus after the leased session open, before slateSession is set", () => {
    const joinIndex = replBody.indexOf("const joined = await joinBus({");
    const slateIndex = replBody.indexOf("slateSession = live !== undefined");
    expect(joinIndex).toBeGreaterThan(0);
    expect(slateIndex).toBeGreaterThan(joinIndex);
  });

  test("/exit and end-of-input both leave the bus before releasing the lease", () => {
    const exitIndex = replBody.indexOf('if (command === "/exit" || command === "/quit") {');
    const exitBlock = replBody.slice(exitIndex, exitIndex + 400);
    expect(exitBlock.indexOf("leaveBus()")).toBeGreaterThanOrEqual(0);
    expect(exitBlock.indexOf("leaveBus()")).toBeLessThan(exitBlock.indexOf("releaseLease()"));

    const eofIndex = replBody.indexOf("SLATE-5 close trigger: shell exit (end of input");
    const eofBlock = replBody.slice(eofIndex, eofIndex + 400);
    expect(eofBlock.indexOf("leaveBus()")).toBeGreaterThanOrEqual(0);
    expect(eofBlock.indexOf("leaveBus()")).toBeLessThan(eofBlock.indexOf("releaseLease()"));
  });

  test("/new calls bus.setSession before announcing the new session", () => {
    const newIndex = replBody.indexOf('command === "/new" || command === "/clear"');
    const newBlock = replBody.slice(newIndex, newIndex + 1400);
    const setSessionIndex = newBlock.indexOf("await bus?.setSession(live.summary.id);");
    expect(setSessionIndex).toBeGreaterThanOrEqual(0);
    expect(setSessionIndex).toBeLessThan(newBlock.indexOf("New session"));
  });

  test("/bus is dispatched through the shared runBusSlashCommand helper", () => {
    expect(replBody).toContain('if (command === "/bus") {');
    expect(replBody).toContain("await runBusSlashCommand(bus, rest,");
  });

  test("busWorking tracks both the task-notification turn and the operator turn", () => {
    const notificationIndex = replBody.indexOf('origin: "task-notification"');
    const notificationBlock = replBody.slice(notificationIndex - 300, notificationIndex);
    expect(notificationBlock).toContain("busWorking = true;");

    const turnIndex = replBody.indexOf("await runAgentTurn(agentIo, deps, history, line,");
    const turnBlock = replBody.slice(turnIndex - 300, turnIndex);
    expect(turnBlock).toContain("busWorking = true;");
  });
});

// Flow 274 (agent bus P3, T7; specification §5.3, AC1/AC7): delivery to the
// agent in the readline REPL. `runAgentRepl` has no injection seam (see the
// describe block above) — proven the same way as everything else in it.
describe("runAgentRepl bus delivery wiring (flow 274 T7, source-text audit)", () => {
  const shellSource = readFileSync(path.join(import.meta.dir, "shell.ts"), "utf8");
  const replBodyStart = shellSource.indexOf("async function runAgentRepl(");
  const agentModeBranchStart = shellSource.indexOf("if (agentMode) {");
  const replBody = shellSource.slice(replBodyStart, agentModeBranchStart);

  test("a busInbox is created and every polled event is pushed into it, body defaulted", () => {
    // review r1 F10: `onDrop` is now wired to a throttled overflow notice.
    expect(replBody).toContain(
      "const busInbox: BusInbox = createBusInbox({ onDrop: (droppedTotal) => busDropNotifier.onDrop(droppedTotal) });",
    );
    const joinIndex = replBody.indexOf("const joined = await joinBus({");
    expect(joinIndex).toBeGreaterThan(0);
    const eventIdx = replBody.indexOf("onEvent: (event) => {", joinIndex);
    expect(eventIdx).toBeGreaterThan(joinIndex);
    const eventBody = replBody.slice(eventIdx, replBody.indexOf("},", eventIdx));
    expect(eventBody).toContain('busInbox.push({ ...event, body: event.body ?? "" });');
  });

  test("busInbox/busAck are merged onto deps only once the join succeeds, never for a disabled bus", () => {
    const disabledIdx = replBody.indexOf('if ("disabled" in joined) {');
    const successIdx = replBody.indexOf("bus = joined;", disabledIdx);
    expect(disabledIdx).toBeGreaterThan(0);
    expect(successIdx).toBeGreaterThan(disabledIdx);
    const disabledBlock = replBody.slice(disabledIdx, successIdx);
    expect(disabledBlock).not.toContain("busInbox");
    // Widened for review r1 F2's tools-rebuild comment/code ahead of these fields.
    const successBlock = replBody.slice(successIdx, successIdx + 1700);
    expect(successBlock).toContain("busInbox,");
    expect(successBlock).toContain("busAck: (events) => joined.ack(events),");
  });

  test("the join success rebuild folds in busJoined: true for the system instruction", () => {
    const successIdx = replBody.indexOf("bus = joined;");
    // Widened for review r1 F2's tools-rebuild comment/code ahead of these fields.
    const successBlock = replBody.slice(successIdx, successIdx + 1900);
    expect(successBlock).toContain("systemInstruction: buildAgentSystemInstruction(orient, {");
    expect(successBlock).toContain("busJoined: true,");
  });

  // review r1 F2 (AC9): the join-success rebuild now also splices
  // `bus_list`/`bus_send` into `deps.tools` — `agentDepsBase.tools` (built by
  // the CALLER, before any join) never gets them, so this REPL's roster only
  // ever grows them here, once, right after a real join succeeds.
  test("the join success rebuild splices bus_list/bus_send into deps.tools via buildBusTools(() => bus)", () => {
    const successIdx = replBody.indexOf("bus = joined;");
    const successBlock = replBody.slice(successIdx, successIdx + 1900);
    expect(successBlock).toContain("const rebuiltTools = [...deps.tools, ...buildBusTools(() => bus)];");
    expect(successBlock).toContain("tools: rebuiltTools,");
    expect(successBlock).toContain("toolNames: interactiveAgentToolNames(rebuiltTools),");
  });

  test("no idle wake exists for this surface: readLineOrCompletion's completion race stays keyed to jobRegistry only", () => {
    // Specification §5.3: "no idle wake in v1" for readline — `busInbox` is
    // drained only from inside a turn, never used to resolve the
    // `completionWaiters` race that `deps.jobRegistry?.onCompletion` feeds.
    expect(replBody).toContain("deps.jobRegistry?.onCompletion(() => {");
    expect(replBody).not.toContain("busInbox?.onCompletion");
    expect(replBody).not.toMatch(/busInbox[^;]*completionWaiters/);
  });

  test("the prompt announces pending bus messages, replacing every raw rich.printPrompt() call in this REPL", () => {
    const helperIdx = replBody.indexOf("const printPromptWithBusNotice = (): void => {");
    expect(helperIdx).toBeGreaterThan(0);
    const helperBlock = replBody.slice(helperIdx, helperIdx + 300);
    expect(helperBlock).toContain("busInbox.size > 0");
    expect(helperBlock).toContain("message(s) pending — delivered with your next message");
    expect(helperBlock).toContain("rich.printPrompt();");
    // Every OTHER printPrompt call in this REPL goes through the wrapper —
    // the only raw `rich.printPrompt()` left is the one inside it, above.
    const rawCalls = (replBody.match(/rich\.printPrompt\(\)/g) ?? []).length;
    expect(rawCalls).toBe(1);
    const wrapperCalls = (replBody.match(/(?<!const )printPromptWithBusNotice\(\)/g) ?? []).length;
    expect(wrapperCalls).toBeGreaterThanOrEqual(5);
  });

  // review r1 F2 (AC9): `agentDepsBase.tools` (built in the OUTER function,
  // `shellCommand`'s agent-mode branch, BEFORE `runAgentRepl` is even
  // called — outside `replBody`, which stops at that branch's own start
  // marker) no longer passes a `bus` option at all, because `busBox.current`
  // is always still empty at that point — passing it would (correctly) still
  // omit `bus_list`/`bus_send` now that `buildInteractiveAgentTools` gates
  // inclusion on `client() !== undefined` at build time, but leaving the
  // wrapper there read as though it did something. `runAgentRepl`'s own join
  // (tested above) is what actually adds the tools, once, right after it
  // succeeds.
  test("agentDepsBase passes no bus option at all — the tools-rebuild happens only in runAgentRepl's own join", () => {
    const agentModeBranch = shellSource.slice(agentModeBranchStart);
    const toolsIdx = agentModeBranch.indexOf("tools: buildInteractiveAgentTools({");
    expect(toolsIdx).toBeGreaterThan(0);
    const toolsBlock = agentModeBranch.slice(toolsIdx, agentModeBranch.indexOf("}),", toolsIdx));
    expect(toolsBlock).not.toContain("bus:");
    expect(toolsBlock).not.toContain("busBox.current");
    expect(agentModeBranch).toContain("busJoined: busBox.current !== undefined,");
  });
});
