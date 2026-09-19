// Flow 271 (agent bus P0), the TUI halves of AC3, AC4, AC6 and AC7.
//
// Pure helpers and seams, driven without a renderer: the held-session choice
// and its handling, the picker / Session Switcher markers, the switch through
// the lease holder, and the release on the TUI's exit paths.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { runLeasedChatShell } from "../commands/shell";
import type { ShellDeps, ShellIO, ShellSessionOpts } from "../commands/shell-types";
import {
  openLeasedSession,
  SessionLeasedError,
  type SessionLeaseOwner,
  type SessionLeaseState,
  sessionLeasePath,
} from "../session/lease";
import { leasedChoiceRows } from "../session/lease-choice";
import { createSession, type SessionHandle } from "../session/store";
import { sessionPickerOptions, startupSessionChoices } from "./tui-shell";
import {
  createTuiLeaseHolder,
  leasedChoiceRequest,
  leaseMarker,
  leaseStateLookup,
  resolveLeasedStartup,
  toLeasedChoice,
  withLeaseMarker,
} from "./tui-session-lease";

let root: string;
let cwd: string;
let dataDir: string;
const leases: Array<{ release(): void }> = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-tui-lease-"));
  cwd = path.join(root, "project");
  dataDir = path.join(root, "data");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  rmSync(root, { recursive: true, force: true });
});

function makeSession(title: string): SessionHandle {
  const start = Date.now();
  while (Date.now() - start < 3) {
    // distinct updatedAt
  }
  return createSession({ cwd, dataDir, title });
}

/** A holder from ANOTHER instance, planted with fs as that process would write it. */
function plantHolder(sessionId: string, overrides: Partial<SessionLeaseOwner> = {}): void {
  const at = new Date().toISOString();
  const holder: SessionLeaseOwner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: 424242,
    host: hostname(),
    instanceId: randomUUID(),
    name: null,
    acquiredAt: at,
    heartbeatAt: at,
    ...overrides,
  };
  const lockPath = sessionLeasePath(cwd, sessionId, dataDir);
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(holder), { mode: 0o600 });
}

/** Stale per D-09: an old heartbeat, same host, and a pid that is alive (this one). */
function plantStaleHolder(sessionId: string): void {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  plantHolder(sessionId, { pid: process.pid, acquiredAt: old, heartbeatAt: old });
}

function leasedError(session: SessionHandle): SessionLeasedError {
  try {
    openLeasedSession({ cwd, dataDir, resumeId: session.summary.id });
  } catch (error) {
    if (error instanceof SessionLeasedError) return error;
    throw error;
  }
  throw new Error("expected the open to be refused");
}

function open(target: { resumeId?: string; fork?: boolean; takeOver?: boolean } = {}) {
  const opened = openLeasedSession({ cwd, dataDir, ...target });
  leases.push(opened.lease);
  return opened;
}

function listFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name === "active.lease") continue;
    const full = path.join(dir, name);
    out[name] = statSync(full).isDirectory() ? "dir" : readFileSync(full, "utf8");
  }
  return out;
}

describe("AC3 (TUI) — the held-session choice", () => {
  test("a live holder offers fork (recommended), view and cancel; never take over", () => {
    const held = makeSession("held live");
    plantHolder(held.summary.id);
    const request = leasedChoiceRequest(leasedError(held));
    expect(request.options.map((option) => option.id)).toEqual(["fork", "view", "cancel"]);
    expect(request.options.filter((option) => option.recommended === true).map((option) => option.id)).toEqual(["fork"]);
    expect(request.cancelId).toBe("cancel");
    expect(request.title).toContain("is open in instance");
  });

  test("a stale holder also offers take over; the list is the readline prompt's list", () => {
    const held = makeSession("held stale");
    plantStaleHolder(held.summary.id);
    const error = leasedError(held);
    expect(error.state).toBe("stale");
    const request = leasedChoiceRequest(error);
    expect(request.options.map((option) => option.id)).toEqual(["fork", "view", "cancel", "take-over"]);
    expect(request.options.map((option) => option.id)).toEqual(leasedChoiceRows(error).map((row) => row.choice));
    expect(request.title).toContain("(stale)");
  });

  test("an answer that was not offered cancels (Esc, or take over against a live holder)", () => {
    const held = makeSession("held");
    plantHolder(held.summary.id);
    const error = leasedError(held);
    expect(toLeasedChoice(error, "take-over")).toBe("cancel");
    expect(toLeasedChoice(error, undefined)).toBe("cancel");
    expect(toLeasedChoice(error, "view")).toBe("view");
  });

  test("fork opens a fork of the held session and leases it; the held session is not touched", async () => {
    const held = makeSession("held");
    plantHolder(held.summary.id);
    const before = listFiles(held.dir);
    const outcome = await resolveLeasedStartup(leasedError(held), {
      choose: async () => "fork",
      open,
      exportSession: () => "",
      showReadOnly: () => {},
      notice: () => {},
    });
    expect(outcome.kind).toBe("opened");
    if (outcome.kind !== "opened") return;
    expect(outcome.opened.handle.summary.id).not.toBe(held.summary.id);
    expect(outcome.opened.handle.summary.parentSessionId).toBe(held.summary.id);
    expect(outcome.opened.lease.released).toBe(false);
    expect(existsSync(sessionLeasePath(cwd, outcome.opened.handle.summary.id, dataDir))).toBe(true);
    expect(listFiles(held.dir)).toEqual(before);
  });

  test("take over (stale) re-opens the same session with takeOver", async () => {
    const held = makeSession("held stale");
    plantStaleHolder(held.summary.id);
    const targets: unknown[] = [];
    const outcome = await resolveLeasedStartup(leasedError(held), {
      choose: async () => "take-over",
      open: (target) => {
        targets.push(target);
        return open(target);
      },
      exportSession: () => "",
      showReadOnly: () => {},
      notice: () => {},
    });
    expect(targets).toEqual([{ resumeId: held.summary.id, takeOver: true }]);
    expect(outcome.kind === "opened" && outcome.opened.handle.summary.id).toBe(held.summary.id);
  });

  test("view renders the held session read-only, then opens a NEW session", async () => {
    const held = makeSession("held");
    plantHolder(held.summary.id);
    const shown: string[] = [];
    const exported: string[] = [];
    const targets: unknown[] = [];
    const outcome = await resolveLeasedStartup(leasedError(held), {
      choose: async () => "view",
      open: (target) => {
        targets.push(target);
        return open(target);
      },
      exportSession: (id) => {
        exported.push(id);
        return `# transcript of ${id}`;
      },
      showReadOnly: (markdown) => shown.push(markdown),
      notice: () => {},
    });
    expect(exported).toEqual([held.summary.id]);
    expect(shown).toEqual([`# transcript of ${held.summary.id}`]);
    expect(targets).toEqual([{}]);
    expect(outcome.kind === "opened" && outcome.opened.handle.summary.id).not.toBe(held.summary.id);
  });

  test("view whose render fails says so and still starts a new session", async () => {
    const held = makeSession("held");
    plantHolder(held.summary.id);
    const notices: string[] = [];
    const outcome = await resolveLeasedStartup(leasedError(held), {
      choose: async () => "view",
      open,
      exportSession: () => {
        throw new Error("unreadable");
      },
      showReadOnly: () => {},
      notice: (text) => notices.push(text),
    });
    expect(notices).toEqual(["Could not render the session: unreadable"]);
    expect(outcome.kind).toBe("opened");
  });

  test("cancel opens nothing", async () => {
    const held = makeSession("held");
    plantHolder(held.summary.id);
    let opens = 0;
    const outcome = await resolveLeasedStartup(leasedError(held), {
      choose: async () => "cancel",
      open: () => {
        opens += 1;
        return open();
      },
      exportSession: () => "",
      showReadOnly: () => {},
      notice: () => {},
    });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(opens).toBe(0);
  });

  test("a take-over refused again asks again with the new refusal", async () => {
    const held = makeSession("held");
    plantStaleHolder(held.summary.id);
    const first = leasedError(held);
    // The holder comes back to life before the take-over lands.
    plantHolder(held.summary.id);
    const seen: Array<"live" | "stale"> = [];
    const answers = ["take-over", "cancel"] as const;
    const notices: string[] = [];
    const outcome = await resolveLeasedStartup(first, {
      choose: async (error) => {
        seen.push(error.state);
        return answers[seen.length - 1] ?? "cancel";
      },
      open,
      exportSession: () => "",
      showReadOnly: () => {},
      notice: (text) => notices.push(text),
    });
    expect(seen).toEqual(["stale", "live"]);
    expect(notices[0]).toContain("--take-over is refused");
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  test("an error that is not a lease refusal propagates to the caller's new-session fallback", async () => {
    const held = makeSession("held");
    plantHolder(held.summary.id);
    const run = resolveLeasedStartup(leasedError(held), {
      choose: async () => "fork",
      open: () => {
        throw new Error("disk full");
      },
      exportSession: () => "",
      showReadOnly: () => {},
      notice: () => {},
    });
    await expect(run).rejects.toThrow("disk full");
  });
});

describe("AC3 (chat TUI) — a held -r <id> offers the choice instead of ending the shell", () => {
  function chatIo(answers: string[], system: string[]): ShellIO {
    return {
      lines: {
        async *[Symbol.asyncIterator]() {
          for (const answer of answers) yield answer;
        },
      },
      write: () => {},
      onSystem: (text) => system.push(text),
    };
  }

  function chatDeps(session: ShellSessionOpts): ShellDeps {
    return { session } as unknown as ShellDeps;
  }

  test("fork re-runs the driver on a fork of the held id; notes are shown first", async () => {
    const held = makeSession("held");
    plantHolder(held.summary.id);
    const error = leasedError(held);
    const system: string[] = [];
    const sessions: ShellSessionOpts[] = [];
    const code = await runLeasedChatShell(
      chatIo(["1"], system),
      chatDeps({ cwd, resumeId: held.summary.id }),
      async (_io, deps) => {
        sessions.push(deps.session as ShellSessionOpts);
        if (sessions.length === 1) throw error;
      },
      ["Skipped session x\n"],
    );
    expect(code).toBeUndefined();
    expect(system[0]).toBe("Skipped session x\n");
    expect(system.join("")).toContain("1) fork (default)");
    expect(sessions[1]).toMatchObject({ resumeId: held.summary.id, fork: true });
  });

  test("cancel returns exit code 0 and never re-runs the driver", async () => {
    const held = makeSession("held");
    plantHolder(held.summary.id);
    const error = leasedError(held);
    let runs = 0;
    const code = await runLeasedChatShell(chatIo(["3"], []), chatDeps({ cwd, resumeId: held.summary.id }), async () => {
      runs += 1;
      throw error;
    });
    expect(code).toBe(0);
    expect(runs).toBe(1);
  });
});

describe("AC4 (TUI) — picker and Session Switcher mark held rows", () => {
  const states: Record<string, SessionLeaseState> = { a: "free", b: "mine", c: "live", d: "stale" };
  const lookup = (id: string): SessionLeaseState => states[id] ?? "free";

  function summary(id: string) {
    return {
      ...createSession({ cwd, dataDir, title: `title ${id}` }).summary,
      id,
    };
  }

  test("markers: live and stale only", () => {
    expect(leaseMarker("live")).toBe("● live");
    expect(leaseMarker("stale")).toBe("◌ stale");
    expect(leaseMarker("mine")).toBe("");
    expect(leaseMarker("free")).toBe("");
    expect(withLeaseMarker("x", "free")).toBe("x");
  });

  test("the Session Switcher labels live/stale rows and leaves mine/free unmarked", () => {
    const rows = sessionPickerOptions(["a", "b", "c", "d"].map(summary), lookup);
    expect(rows.map((row) => row.label)).toEqual([
      "a · title a",
      "b · title b",
      "c · title c  ● live",
      "d · title d  ◌ stale",
    ]);
  });

  test("the startup picker labels the same rows, after New session", () => {
    const options = startupSessionChoices(["a", "b", "c", "d"].map(summary), lookup);
    expect(options.map((option) => option.label)).toEqual([
      "New session",
      "title a",
      "title b",
      "title c  ● live",
      "title d  ◌ stale",
    ]);
  });

  test("the production lookup reads free, mine, live and stale from the lease on disk", () => {
    const free = makeSession("free");
    const mine = open({ resumeId: makeSession("mine").summary.id });
    const live = makeSession("live");
    plantHolder(live.summary.id);
    const stale = makeSession("stale");
    plantStaleHolder(stale.summary.id);
    const state = leaseStateLookup(cwd, dataDir);
    expect(state(free.summary.id)).toBe("free");
    expect(state(mine.handle.summary.id)).toBe("mine");
    expect(state(live.summary.id)).toBe("live");
    expect(state(stale.summary.id)).toBe("stale");
  });
});

describe("AC6 (TUI) — switches acquire the target before releasing the current lease", () => {
  test("/resume to a held session is refused and the current session keeps its lease", () => {
    const holder = createTuiLeaseHolder();
    const current = openLeasedSession({ cwd, dataDir });
    holder.hold(current.lease);
    const held = makeSession("held");
    plantHolder(held.summary.id);

    expect(() => holder.switchTo(() => openLeasedSession({ cwd, dataDir, resumeId: held.summary.id }))).toThrow(
      SessionLeasedError,
    );
    expect(holder.current).toBe(current.lease);
    expect(current.lease.released).toBe(false);
    expect(existsSync(sessionLeasePath(cwd, current.handle.summary.id, dataDir))).toBe(true);
    holder.release();
  });

  test("a successful switch (/resume, /new) takes the target lease and then releases the old one", () => {
    const holder = createTuiLeaseHolder();
    const first = openLeasedSession({ cwd, dataDir });
    holder.hold(first.lease);
    const target = makeSession("target");

    const next = holder.switchTo(() => openLeasedSession({ cwd, dataDir, resumeId: target.summary.id }));
    expect(holder.current).toBe(next.lease);
    expect(first.lease.released).toBe(true);
    expect(existsSync(sessionLeasePath(cwd, first.handle.summary.id, dataDir))).toBe(false);
    expect(existsSync(sessionLeasePath(cwd, target.summary.id, dataDir))).toBe(true);

    const fresh = holder.switchTo(() => openLeasedSession({ cwd, dataDir }));
    expect(next.lease.released).toBe(true);
    expect(holder.current).toBe(fresh.lease);
    holder.release();
  });

  test("switching to the session already held releases nothing", () => {
    const holder = createTuiLeaseHolder();
    const first = openLeasedSession({ cwd, dataDir });
    holder.hold(first.lease);
    holder.switchTo(() => openLeasedSession({ cwd, dataDir, resumeId: first.handle.summary.id }));
    expect(first.lease.released).toBe(false);
    holder.release();
  });
});

describe("AC7 (TUI) — the lease is released on every exit path", () => {
  test("release removes the lease directory and is idempotent", () => {
    const holder = createTuiLeaseHolder();
    const opened = openLeasedSession({ cwd, dataDir });
    holder.hold(opened.lease);
    const lockPath = sessionLeasePath(cwd, opened.handle.summary.id, dataDir);
    expect(existsSync(lockPath)).toBe(true);
    holder.release();
    holder.release();
    expect(existsSync(lockPath)).toBe(false);
    expect(holder.current).toBeUndefined();
  });

  // Source-text audit, the style `tui-shell.test.ts` uses for exit paths: the
  // TUI's `onDestroy` and `/exit` cannot run without a real terminal.
  const source = readFileSync(path.join(import.meta.dir, "tui-shell.ts"), "utf8");

  test("onDestroy (Ctrl+C) releases the lease synchronously", () => {
    const start = source.indexOf("onDestroy: () => {");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("void (async () => {", start));
    expect(body).toContain("sessionLease.release();");
  });

  test("/exit and the busy-menu exit release the lease before destroying the renderer", () => {
    for (const marker of ['if (command.name === "/exit") {', 'case "exit": {']) {
      const start = source.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      const block = source.slice(start, source.indexOf("r.destroy();", start));
      expect(block).toContain("sessionLease.release();");
    }
  });

  test("the outer finally releases the lease", () => {
    const tail = source.slice(source.lastIndexOf("} finally {"));
    expect(tail).toContain("sessionLease.release();");
  });

  test("no startup open bypasses the lease", () => {
    expect(source).not.toMatch(/[^.\w]openSession\(/);
    expect(source).not.toMatch(/[^.\w]createSession\(/);
  });
});

describe("the TUI lease holder after a take-over (review F1)", () => {
  test("canPersist turns false and the listener hears it once; /new's lease is watched afresh", () => {
    const holder = createTuiLeaseHolder();
    const notes: string[] = [];
    holder.onLost((message) => notes.push(message));
    const first = holder.switchTo(() => openLeasedSession({ cwd, dataDir }));
    expect(holder.canPersist()).toBe(true);

    // Another shell takes the session over: the lease directory is replaced.
    rmSync(first.lease.lockPath, { recursive: true, force: true });
    plantHolder(first.handle.summary.id);

    expect(holder.canPersist()).toBe(false);
    expect(holder.canPersist()).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("this shell no longer saves it");

    // Leaving the lost session for a new one: the lost lease is not released
    // (it is not ours), and the new one persists.
    const second = holder.switchTo(() => openLeasedSession({ cwd, dataDir }));
    leases.push(second.lease);
    expect(holder.canPersist()).toBe(true);
    expect(existsSync(first.lease.lockPath)).toBe(true);
    expect(notes).toHaveLength(1);
  });
});

describe("TUI slate getters go through the lease gate (review r2 N1, source-text audit)", () => {
  const source = readFileSync(path.join(import.meta.dir, "tui-shell.ts"), "utf8");

  test("no slate getter or slate dir read bypasses liveSlateSession", () => {
    expect(source).toContain("whilePersisting(slateSession, () => sessionLease.canPersist())");
    expect(source).not.toContain("() => slateSession)");
    expect(source).not.toContain("slateSession?.dir");
    expect(source.match(/makeAgentDeps\([^)]*, liveSlateSession\)/g)?.length).toBe(3);
  });
});
