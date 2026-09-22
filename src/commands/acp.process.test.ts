// `keryx acp` as a real process (flow 285, AC8): drives the built CLI over an
// actual stdio pipe, one JSON-RPC frame at a time, against a deterministic
// offline fixture provider (`../acp/fixture-provider.ts`) — no network, no
// TTY, no `FakeProvider` request-hash authoring.
//
// Covers: initialize (exact / offer / refuse), a request before initialize,
// session/new (including the honest mcpServers refusal, F-8), session/prompt
// with streaming `session/update`s arriving before the final response, and a
// stdout-purity check (every stdout line parses as a JSON-RPC frame).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import {
  ACP_PROTOCOL_VERSION,
  JSON_RPC_ERROR_CODES,
  KERYX_AGENT_CAPABILITIES,
  KERYX_AUTH_METHODS,
} from "../acp";
import type { AcpFixtureEvent } from "../acp/fixture-provider";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const WAIT_MS = 15_000;

interface JsonRpcFrame {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Connection {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  send: (frame: JsonRpcFrame) => Promise<void>;
  /** Every complete stdout LINE seen so far, in arrival order (raw text). */
  rawLines: () => string[];
  /** `rawLines()` parsed as JSON-RPC frames — throws if any line is not valid JSON (purity). */
  frames: () => JsonRpcFrame[];
  stderrText: () => string;
  replyTo: (id: number, timeoutMs?: number) => Promise<JsonRpcFrame>;
  waitForFrameCount: (n: number, timeoutMs?: number) => Promise<JsonRpcFrame[]>;
  close: () => Promise<void>;
}

const openConnections: Connection[] = [];

afterEach(async () => {
  while (openConnections.length > 0) {
    const c = openConnections.pop();
    await c?.close();
  }
});

function makeSandbox(): { cwd: string; env: Record<string, string> } {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-acp-proc-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  const dataDir = path.join(root, "data");
  for (const dir of [home, cwd, dataDir]) mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "."], { cwd });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    KERYX_DATA_DIR: dataDir,
    TMPDIR: tmpdir(),
    NO_COLOR: "1",
  };
  return { cwd, env };
}

/** Writes a fixture file (`../acp/fixture-provider.ts`'s shape) and returns its path. */
function writeFixture(turns: readonly (readonly AcpFixtureEvent[])[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-acp-fixture-"));
  const file = path.join(dir, "fixture.json");
  writeFileSync(file, JSON.stringify({ turns }), "utf-8");
  return file;
}

function startAcp(cwd: string, env: Record<string, string>, fixture: string): Connection {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "acp", "--provider", "fake", "--model", "fake-model", "--fixture", fixture],
    { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  const lines: string[] = [];
  let buffer = "";
  const outDecoder = new TextDecoder();
  const stdoutDrain = (async () => {
    for await (const chunk of proc.stdout) {
      buffer += outDecoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim().length > 0) lines.push(part);
      }
    }
  })();

  let errText = "";
  const errDecoder = new TextDecoder();
  const stderrDrain = (async () => {
    for await (const chunk of proc.stderr) {
      errText += errDecoder.decode(chunk, { stream: true });
    }
  })();

  const frames = (): JsonRpcFrame[] => lines.map((line) => JSON.parse(line) as JsonRpcFrame);

  const waitForFrameCount = async (n: number, timeoutMs = WAIT_MS): Promise<JsonRpcFrame[]> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = frames();
      if (current.length >= n) return current;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${n} stdout frame(s); saw ${current.length}. stderr:\n${errText}`);
      }
      await Bun.sleep(20);
    }
  };

  const replyTo = async (id: number, timeoutMs = WAIT_MS): Promise<JsonRpcFrame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames().find((f) => f.id === id && (f.result !== undefined || f.error !== undefined));
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a reply to id ${id}. stderr:\n${errText}`);
      }
      await Bun.sleep(20);
    }
  };

  const connection: Connection = {
    proc,
    send: async (frame) => {
      proc.stdin.write(`${JSON.stringify(frame)}\n`);
      await proc.stdin.flush();
    },
    rawLines: () => [...lines],
    frames,
    stderrText: () => errText,
    replyTo,
    waitForFrameCount,
    close: async () => {
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      proc.kill();
      await Promise.race([Promise.all([stdoutDrain, stderrDrain, proc.exited]), Bun.sleep(2000)]);
    },
  };
  openConnections.push(connection);
  return connection;
}

describe("keryx acp (real stdio process)", () => {
  test("initialize: exact version negotiates to the same version, advertises the pinned capabilities", async () => {
    const { cwd, env } = makeSandbox();
    const conn = startAcp(cwd, env, writeFixture([]));
    await conn.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION } });
    const reply = await conn.replyTo(1);
    expect(reply.error).toBeUndefined();
    const result = reply.result as { protocolVersion: number; agentCapabilities: unknown; authMethods: unknown[]; agentInfo: { name: string } };
    expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(result.agentCapabilities).toEqual(KERYX_AGENT_CAPABILITIES);
    expect(result.authMethods).toEqual([...KERYX_AUTH_METHODS]);
    expect(result.agentInfo.name).toBe("keryx");
  });

  test("initialize: a newer version is offered keryx's latest supported version, not an error (F-1)", async () => {
    const { cwd, env } = makeSandbox();
    const conn = startAcp(cwd, env, writeFixture([]));
    await conn.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION + 41 } });
    const reply = await conn.replyTo(1);
    expect(reply.error).toBeUndefined();
    const result = reply.result as { protocolVersion: number };
    expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
  });

  test("initialize: a malformed/out-of-range version is refused with a JSON-RPC error, not served", async () => {
    const { cwd, env } = makeSandbox();
    const conn = startAcp(cwd, env, writeFixture([]));
    await conn.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: -1 } });
    const reply = await conn.replyTo(1);
    expect(reply.result).toBeUndefined();
    expect(reply.error?.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
  });

  test("a request before initialize is refused, not served", async () => {
    const { cwd, env } = makeSandbox();
    const conn = startAcp(cwd, env, writeFixture([]));
    await conn.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd, mcpServers: [] } });
    const reply = await conn.replyTo(1);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toBeDefined();
    expect(reply.error?.code).toBe(JSON_RPC_ERROR_CODES.invalidRequest);
  });

  test("session/new refuses a non-empty mcpServers honestly rather than silently dropping it (F-8)", async () => {
    const { cwd, env } = makeSandbox();
    const conn = startAcp(cwd, env, writeFixture([]));
    await conn.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION } });
    await conn.replyTo(1);
    await conn.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd, mcpServers: [{ type: "stdio", name: "x", command: "x", args: [], env: [] }] },
    });
    const reply = await conn.replyTo(2);
    expect(reply.result).toBeUndefined();
    expect(reply.error?.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
    expect(String(reply.error?.message ?? "") + JSON.stringify(reply.error?.data ?? "")).toMatch(/mcp/i);
  });

  test("session/new + session/prompt: streams session/update notifications before the final response, and stdout is pure protocol frames", async () => {
    const { cwd, env } = makeSandbox();
    const fixture = writeFixture([
      // Turn 1: the model calls get_cwd.
      [
        { kind: "reasoning_delta", text: "Checking the working directory." },
        { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
        { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
        { kind: "model_end" },
      ],
      // Turn 2 (after the tool result is fed back): a streamed text answer.
      [
        { kind: "text_delta", text: "Your directory is " },
        { kind: "text_delta", text: "ready." },
        { kind: "model_end" },
      ],
    ]);
    const conn = startAcp(cwd, env, fixture);

    await conn.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION } });
    await conn.replyTo(1);

    await conn.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const newSessionReply = await conn.replyTo(2);
    expect(newSessionReply.error).toBeUndefined();
    const sessionId = (newSessionReply.result as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    await conn.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "where am I?" }] },
    });

    const finalReply = await conn.replyTo(3);
    expect(finalReply.error).toBeUndefined();
    expect((finalReply.result as { stopReason: string }).stopReason).toBe("end_turn");

    // Frames are appended to `conn.frames()` in ARRIVAL order (a line is only
    // recorded once fully received), so a session/update at an index before
    // id 3's reply genuinely arrived on the wire before that reply did — this
    // proves streaming, not merely that updates exist somewhere in the log.
    const allFrames = conn.frames();
    const finalIndex = allFrames.findIndex((f) => f.id === 3 && (f.result !== undefined || f.error !== undefined));
    const updatesBeforeFinal = allFrames.slice(0, finalIndex).filter((f) => f.method === "session/update");
    expect(updatesBeforeFinal.length).toBeGreaterThanOrEqual(2);

    // Stdout purity (AC1): every line, over the whole exchange, parses as a
    // JSON-RPC frame — nothing else ever reached stdout.
    for (const line of conn.rawLines()) {
      const parsed = JSON.parse(line) as JsonRpcFrame;
      expect(parsed.jsonrpc).toBe("2.0");
    }

    // The update kinds seen include at least a tool call and streamed text,
    // not merely a single dump at the end.
    const updateMethods = conn
      .frames()
      .filter((f) => f.method === "session/update")
      .map((f) => (f.params as { update: { sessionUpdate: string } }).update.sessionUpdate);
    expect(updateMethods).toContain("tool_call");
    expect(updateMethods).toContain("tool_call_update");
    expect(updateMethods).toContain("agent_message_chunk");
  });
});
