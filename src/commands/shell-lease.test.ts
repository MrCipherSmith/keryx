// Flow 271 T7: readline wiring of the session lease (specification §6.1, §6.2).
// AC2/AC3/AC4/AC6/AC7 (readline halves) and AC10 (flag refusals and help).
// The subprocess proofs (two real shells, SIGKILL/SIGSTOP, SIGTERM) are T10's.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { ProviderPort } from "../harness/provider/types";
import { acquireLeaseSync, type LeaseHandle } from "../lib/fs";
import { createSession, listSessions, persistHistory, type SessionHandle } from "../session";
import {
  openLeasedSession,
  SESSION_LEASE_STALE_MS,
  SessionLeasedError,
  type SessionLeaseHandle,
  type SessionLeaseOwner,
  sessionLeasePath,
} from "../session/lease";
import {
  bareResumeTarget,
  type LeasedChoiceIO,
  parseShellCliFlags,
  resolveLeasedChoice,
  runShell,
  runWithLeaseChoice,
  ShellFlagError,
  shellCommand,
} from "./shell";
import type { ShellDeps, ShellSessionOpts } from "./shell-types";

let root: string;
let cwd: string;
let savedDataDir: string | undefined;
const holders: LeaseHandle<SessionLeaseOwner>[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-shell-lease-"));
  cwd = path.join(root, "project");
  mkdirSync(cwd, { recursive: true });
  savedDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = path.join(root, "data");
});

afterEach(() => {
  for (const holder of holders.splice(0)) holder.release();
  if (savedDataDir === undefined) delete process.env.KERYX_DATA_DIR;
  else process.env.KERYX_DATA_DIR = savedDataDir;
  rmSync(root, { recursive: true, force: true });
});

/** A session with a transcript, so context/archive/summary all exist on disk. */
function makeSession(title: string): SessionHandle {
  const start = Date.now();
  while (Date.now() - start < 3) {
    // distinct updatedAt, so sessions list newest-first deterministically
  }
  const handle = createSession({ cwd, title });
  const history = [
    { role: "user" as const, content: `hello from ${title}` },
    { role: "assistant" as const, content: "hi" },
  ];
  return persistHistory(handle, history, { archive: history });
}

/**
 * Lease `sessionId` with the fs primitive under a fake owner: another instance
 * of this same live pid, so the holder reads LIVE (not gone, not mine).
 */
function holdElsewhere(sessionId: string): SessionLeaseOwner {
  const at = new Date().toISOString();
  const owner: SessionLeaseOwner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    instanceId: randomUUID(),
    name: null,
    acquiredAt: at,
    heartbeatAt: at,
  };
  const result = acquireLeaseSync(sessionLeasePath(cwd, sessionId), owner, { staleMs: SESSION_LEASE_STALE_MS });
  if (!result.ok) throw new Error("fixture: could not lease the holder");
  holders.push(result.handle);
  return owner;
}

/** Byte contents of the three session files AC2 names ("absent" if missing). */
function sessionFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["context.jsonl", "archive.jsonl", "summary.json"]) {
    const full = path.join(dir, name);
    out[name] = existsSync(full) ? readFileSync(full, "utf8") : "absent";
  }
  return out;
}

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

/** A scripted choice prompt: answers in order, then end of input. */
function scriptedChoiceIo(...answers: string[]): LeasedChoiceIO & { output: string } {
  const queue = [...answers];
  const io = {
    output: "",
    write: (text: string) => {
      io.output += text;
    },
    readLine: async () => queue.shift(),
  };
  return io;
}

function leasedError(state: "live" | "stale"): SessionLeasedError {
  const held = makeSession("held");
  return new SessionLeasedError(held.summary, holdElsewhere(held.summary.id), state);
}

describe("--fork / --take-over flag validation (AC10)", () => {
  const refused: Array<[string[], RegExp]> = [
    [["--fork"], /--fork needs an explicit session id; use -r <id> --fork/],
    [["--take-over"], /--take-over needs an explicit session id; use -r <id> --take-over/],
    // The `-r` peek stops at a flag: this is a bare `-r` plus `--take-over`.
    [["-r", "--take-over"], /--take-over needs an explicit session id/],
    [["-r", "--fork"], /--fork needs an explicit session id/],
    [["-r", "abc", "--fork", "--take-over"], /--fork and --take-over cannot be combined/],
    [["-c", "--fork"], /--fork cannot be combined with --continue/],
    [["--take-over", "-c"], /--take-over cannot be combined with --continue/],
  ];
  for (const [args, message] of refused) {
    test(`refuses ${JSON.stringify(args)} with exit code 2 before startup`, async () => {
      let thrown: unknown;
      try {
        parseShellCliFlags(args);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ShellFlagError);
      expect((thrown as ShellFlagError).exitCode).toBe(2);
      expect((thrown as Error).message).toMatch(message);
      expect((thrown as Error).message).toContain("keryx shell --help");

      let started = false;
      await expect(
        shellCommand(args, {
          isTty: true,
          checkVersion: async () => {
            started = true;
            return { status: "up-to-date", currentVersion: "t", latestVersion: "t", source: "cache" };
          },
          launchAgent: async () => {
            started = true;
            return true;
          },
          launchChat: async () => {
            started = true;
            return true;
          },
        }),
      ).rejects.toThrow(message);
      expect(started).toBe(false);
    });
  }

  test("accepts either flag with an explicit id", () => {
    expect(parseShellCliFlags(["-r", "abc", "--fork"])).toMatchObject({ resumeId: "abc", fork: true });
    expect(parseShellCliFlags(["--take-over", "--resume", "abc"])).toMatchObject({ resumeId: "abc", takeOver: true });
    expect(parseShellCliFlags(["-r", "abc"])).not.toHaveProperty("fork");
  });

  test("the real CLI exits 2 on a refused combination", () => {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dir, "../cli.ts"), "shell", "--fork"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      input: "",
      env: {
        PATH: process.env.PATH ?? "",
        NO_COLOR: "1",
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        KERYX_DATA_DIR: path.join(root, "data"),
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--fork needs an explicit session id");
  });

  test("--help documents --fork, --take-over and the new -c / bare -r meaning", async () => {
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
    const help = lines.join("\n");
    expect(help).toContain("--fork");
    expect(help).toContain("--take-over");
    expect(help).toMatch(/--continue, -c\s+Continue the most recent session no other shell has open/);
    expect(help).toContain("Without a TTY, resume without an ID uses the latest\nsession no other shell has open");
  });
});

describe("resolveLeasedChoice (AC3, readline)", () => {
  test("live holder: fork, view and cancel are offered, take over is not", async () => {
    const error = leasedError("live");
    const io = scriptedChoiceIo("");
    expect(await resolveLeasedChoice(io, error)).toBe("fork");
    expect(io.output).toContain("1) fork (default)");
    expect(io.output).toContain("2) view (read-only)");
    expect(io.output).toContain("3) cancel");
    expect(io.output).not.toContain("take over");
    expect(io.output).toContain(`pid ${process.pid}`);
  });

  test("each numbered option maps to its choice", async () => {
    const error = leasedError("live");
    expect(await resolveLeasedChoice(scriptedChoiceIo("1"), error)).toBe("fork");
    expect(await resolveLeasedChoice(scriptedChoiceIo("2"), error)).toBe("view");
    expect(await resolveLeasedChoice(scriptedChoiceIo("3"), error)).toBe("cancel");
    expect(await resolveLeasedChoice(scriptedChoiceIo("view"), error)).toBe("view");
  });

  test("take over is refused as an answer while the holder is live", async () => {
    const io = scriptedChoiceIo("4", "take over");
    // Both answers are rejected; end of input then cancels.
    expect(await resolveLeasedChoice(io, leasedError("live"))).toBe("cancel");
    expect(io.output).toContain("Not one of the choices: 4");
    expect(io.output).toContain("Not one of the choices: take over");
  });

  test("stale holder: take over is offered as option 4", async () => {
    const error = leasedError("stale");
    const io = scriptedChoiceIo("4");
    expect(await resolveLeasedChoice(io, error)).toBe("take-over");
    expect(io.output).toContain("4) take over (the holder is stale)");
    expect(io.output).toContain("(stale)");
    expect(await resolveLeasedChoice(scriptedChoiceIo("take over"), error)).toBe("take-over");
  });

  test("end of input cancels", async () => {
    expect(await resolveLeasedChoice(scriptedChoiceIo(), leasedError("live"))).toBe("cancel");
  });
});

describe("runWithLeaseChoice (AC2/AC3, readline)", () => {
  test("non-TTY -r <id> on a live-held session exits 1 naming --fork and writes nothing", async () => {
    const held = makeSession("held");
    holdElsewhere(held.summary.id);
    const before = sessionFiles(held.dir);
    const stderr: string[] = [];
    const output: string[] = [];

    const code = await runWithLeaseChoice(
      { cwd, resumeId: held.summary.id },
      (session) => runShell({ lines: linesFrom("should never be read"), write: (s) => output.push(s) }, shellDeps(session)),
      {
        isTty: false,
        io: scriptedChoiceIo(),
        writeError: (text) => stderr.push(text),
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("--fork");
    expect(stderr.join("")).toContain(`pid ${process.pid}`);
    expect(sessionFiles(held.dir)).toEqual(before);
    expect(before["context.jsonl"]).not.toBe("absent");
    expect(listSessions(cwd).map((s) => s.id)).toEqual([held.summary.id]);
    expect(output.join("")).toBe("");
  });

  test("TTY fork opens and leases a fork, leaving the held session untouched", async () => {
    const held = makeSession("held");
    holdElsewhere(held.summary.id);
    const before = sessionFiles(held.dir);
    const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
    let leasedDuringRun: SessionLeaseHandle | undefined;

    const code = await runWithLeaseChoice(
      { cwd, resumeId: held.summary.id, leaseBox },
      async (session) => {
        await runShell(
          {
            lines: (async function* () {
              leasedDuringRun = leaseBox.current;
              yield* [];
            })(),
            write: () => {},
          },
          shellDeps(session),
        );
      },
      { isTty: true, io: scriptedChoiceIo("1"), writeError: () => {} },
    );

    expect(code).toBeUndefined();
    expect(leasedDuringRun).toBeDefined();
    expect(leasedDuringRun?.sessionId).not.toBe(held.summary.id);
    // The fork's lease is released on the normal return (AC7).
    expect(leasedDuringRun?.released).toBe(true);
    expect(leaseBox.current).toBeUndefined();
    expect(listSessions(cwd)).toHaveLength(2);
    expect(sessionFiles(held.dir)).toEqual(before);
  });

  test("TTY choices map to the re-open: fork, take over, view then NEW, cancel opens nothing", async () => {
    const error = leasedError("stale");
    const runsFor = async (answer: string): Promise<{ code: number | undefined; runs: ShellSessionOpts[]; out: string }> => {
      const runs: ShellSessionOpts[] = [];
      const io = scriptedChoiceIo(answer);
      const code = await runWithLeaseChoice(
        { cwd, resumeId: error.summary.id },
        async (session) => {
          runs.push(session);
          if (runs.length === 1) throw error;
        },
        { isTty: true, io, writeError: () => {}, exportSession: (_cwd, id) => `# exported ${id}` },
      );
      return { code, runs, out: io.output };
    };

    const fork = await runsFor("1");
    expect(fork.code).toBeUndefined();
    expect(fork.runs[1]).toMatchObject({ cwd, resumeId: error.summary.id, fork: true });

    const takeOver = await runsFor("4");
    expect(takeOver.runs[1]).toMatchObject({ cwd, resumeId: error.summary.id, takeOver: true });
    expect(takeOver.runs[1]).not.toHaveProperty("fork");

    const view = await runsFor("2");
    expect(view.out).toContain(`# exported ${error.summary.id}`);
    expect(view.runs[1]).toEqual({ cwd });

    const cancel = await runsFor("3");
    expect(cancel.code).toBe(0);
    expect(cancel.runs).toHaveLength(1);
  });

  test("errors other than SessionLeasedError propagate unchanged", async () => {
    await expect(
      runWithLeaseChoice(
        { cwd },
        async () => {
          throw new Error("boom");
        },
        { isTty: false, io: scriptedChoiceIo(), writeError: () => {} },
      ),
    ).rejects.toThrow("boom");
  });
});

describe("runShell session lease (AC1/AC6/AC7, readline chat loop)", () => {
  test("-c passes over a held session and names it with the holder pid", async () => {
    const older = makeSession("older");
    const newest = makeSession("newest");
    holdElsewhere(newest.summary.id);
    const output: string[] = [];
    const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
    let opened: string | undefined;

    await runShell(
      {
        lines: (async function* () {
          opened = leaseBox.current?.sessionId;
          yield* [];
        })(),
        write: (s) => output.push(s),
      },
      shellDeps({ cwd, continueLast: true, leaseBox }),
    );

    expect(opened).toBe(older.summary.id);
    const text = output.join("");
    expect(text).toContain("Skipped session");
    expect(text).toContain(`pid ${process.pid}`);
  });

  test("a refused /new keeps the current session and its lease", async () => {
    const output: string[] = [];
    const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
    let calls = 0;
    const refusal = leasedError("live");
    const openLeased: ShellSessionOpts["openLeased"] = (opts) => {
      calls += 1;
      if (calls === 1) return openLeasedSession(opts);
      throw refusal;
    };
    let before: SessionLeaseHandle | undefined;
    let after: SessionLeaseHandle | undefined;
    let releasedAfterRefusal: boolean | undefined;

    await runShell(
      {
        lines: (async function* () {
          before = leaseBox.current;
          yield "/new";
          after = leaseBox.current;
          releasedAfterRefusal = after?.released;
          yield "/exit";
        })(),
        write: (s) => output.push(s),
      },
      shellDeps({ cwd, leaseBox, openLeased }),
    );

    expect(before).toBeDefined();
    expect(after).toBe(before);
    expect(releasedAfterRefusal).toBe(false);
    expect(output.join("")).toContain("Kept the current session.");
    // `/exit` then releases it (AC7).
    expect(before?.released).toBe(true);
    expect(existsSync(before?.lockPath ?? "")).toBe(false);
  });

  test("/new leases the new session before releasing the current one", async () => {
    const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
    let first: SessionLeaseHandle | undefined;
    let second: SessionLeaseHandle | undefined;
    let firstReleased: boolean | undefined;

    await runShell(
      {
        lines: (async function* () {
          first = leaseBox.current;
          yield "/new";
          second = leaseBox.current;
          firstReleased = first?.released;
        })(),
        write: () => {},
      },
      shellDeps({ cwd, leaseBox }),
    );

    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(firstReleased).toBe(true);
    expect(second?.released).toBe(true); // released on the normal return
  });
});

describe("bare -r without a TTY (AC4, readline)", () => {
  test("resolves to the latest session no other shell has open", () => {
    const older = makeSession("older");
    const newest = makeSession("newest");
    holdElsewhere(newest.summary.id);
    const emitted: string[] = [];
    expect(bareResumeTarget(cwd, (text) => emitted.push(text))).toBe(older.summary.id);
    expect(emitted.join("")).toContain("Skipped session");
  });

  test("resolves to the newest session when nothing is held", () => {
    makeSession("older");
    const newest = makeSession("newest");
    const emitted: string[] = [];
    expect(bareResumeTarget(cwd, (text) => emitted.push(text))).toBe(newest.summary.id);
    expect(emitted).toEqual([]);
  });
});

describe("a shell that lost its lease stops saving (review F1)", () => {
  /** A provider that answers every turn with `reply`, then ends the turn. */
  function replyingDeps(session: ShellSessionOpts, reply: string): ShellDeps {
    return {
      ...shellDeps(session),
      makeProvider: () =>
        ({
          stream: async function* () {
            yield { kind: "text_delta", text: reply };
            yield { kind: "model_end" };
          },
        }) as unknown as ProviderPort,
    };
  }

  test("runShell: after a take-over no turn is persisted, and the operator is told once", async () => {
    const leaseBox: { current: SessionLeaseHandle | undefined } = { current: undefined };
    const system: string[] = [];
    let dir: string | undefined;
    let afterFirstTurn: Record<string, string> | undefined;
    let rival: SessionLeaseOwner | undefined;

    await runShell(
      {
        lines: (async function* () {
          yield "first turn";
          const lease = leaseBox.current;
          if (lease === undefined) throw new Error("expected a leased session");
          dir = path.dirname(lease.lockPath);
          afterFirstTurn = sessionFiles(dir);
          // Another shell takes the session over between two turns (as
          // `-r <id> --take-over` does after this one was SIGSTOPped).
          rmSync(lease.lockPath, { recursive: true, force: true });
          rival = holdElsewhere(lease.sessionId);
          yield "second turn";
          yield "third turn";
          yield "/compact";
        })(),
        write: () => {},
        onSystem: (text) => system.push(text),
      },
      replyingDeps({ cwd, leaseBox }, "answer"),
    );

    expect(afterFirstTurn?.["context.jsonl"]).toContain("first turn");
    expect(sessionFiles(dir as string)).toEqual(afterFirstTurn as Record<string, string>);
    const notices = system.filter((line) => line.includes("was taken over by"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`(pid ${process.pid})`);
    expect(notices[0]).toContain("--fork to keep your turns");
    expect(system.join("")).toContain("Not compacted");
    // The shell exits without releasing the lease it lost: the rival keeps it.
    expect(readFileSync(path.join(dir as string, "active.lease", "owner.json"), "utf8")).toContain(
      (rival as SessionLeaseOwner).token,
    );
  });
});
