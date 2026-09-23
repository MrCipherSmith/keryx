// Bounded retention of what an external child writes (flow 292 T14).
//
// The per-line ceiling does not stop a child that writes endless ORDINARY
// lines. These tests pin the per-RUN bounds: a diagnostic stream keeps a head
// and a tail and counts what it dropped; what the run produces is budgeted and
// passing the budget fails the run with a named reason. Assertions are on the
// retained sizes and dropped counts the code reports — not on RSS.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { superviseAcpRun, type SuperviseAcpInput } from "./acp-client";
import { clampForeignMode } from "./acp-permission";
import { BoundedTranscript, DIAGNOSTIC_HEAD_BYTES, DIAGNOSTIC_TAIL_BYTES, OutputBudget } from "./bounded";
import { createBunSpawnPort, type BunSpawnLike } from "./bun-spawn-port";
import { superviseExternalRun, type ExternalSpawnPort, type SpawnedProcess } from "./supervise";
import type { ExternalAgentCodec } from "./types";

const FAKE_AGENT = fileURLToPath(new URL("../../../fixtures/external/acp/fake-acp-agent.ts", import.meta.url));
const MARKER_SLACK = 200;

let root = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-bounded-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function acpInput(overrides: Partial<SuperviseAcpInput> = {}): SuperviseAcpInput {
  return {
    argv: ["agent"],
    cwd: root,
    env: {},
    prompt: "p",
    mcpServers: [],
    write: false,
    timeoutMs: 30_000,
    killGraceMs: 200,
    permission: { mode: clampForeignMode("ask"), unattended: true },
    ...overrides,
  };
}

/** A process whose stderr floods and whose stdout ends only once the flood is done. */
function stderrFloodPort(lines: number, lineChars: number): { port: ExternalSpawnPort; written: () => number } {
  let total = 0;
  const port: ExternalSpawnPort = {
    spawn(): SpawnedProcess {
      let floodDone: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        floodDone = resolve;
      });
      const line = "e".repeat(lineChars);
      return {
        stderr: (async function* () {
          for (let i = 0; i < lines; i += 1) {
            total += line.length + 1;
            yield line;
          }
          floodDone();
        })(),
        stdout: (async function* () {
          await done;
        })(),
        writeStdin: () => undefined,
        kill: () => undefined,
        exited: done.then(() => 0),
      };
    },
  };
  return { port, written: () => total };
}

describe("BoundedTranscript", () => {
  test("keeps the head and the tail, drops the middle, and counts it", () => {
    const t = new BoundedTranscript(100, 200);
    for (let i = 0; i < 1000; i += 1) t.push(`line-${String(i).padStart(4, "0")}`);
    expect(t.retainedBytes).toBeLessThanOrEqual(300);
    expect(t.droppedBytes).toBe(1000 * 10 - t.retainedBytes);
    const text = t.text();
    expect(text.startsWith("line-0000")).toBe(true);
    expect(text.endsWith("line-0999")).toBe(true);
    expect(text).toContain("dropped from the middle");
  });

  test("a single line bigger than the tail keeps only its own end", () => {
    const t = new BoundedTranscript(0, 50);
    t.push(`${"a".repeat(1000)}THE-END`);
    expect(t.retainedBytes).toBeLessThanOrEqual(50);
    expect(t.text().endsWith("THE-END")).toBe(true);
  });

  test("OutputBudget answers false once the ceiling is passed", () => {
    const b = new OutputBudget(10);
    expect(b.add(10)).toBe(true);
    expect(b.add(1)).toBe(false);
  });
});

describe("ACP client — the run's retention is bounded", () => {
  test("a stderr flood keeps only a bounded head and tail, with the dropped bytes counted", async () => {
    const flood = stderrFloodPort(3_000, 10_000);
    const outcome = await superviseAcpRun(acpInput(), { spawn: flood.port });
    const bound = DIAGNOSTIC_HEAD_BYTES + DIAGNOSTIC_TAIL_BYTES;
    expect(flood.written()).toBeGreaterThan(29_000_000);
    expect(outcome.stderr.length).toBeLessThanOrEqual(bound + MARKER_SLACK);
    expect(outcome.stderrDroppedBytes).toBeGreaterThan(flood.written() - bound - MARKER_SLACK);
    expect(outcome.stderr).toContain("dropped from the middle");
  });

  test(
    "a stdout flood of message chunks fails the run with the named reason and kills the agent",
    async () => {
      const log = path.join(root, "agent.log.jsonl");
      const scenario = path.join(root, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({ log, steps: Array.from({ length: 400 }, () => ({ say: "x".repeat(1_000) })) }),
      );
      const outcome = await superviseAcpRun(
        acpInput({ argv: [process.execPath, FAKE_AGENT, scenario], maxOutputBytes: 20_000 }),
        { spawn: createBunSpawnPort() },
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.failure).toContain("more than 20000 bytes of output in one run");
      expect(outcome.killed).toBe(true);
      expect(outcome.assistantText.length).toBeLessThanOrEqual(20_000);
      expect(outcome.events.at(-1)).toMatchObject({ kind: "child_failed" });
    },
    60_000,
  );

  test("a stderr line past the line ceiling is the run's named reason, not a stdout symptom", async () => {
    let killed = 0;
    let release: () => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      release = () => resolve(137);
    });
    const impl: BunSpawnLike = () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          // Open until killed, like a live agent's stdout.
          void exited.then(() => controller.close());
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("s".repeat(5_000)));
        },
      }),
      stdin: { write: () => undefined },
      exited,
      kill: () => {
        killed += 1;
        release();
      },
    });
    const outcome = await superviseAcpRun(acpInput(), { spawn: createBunSpawnPort(impl, { maxLineBytes: 1_024 }) });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure).toContain("stderr sent more than 1024 bytes without a newline");
    expect(outcome.failure).not.toContain("closed its stdout");
    expect(killed).toBeGreaterThanOrEqual(1);
  });
});

describe("line-stream supervisor (claude/codex share it) — the same bounds", () => {
  const textCodec: ExternalAgentCodec = {
    id: "test",
    buildArgv: () => ["x"],
    parseLine: (line) => ({ kind: "assistant_text", text: line }),
    classifyFailure: () => null,
    buildResumeArgv: () => ["x"],
  };

  function linesPort(stdout: () => AsyncIterable<string>, stderr: () => AsyncIterable<string>): { port: ExternalSpawnPort; kills: () => number } {
    let kills = 0;
    return {
      kills: () => kills,
      port: {
        spawn(): SpawnedProcess {
          return { stdout: stdout(), stderr: stderr(), writeStdin: () => undefined, kill: () => { kills += 1; }, exited: Promise.resolve(0) };
        },
      },
    };
  }

  test("an event flood passes the output budget: named reason, child killed, events bounded", async () => {
    const p = linesPort(
      async function* () {
        for (let i = 0; i < 1_000; i += 1) yield "y".repeat(1_000);
      },
      async function* () {},
    );
    const outcome = await superviseExternalRun(
      { argv: ["x"], cwd: root, env: {}, prompt: "", timeoutMs: 30_000, maxOutputBytes: 20_000 },
      { spawn: p.port, codec: textCodec },
    );
    expect(outcome.overflow).toContain("more than 20000 bytes of output in one run");
    expect(p.kills()).toBe(1);
    expect(outcome.events.length).toBeLessThan(25);
  });

  test("stderr and raw stdout keep a bounded head and tail, with dropped bytes counted", async () => {
    const p = linesPort(
      async function* () {
        for (let i = 0; i < 2_000; i += 1) yield "o".repeat(1_000);
      },
      async function* () {
        for (let i = 0; i < 2_000; i += 1) yield "e".repeat(1_000);
      },
    );
    const outcome = await superviseExternalRun(
      { argv: ["x"], cwd: root, env: {}, prompt: "", timeoutMs: 30_000, maxOutputBytes: 100_000_000 },
      { spawn: p.port, codec: textCodec },
    );
    expect(outcome.stderr.length).toBeLessThanOrEqual(DIAGNOSTIC_HEAD_BYTES + DIAGNOSTIC_TAIL_BYTES + MARKER_SLACK);
    expect(outcome.droppedBytes?.stderr).toBeGreaterThan(1_900_000);
    expect(outcome.stdout.length).toBeLessThanOrEqual(1024 * 1024 + MARKER_SLACK);
    expect(outcome.droppedBytes?.stdout).toBeGreaterThan(900_000);
    expect(outcome.overflow).toBeUndefined();
  });
});
