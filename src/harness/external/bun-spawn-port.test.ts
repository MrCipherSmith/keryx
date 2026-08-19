// Tests for the real spawn port's framing and teardown (flow 176, T14).
// No operating-system process is created: `Bun.spawn` itself is substituted, so
// what is under test is this file's line framing and stdin discipline.
import { describe, expect, test } from "bun:test";
import { createBunSpawnPort, type BunSpawnLike } from "./bun-spawn-port";

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

interface Recorded {
  argv: readonly string[];
  opts: { cwd: string; env: Record<string, string>; stdin: string; stdout: string; stderr: string };
}

function fakeBun(
  stdoutChunks: readonly string[],
  stderrChunks: readonly string[] = [],
  exitCode = 0,
): { impl: BunSpawnLike; calls: Recorded[]; written: string[]; killed: () => number } {
  const calls: Recorded[] = [];
  const written: string[] = [];
  let kills = 0;
  const impl: BunSpawnLike = (argv, opts) => {
    calls.push({ argv, opts });
    return {
      stdout: streamOf(stdoutChunks),
      stderr: streamOf(stderrChunks),
      stdin: { write: (t: string) => written.push(t) },
      exited: Promise.resolve(exitCode),
      kill: () => {
        kills += 1;
      },
    };
  };
  return { impl, calls, written, killed: () => kills };
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of iterable) out.push(line);
  return out;
}

const OPTS = { cwd: "/wt/x", env: { PATH: "/usr/bin" }, stdin: "ignore" as const };

describe("line framing", () => {
  test("reassembles a line split across read chunks", async () => {
    // claude's `system/init` is multiple KB because it enumerates the tool roster
    // and every slash command, so it spans chunks by construction.
    const fake = fakeBun(['{"type":"sys', 'tem","subtype":"init"}\n{"type":"result"}\n']);
    const proc = createBunSpawnPort(fake.impl).spawn(["claude"], OPTS);
    expect(await collect(proc.stdout)).toEqual(['{"type":"system","subtype":"init"}', '{"type":"result"}']);
  });

  test("yields a final line that has no trailing newline", async () => {
    // Dropping it would silently lose the terminal event of any CLI that does
    // not end its stream with one.
    const fake = fakeBun(['{"type":"turn.completed"}']);
    const proc = createBunSpawnPort(fake.impl).spawn(["codex"], OPTS);
    expect(await collect(proc.stdout)).toEqual(['{"type":"turn.completed"}']);
  });

  test("strips a carriage return so CRLF output still parses as JSON", async () => {
    const fake = fakeBun(['{"a":1}\r\n{"b":2}\r\n']);
    const proc = createBunSpawnPort(fake.impl).spawn(["codex"], OPTS);
    const lines = await collect(proc.stdout);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });

  test("does not split a multi-byte character across chunks", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("привет 🎉\n");
    const half = Math.floor(bytes.length / 2);
    const impl: BunSpawnLike = () => ({
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(bytes.slice(0, half));
          c.enqueue(bytes.slice(half));
          c.close();
        },
      }),
      stderr: streamOf([]),
      exited: Promise.resolve(0),
      kill: () => undefined,
    });
    const proc = createBunSpawnPort(impl).spawn(["codex"], OPTS);
    expect(await collect(proc.stdout)).toEqual(["привет 🎉"]);
  });

  test("an empty stream yields no lines rather than one empty line", async () => {
    const fake = fakeBun([]);
    const proc = createBunSpawnPort(fake.impl).spawn(["codex"], OPTS);
    expect(await collect(proc.stdout)).toEqual([]);
  });

  test("blank lines inside the stream are preserved for the caller to skip", async () => {
    const fake = fakeBun(["a\n\nb\n"]);
    const proc = createBunSpawnPort(fake.impl).spawn(["codex"], OPTS);
    expect(await collect(proc.stdout)).toEqual(["a", "", "b"]);
  });

  test("stderr is framed the same way", async () => {
    const fake = fakeBun([], ["error: unexpected argument\nUsage: codex exec\n"]);
    const proc = createBunSpawnPort(fake.impl).spawn(["codex"], OPTS);
    expect(await collect(proc.stderr)).toEqual(["error: unexpected argument", "Usage: codex exec"]);
  });

  test("a missing stream yields nothing instead of throwing", async () => {
    const impl: BunSpawnLike = () => ({
      stdout: undefined,
      stderr: undefined,
      exited: Promise.resolve(0),
      kill: () => undefined,
    });
    const proc = createBunSpawnPort(impl).spawn(["codex"], OPTS);
    expect(await collect(proc.stdout)).toEqual([]);
  });
});

describe("process options", () => {
  test("stdin is passed through and never inherited", async () => {
    const fake = fakeBun([]);
    createBunSpawnPort(fake.impl).spawn(["codex"], OPTS);
    expect(fake.calls[0]?.opts.stdin).toBe("ignore");
    // The union has no `"inherit"` member; this asserts the value that reaches
    // the OS, which is where the guarantee becomes real.
    expect(fake.calls[0]?.opts.stdin).not.toBe("inherit");
  });

  test("pipe mode is forwarded and writeStdin reaches the child", async () => {
    const fake = fakeBun([]);
    const proc = createBunSpawnPort(fake.impl).spawn(["claude"], { ...OPTS, stdin: "pipe" });
    proc.writeStdin('{"type":"user"}\n');
    expect(fake.calls[0]?.opts.stdin).toBe("pipe");
    expect(fake.written).toEqual(['{"type":"user"}\n']);
  });

  test("writeStdin on a run with no stdin writer is silent, not a throw", async () => {
    // A one-shot run has no writer; the handle refuses the call before it gets
    // here, so silence is correct.
    const impl: BunSpawnLike = () => ({
      stdout: streamOf([]),
      stderr: streamOf([]),
      exited: Promise.resolve(0),
      kill: () => undefined,
    });
    const proc = createBunSpawnPort(impl).spawn(["codex"], OPTS);
    expect(() => proc.writeStdin("x")).not.toThrow();
  });

  test("cwd, env and argv are forwarded verbatim", async () => {
    const fake = fakeBun([]);
    createBunSpawnPort(fake.impl).spawn(["codex", "exec", "--json"], {
      cwd: "/wt/abc",
      env: { PATH: "/bin", KERYX_EXTERNAL_DEPTH: "1" },
      stdin: "ignore",
    });
    expect(fake.calls[0]?.argv).toEqual(["codex", "exec", "--json"]);
    expect(fake.calls[0]?.opts.cwd).toBe("/wt/abc");
    expect(fake.calls[0]?.opts.env.KERYX_EXTERNAL_DEPTH).toBe("1");
  });

  test("kill reaches the process and exited is surfaced", async () => {
    const fake = fakeBun([], [], 137);
    const proc = createBunSpawnPort(fake.impl).spawn(["codex"], OPTS);
    proc.kill();
    expect(fake.killed()).toBe(1);
    expect(await proc.exited).toBe(137);
  });
});
