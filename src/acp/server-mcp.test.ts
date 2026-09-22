// `runAcpServer` in-process, for the flow-287 rules whose evidence is an
// ORDER or a LIFECYCLE rather than a process (the real pipe is
// `mcp-servers.process.test.ts`):
//
//   - AC2: no provider → `initialize` answers, `session/new`/`session/load`
//     are refused with the configured message.
//   - AC3: `session/load` REPLACES a session's servers — the old set is
//     stopped while the connection is still open — and connection close
//     stops the rest.
//   - AC5: a failure report reaches the client only AFTER the `session/new`
//     reply that told it the session exists.
//
// Every wait is on an event (a frame written, a `close()` called), never a timer.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderPort } from "../harness/provider/types";
import type { McpServerConnection } from "../mcp-client/client";
import type { ConnectFn } from "../mcp-servers/manager";
import { runAcpServer, type AcpServerOptions } from "./server";
import { ACP_PROTOCOL_VERSION } from "./protocol";

interface Frame {
  id?: string | number | null;
  method?: string;
  params?: { sessionId?: string; update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

/** A controllable stdin plus a frame log with event-driven waits. */
function harness(overrides: Partial<AcpServerOptions>) {
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const input: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (lines.length > 0) yield lines.shift() as string;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
  const frames: Frame[] = [];
  const stderr: string[] = [];
  const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-server-mcp-")));
  const done = runAcpServer({
    input,
    write: (chunk) => {
      for (const line of chunk.split("\n").filter((l) => l.trim().length > 0)) {
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        for (const waiter of [...waiters]) {
          if (waiter.match(frame)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      }
    },
    logError: (line) => stderr.push(line),
    providerId: "test",
    modelId: "test-model",
    dataDir: path.join(root, "data"),
    ...overrides,
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown>): number => {
    const id = nextId++;
    lines.push(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    wake?.();
    return id;
  };
  const waitFor = (match: (f: Frame) => boolean): Promise<Frame> => {
    const already = frames.find(match);
    if (already !== undefined) return Promise.resolve(already);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const end = async (): Promise<void> => {
    ended = true;
    wake?.();
    await done;
  };
  return { request, waitFor, frames, stderr, end, done, projectDir: root };
}

/** A dial that never spawns: records which server was dialled and signals each close. */
function recordingConnect() {
  const closed = new Map<string, () => void>();
  const closedPromise = new Map<string, Promise<void>>();
  const closeOf = (name: string): Promise<void> => {
    let promise = closedPromise.get(name);
    if (promise === undefined) {
      promise = new Promise<void>((resolve) => closed.set(name, resolve));
      closedPromise.set(name, promise);
    }
    return promise;
  };
  const closedNames: string[] = [];
  const dialled: string[] = [];
  const connect: ConnectFn = async (server) => {
    dialled.push(server.name);
    if (server.command === "missing-binary") throw new Error("spawn missing-binary ENOENT");
    void closeOf(server.name);
    return {
      listTools: async () => [],
      callTool: async () => ({ kind: "result", result: { content: [], isError: false } }),
      close: async () => {
        closedNames.push(server.name);
        closed.get(server.name)?.();
      },
    } as unknown as McpServerConnection;
  };
  return { connect, closeOf, closedNames, dialled };
}

const stdio = (name: string, command = "server-bin") => ({ name, command, args: [], env: [] });
const PROVIDER = {} as ProviderPort;

describe("AC2 — no provider: initialize answers, sessions are refused with what to configure", () => {
  test("session/new and session/load carry the configured message; initialize is untouched", async () => {
    const message = "keryx acp: no provider is configured — run `keryx shell` once …";
    const h = harness({ providerUnavailable: message });
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    expect((await h.waitFor((f) => f.id === init)).result?.["protocolVersion"]).toBe(ACP_PROTOCOL_VERSION);

    const created = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
    const refusedNew = await h.waitFor((f) => f.id === created);
    expect(refusedNew.error?.message).toBe(message);
    expect(refusedNew.error?.data?.["condition"]).toBe("provider-not-configured");

    const loaded = h.request("session/load", { sessionId: "any", cwd: h.projectDir, mcpServers: [] });
    const refusedLoad = await h.waitFor((f) => f.id === loaded);
    expect(refusedLoad.error?.message).toBe(message);
    await h.end();
  });
});

describe("AC3 / AC5 — per-session servers over the connection's lifetime", () => {
  test("a failure is reported after the session/new reply, by name; the other server is started", async () => {
    const dial = recordingConnect();
    const h = harness({ provider: PROVIDER, mcpConnect: dial.connect });
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await h.waitFor((f) => f.id === init);

    const created = h.request("session/new", {
      cwd: h.projectDir,
      mcpServers: [stdio("good"), stdio("broken", "missing-binary"), { type: "sse", name: "remote", url: "https://x/sse" }],
    });
    const reply = await h.waitFor((f) => f.id === created);
    const sessionId = reply.result?.["sessionId"] as string;
    expect(typeof sessionId).toBe("string");

    const report = (name: string) =>
      h.waitFor(
        (f) =>
          f.method === "session/update" &&
          f.params?.update?.sessionUpdate === "agent_message_chunk" &&
          (f.params.update.content?.text ?? "").includes(`"${name}"`),
      );
    const broken = await report("broken");
    const remote = await report("remote");
    expect(broken.params?.sessionId).toBe(sessionId);
    expect(broken.params?.update?.content?.text).toContain("ENOENT");
    expect(remote.params?.update?.content?.text).toContain("http: false, sse: false");
    // ORDER: the client learns the session exists before it hears about it.
    expect(h.frames.indexOf(reply)).toBeLessThan(h.frames.indexOf(broken));
    expect(h.frames.indexOf(reply)).toBeLessThan(h.frames.indexOf(remote));
    expect(h.stderr.some((line) => line.includes('"broken"'))).toBe(true);

    await h.end();
    expect(dial.closedNames).toEqual(["good"]);
  });

  test("session/load replaces the session's servers — the old set is stopped while the connection is open", async () => {
    const dial = recordingConnect();
    const h = harness({ provider: PROVIDER, mcpConnect: dial.connect });
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await h.waitFor((f) => f.id === init);

    const created = h.request("session/new", { cwd: h.projectDir, mcpServers: [stdio("alpha")] });
    const sessionId = (await h.waitFor((f) => f.id === created)).result?.["sessionId"] as string;

    const loaded = h.request("session/load", { sessionId, cwd: h.projectDir, mcpServers: [stdio("beta")] });
    const loadReply = await h.waitFor((f) => f.id === loaded);
    expect(loadReply.error).toBeUndefined();

    // The event: alpha's connection is closed by the replacement itself.
    await dial.closeOf("alpha");
    expect(dial.closedNames).toEqual(["alpha"]);

    await h.end();
    expect(dial.closedNames).toEqual(["alpha", "beta"]);
  });

  test("a malformed mcpServers list refuses the call and creates no session", async () => {
    const dial = recordingConnect();
    const h = harness({ provider: PROVIDER, mcpConnect: dial.connect });
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await h.waitFor((f) => f.id === init);
    const created = h.request("session/new", { cwd: h.projectDir, mcpServers: [{ command: "no-name" }] });
    const reply = await h.waitFor((f) => f.id === created);
    expect(reply.error?.code).toBe(-32602);
    await h.end();
    expect(dial.closedNames).toEqual([]);
  });
});

describe("T13 — one running set per distinct list, shared by the sessions that send it", () => {
  test("two session/new with the same list start the working servers once; both sessions report its failures", async () => {
    const dial = recordingConnect();
    const h = harness({ provider: PROVIDER, mcpConnect: dial.connect });
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await h.waitFor((f) => f.id === init);
    const list = [stdio("good"), stdio("broken", "missing-binary")];

    const first = h.request("session/new", { cwd: h.projectDir, mcpServers: list });
    const firstId = (await h.waitFor((f) => f.id === first)).result?.["sessionId"] as string;
    const second = h.request("session/new", { cwd: h.projectDir, mcpServers: list });
    const secondId = (await h.waitFor((f) => f.id === second)).result?.["sessionId"] as string;
    expect(secondId).not.toBe(firstId);

    for (const sessionId of [firstId, secondId]) {
      await h.waitFor(
        (f) =>
          f.method === "session/update" &&
          f.params?.sessionId === sessionId &&
          (f.params.update?.content?.text ?? "").includes('"broken"'),
      );
    }
    // "good" is started once and shared. "broken" is dialled again when the
    // second session binds (T14 revive) — and still fails, so both report it.
    expect(dial.dialled.filter((name) => name === "good")).toEqual(["good"]);
    expect(dial.dialled.filter((name) => name === "broken")).toEqual(["broken", "broken"]);

    await h.end();
    expect(dial.closedNames).toEqual(["good"]);
  });

  test("a set still used by another session survives one session's rebind; the last rebind stops it", async () => {
    const dial = recordingConnect();
    const h = harness({ provider: PROVIDER, mcpConnect: dial.connect });
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await h.waitFor((f) => f.id === init);
    const a = h.request("session/new", { cwd: h.projectDir, mcpServers: [stdio("shared")] });
    const aId = (await h.waitFor((f) => f.id === a)).result?.["sessionId"] as string;
    const b = h.request("session/new", { cwd: h.projectDir, mcpServers: [stdio("shared")] });
    const bId = (await h.waitFor((f) => f.id === b)).result?.["sessionId"] as string;

    const loadA = h.request("session/load", { sessionId: aId, cwd: h.projectDir, mcpServers: [] });
    await h.waitFor((f) => f.id === loadA);
    expect(dial.closedNames).toEqual([]);

    const loadB = h.request("session/load", { sessionId: bId, cwd: h.projectDir, mcpServers: [] });
    await h.waitFor((f) => f.id === loadB);
    await dial.closeOf("shared");
    expect(dial.closedNames).toEqual(["shared"]);
    await h.end();
    expect(dial.dialled).toEqual(["shared"]);
  });
});

describe("T13 — shutdown stops the servers without waiting for stdin to end", () => {
  test("aborting `shutdown` resolves runAcpServer with every server closed, input still open", async () => {
    const dial = recordingConnect();
    const stop = new AbortController();
    const h = harness({ provider: PROVIDER, mcpConnect: dial.connect, shutdown: stop.signal });
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await h.waitFor((f) => f.id === init);
    const created = h.request("session/new", { cwd: h.projectDir, mcpServers: [stdio("alpha")] });
    await h.waitFor((f) => f.id === created);

    stop.abort();
    await h.done;
    expect(dial.closedNames).toEqual(["alpha"]);
  });
});

describe("T14 — no session work once shutdown has begun", () => {
  test("a session/new dispatched after the abort is refused and dials nothing", async () => {
    const dial = recordingConnect();
    const stop = new AbortController();
    const h = harness({ provider: PROVIDER, mcpConnect: dial.connect, shutdown: stop.signal });
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await h.waitFor((f) => f.id === init);

    stop.abort();
    // The read loop is raced, not cancelled: this line is still dispatched.
    const late = h.request("session/new", { cwd: h.projectDir, mcpServers: [stdio("late")] });
    const reply = await h.waitFor((f) => f.id === late);
    await h.done;
    expect(reply.error?.data?.["condition"]).toBe("shutting-down");
    expect(dial.dialled).toEqual([]);
  });
});
