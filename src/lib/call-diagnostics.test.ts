import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallDiagnostics } from "./call-diagnostics";

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

const MIN = 60_000;

function setup(): { diag: ReturnType<typeof createCallDiagnostics>; clock: ReturnType<typeof fakeClock>; lines: string[] } {
  const clock = fakeClock();
  const lines: string[] = [];
  const diag = createCallDiagnostics({ now: clock.now, sink: (l) => lines.push(l) });
  diag.start({ sessionId: "s", intervalMs: 30_000, stallMs: 10 * MIN, repeatMs: 15 * MIN });
  return { diag, clock, lines };
}

describe("call registry and metrics", () => {
  test("tracks stages, durations and outcomes", () => {
    const { diag, clock } = setup();
    diag.begin("c1", "spawn_subagent");
    clock.advance(1_000);
    diag.stage("c1", "invoke");
    clock.advance(4_000);
    expect(diag.inFlight().map((c) => `${c.id}:${c.stage}`)).toEqual(["c1:invoke"]);
    diag.end("c1", "ok");
    const snap = diag.snapshot("t");
    expect(snap.calls).toEqual([]);
    expect(snap.metrics.callsStarted).toBe(1);
    expect(snap.metrics.callsSettled).toBe(1);
    expect(snap.metrics.callsByOutcome).toEqual({ ok: 1 });
    expect(snap.metrics.stages.start).toEqual({ count: 1, totalMs: 1_000, maxMs: 1_000 });
    expect(snap.metrics.stages.invoke?.maxMs).toBe(4_000);
  });

  test("unknown ids are ignored, events are counted and land in the ring", () => {
    const { diag } = setup();
    diag.stage("nope", "x");
    diag.end("nope", "ok");
    diag.event("approval.rearm", "spawn_subagent#c1");
    diag.event("approval.rearm");
    const snap = diag.snapshot("t");
    expect(snap.metrics.events["approval.rearm"]).toBe(2);
    expect(snap.recent.some((l) => l.endsWith("event approval.rearm spawn_subagent#c1"))).toBe(true);
  });

  test("two in-flight calls with one id keep separate entries", () => {
    const { diag } = setup();
    const a = diag.begin("dup", "spawn_subagent");
    const b = diag.begin("dup", "spawn_subagent");
    expect(a).toBe("dup");
    expect(b).not.toBe(a);
    diag.end(a, "ok");
    expect(diag.inFlight().map((c) => c.id)).toEqual([b]);
    diag.end(b, "ok");
    expect(diag.inFlight()).toEqual([]);
  });

  test("ring buffer is bounded", () => {
    const diag = createCallDiagnostics({ ringSize: 5 });
    for (let i = 0; i < 20; i++) diag.record(`label ${i}`);
    const recent = diag.snapshot("t").recent;
    expect(recent).toHaveLength(5);
    expect(recent[4]?.endsWith("label 19")).toBe(true);
  });
});

describe("probes", () => {
  test("are read at snapshot time; a throwing probe is reported, not thrown", () => {
    const { diag } = setup();
    let depth = 0;
    const off = diag.probe("dock", () => ({ queueDepth: depth }));
    diag.probe("bad", () => {
      throw new Error("boom");
    });
    depth = 3;
    const snap = diag.snapshot("t");
    expect(snap.probes.dock).toEqual({ queueDepth: 3 });
    expect(snap.probes.bad).toEqual({ probeError: "boom" });
    off();
    expect(diag.snapshot("t").probes.dock).toBeUndefined();
  });
});

describe("stall watcher", () => {
  test("a healthy session writes nothing", () => {
    const { diag, clock, lines } = setup();
    diag.begin("c1", "spawn_subagent");
    for (let i = 0; i < 5; i++) {
      clock.advance(30_000);
      diag.tick();
    }
    diag.end("c1", "ok");
    expect(lines).toHaveLength(0);
  });

  test("dumps once when a call sits in one stage past the limit, again only after the repeat window", () => {
    const { diag, clock, lines } = setup();
    diag.begin("c1", "spawn_subagent");
    diag.stage("c1", "invoke");
    diag.probe("dock", () => ({ queueDepth: 9, holderAgeMs: 123 }));
    clock.advance(10 * MIN);
    diag.tick();
    expect(lines).toHaveLength(1);
    const first = JSON.parse(lines[0] as string);
    expect(first.reason).toBe("stall");
    expect(first.calls[0]).toMatchObject({ id: "c1", stage: "invoke" });
    expect(first.probes.dock).toEqual({ queueDepth: 9, holderAgeMs: 123 });
    clock.advance(5 * MIN);
    diag.tick();
    expect(lines).toHaveLength(1);
    diag.begin("c2", "spawn_subagent");
    clock.advance(10 * MIN);
    diag.tick();
    expect(lines).toHaveLength(2);
    clock.advance(15 * MIN);
    diag.tick();
    expect(lines).toHaveLength(3);
  });

  test("a stage change resets the clock, so a slow but moving call is not a stall", () => {
    const { diag, clock, lines } = setup();
    diag.begin("c1", "spawn_subagent");
    for (const s of ["a", "b", "c"]) {
      clock.advance(9 * MIN);
      diag.stage("c1", s);
      diag.tick();
    }
    expect(lines).toHaveLength(0);
  });

  test("a call waiting on the operator is a stall only after three windows", () => {
    const { diag, clock, lines } = setup();
    diag.begin("c1", "spawn_subagent");
    diag.stage("c1", "approval");
    clock.advance(29 * MIN);
    diag.tick();
    expect(lines).toHaveLength(0);
    clock.advance(1 * MIN);
    diag.tick();
    expect(lines).toHaveLength(1);
  });

  test("a call that does not report stages is never judged by its stay in one", () => {
    const { diag, clock, lines } = setup();
    diag.begin("c1", "shell_exec", { watched: false });
    clock.advance(60 * MIN);
    diag.tick();
    expect(lines).toHaveLength(0);
    expect(diag.inFlight()).toHaveLength(1);
  });

  test("records event-loop lag when a tick arrives far later than asked", () => {
    const { diag, clock } = setup();
    clock.advance(30_000 + 7_000);
    diag.tick();
    const snap = diag.snapshot("t");
    expect(snap.loop.lastLagMs).toBe(7_000);
    expect(snap.metrics.maxLoopLagMs).toBe(7_000);
  });
});

describe("file sink", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("creates the file only on the first dump and appends one JSON line per dump", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-diag-"));
    dirs.push(dir);
    const diag = createCallDiagnostics();
    const stop = diag.start({ sessionId: "sess/1", configDir: dir, intervalMs: 3_600_000 });
    expect(diag.dumpPath()).toBeUndefined();
    diag.dump("manual");
    diag.dump("manual");
    stop();
    const file = diag.dumpPath() as string;
    expect(path.dirname(file)).toBe(path.join(dir, "diagnostics"));
    expect(path.basename(file)).toBe("sess_1.ndjson");
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => r.reason)).toEqual(["manual", "manual"]);
    expect(rows[1].metrics.dumps).toBe(2);
  });

  test("stops writing past the size cap", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-diag-"));
    dirs.push(dir);
    const diag = createCallDiagnostics();
    const stop = diag.start({ sessionId: "cap", configDir: dir, intervalMs: 3_600_000, maxFileBytes: 200 });
    for (let i = 0; i < 10; i++) diag.dump("manual");
    stop();
    const lines = readFileSync(diag.dumpPath() as string, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(10);
    // a dump the sink refused is reported as not written
    expect(diag.dump("manual")).toBeUndefined();
  });
});
