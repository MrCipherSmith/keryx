// `session/cancel`, `session/list`, `session/load` over a REAL stdio pipe
// against the built CLI (flow 285, T10 — AC4, AC5).
//
// Same rationale as `permission.process.test.ts` for driving a real
// subprocess rather than `runAcpServer` in-process: `session/cancel` is a
// NOTIFICATION racing an in-flight `session/prompt` — the read loop's F-12
// "started in order, awaited separately" behaviour is exactly what this
// exercises, and an in-process harness that hand-feeds the notification at a
// convenient moment would not prove the race is handled at all.
//
// Offline by construction: the provider is the `--fixture` scripted one, so
// no network call and no model is involved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import { ACP_PROTOCOL_VERSION } from "./protocol";
import { createSession, persistHistory } from "../session";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const TIMEOUT_MS = 60_000;
const LOCAL_DENIAL = "command not approved by the user; not executed";

let root = "";
let projectDir = "";
let dataDir = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-cll-")));
  projectDir = path.join(root, "project");
  dataDir = path.join(root, "data");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface WireMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

/** One `keryx acp` subprocess, driven as a client would drive it. Mirrors `permission.process.test.ts`'s helper. */
class AcpProcessClient {
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private readonly seen: WireMessage[] = [];
  private readonly waiters: { match: (m: WireMessage) => boolean; settle: (m: WireMessage) => void }[] = [];
  private readonly stderr: string[] = [];
  private nextId = 1;

  constructor(fixture: string) {
    this.proc = Bun.spawn(["bun", "run", CLI, "acp", "--fixture", fixture, "--data-dir", dataDir], {
      cwd: projectDir,
      env: { ...process.env, XDG_DATA_HOME: root, APPDATA: root } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.pump();
    void this.pumpStderr();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim().length === 0) {
          continue;
        }
        const message = JSON.parse(line) as WireMessage;
        this.seen.push(message);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(message)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.settle(message);
          }
        }
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderr.push(decoder.decode(chunk, { stream: true }));
    }
  }

  send(message: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    void this.proc.stdin.flush();
  }

  request(method: string, params: Record<string, unknown>): number {
    const id = this.nextId++;
    this.send({ id, method, params });
    return id;
  }

  async waitFor(match: (m: WireMessage) => boolean, what: string): Promise<WireMessage> {
    const already = this.seen.find(match);
    if (already !== undefined) {
      return already;
    }
    return await new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.settle === settle);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`timed out waiting for ${what}; saw:\n${this.transcript()}\nstderr:\n${this.stderr.join("")}`));
      }, 30_000);
      const settle = (message: WireMessage): void => {
        clearTimeout(timer);
        resolve(message);
      };
      this.waiters.push({ match, settle });
    });
  }

  messages(): readonly WireMessage[] {
    return this.seen;
  }

  updates(kind: string): WireMessage[] {
    return this.seen.filter(
      (m) => m.method === "session/update" && (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === kind,
    );
  }

  updatesForSession(sessionId: string): WireMessage[] {
    return this.seen.filter((m) => m.method === "session/update" && m.params?.["sessionId"] === sessionId);
  }

  transcript(): string {
    return this.seen.map((m) => JSON.stringify(m)).join("\n");
  }

  async end(): Promise<void> {
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    await this.proc.exited;
  }

  async kill(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}

/** A fixture whose Nth turn calls `shell_exec` with `commands[N]`, then answers with text. */
function shellFixture(commands: readonly string[], finalText = "done."): string {
  const turns: Record<string, unknown>[][] = commands.map((command, index) => [
    { kind: "tool_call_start", toolCallId: `c${index}`, toolName: "shell_exec" },
    { kind: "tool_call_end", toolCallId: `c${index}`, input: JSON.stringify({ command }) },
    { kind: "model_end" },
  ]);
  turns.push([{ kind: "text_delta", text: finalText }, { kind: "model_end" }]);
  const file = path.join(root, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ turns }), "utf8");
  return file;
}

async function openSession(client: AcpProcessClient): Promise<string> {
  const initId = client.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "cancel-list-load-test", version: "0" },
  });
  await client.waitFor((m) => m.id === initId, "the initialize reply");
  const newId = client.request("session/new", { cwd: projectDir, mcpServers: [] });
  const created = await client.waitFor((m) => m.id === newId, "the session/new reply");
  const sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId;
  if (typeof sessionId !== "string") {
    throw new Error(`session/new returned no sessionId: ${JSON.stringify(created)}`);
  }
  return sessionId;
}

describe("AC4 — session/cancel", () => {
  test("cancel mid-turn ends it with stopReason cancelled and no later update for that turn", async () => {
    // `sleep 0.3` gives the notification real wall-clock time to arrive while
    // the tool is still running — a synchronous fixture alone cannot race
    // anything.
    const client = new AcpProcessClient(shellFixture(["sleep 0.3 && echo ran"]));
    try {
      const sessionId = await openSession(client);
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] });

      // Wait for the tool_call announcement (proof the turn actually started
      // running the command) before cancelling.
      await client.waitFor((m) => m.method === "session/update" && (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === "tool_call", "the tool_call announcement");
      client.send({ method: "session/cancel", params: { sessionId } });

      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "cancelled" });

      // Nothing for this session arrived on the wire AFTER the cancelled
      // reply — the turn produced no further session/update once it ended.
      const frames = client.messages();
      const replyIndex = frames.indexOf(reply);
      const laterFramesForSession = frames
        .slice(replyIndex + 1)
        .filter((m) => m.method === "session/update" && m.params?.["sessionId"] === sessionId);
      expect(laterFramesForSession).toEqual([]);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("cancel while a permission request is open settles it as a denial and ends the turn cancelled", async () => {
    const client = new AcpProcessClient(shellFixture(["echo keryx-ran-this"]));
    try {
      const sessionId = await openSession(client);
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] });

      const ask = await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");
      const askParams = ask.params as { toolCall: { toolCallId: string } };
      const toolCallId = askParams.toolCall.toolCallId;

      // Cancel while the ask is still open — never answer it.
      client.send({ method: "session/cancel", params: { sessionId } });

      const closed = await client.waitFor(
        (m) =>
          m.method === "session/update" &&
          (m.params?.["update"] as { sessionUpdate?: string; toolCallId?: string })?.sessionUpdate === "tool_call_update" &&
          (m.params?.["update"] as { toolCallId?: string })?.toolCallId === toolCallId,
        "the tool_call_update closing the pending call",
      );
      const update = closed.params?.["update"] as { status?: string; rawOutput?: unknown };
      expect(update.status).toBe("failed");
      expect(update.rawOutput).toBe(LOCAL_DENIAL);

      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "cancelled" });

      // The client never answered `ask.id` — proof the server settled it
      // locally (F-14) rather than the reply racing an actual client answer.
      expect(ask.id).toBeDefined();
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("a cancel for an unknown/already-finished session is a harmless no-op", async () => {
    const client = new AcpProcessClient(shellFixture([]));
    try {
      const sessionId = await openSession(client);
      client.send({ method: "session/cancel", params: { sessionId: "not-a-real-session" } });
      // The connection must still work normally afterwards.
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});

describe("AC5 — session/list and session/load", () => {
  test("a session created outside this connection (mirrors `keryx shell`) is listed and loadable", async () => {
    // Same store `keryx shell` writes to — `createSession`/`persistHistory`
    // from `../session`, entirely outside any ACP connection.
    const created = createSession({ cwd: projectDir, dataDir, provider: "fake", model: "fake-model", title: "shell session" });
    const history = [
      { role: "user" as const, content: "hello from keryx shell", provenance: "project" as const, ts: new Date().toISOString() },
      { role: "assistant" as const, content: "hi there", provenance: "model" as const, ts: new Date().toISOString() },
    ];
    persistHistory(created, history, { provider: "fake", model: "fake-model" });

    const client = new AcpProcessClient(shellFixture([]));
    try {
      const initId = client.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "list-load-test", version: "0" },
      });
      await client.waitFor((m) => m.id === initId, "the initialize reply");

      const listId = client.request("session/list", { cwd: projectDir });
      const listed = await client.waitFor((m) => m.id === listId, "the session/list reply");
      const sessions = (listed.result as { sessions?: { sessionId: string; cwd: string; title?: string }[] } | undefined)?.sessions ?? [];
      const found = sessions.find((s) => s.sessionId === created.summary.id);
      expect(found).toBeDefined();
      expect(found?.title).toBe("shell session");
      // F-6: cwd reported back is the RESOLVED project root, honestly.
      expect(path.resolve(found!.cwd)).toBe(path.resolve(projectDir));

      const loadId = client.request("session/load", { sessionId: created.summary.id, cwd: projectDir, mcpServers: [] });
      // The replay must precede the response — wait for the user_message_chunk first.
      const userChunk = await client.waitFor(
        (m) =>
          m.method === "session/update" &&
          (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === "user_message_chunk" &&
          m.params?.["sessionId"] === created.summary.id,
        "the replayed user_message_chunk",
      );
      const agentChunk = await client.waitFor(
        (m) =>
          m.method === "session/update" &&
          (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === "agent_message_chunk" &&
          m.params?.["sessionId"] === created.summary.id,
        "the replayed agent_message_chunk",
      );
      const loaded = await client.waitFor((m) => m.id === loadId, "the session/load reply");
      expect(loaded.error).toBeUndefined();

      const frames = client.messages();
      expect(frames.indexOf(userChunk)).toBeLessThan(frames.indexOf(loaded));
      expect(frames.indexOf(agentChunk)).toBeLessThan(frames.indexOf(loaded));
      expect((userChunk.params?.["update"] as { content?: { text?: string } }).content?.text).toBe("hello from keryx shell");
      expect((agentChunk.params?.["update"] as { content?: { text?: string } }).content?.text).toBe("hi there");
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("session/load replays a tool round as a tool_call/tool_call_update pair and drops system messages", async () => {
    const created = createSession({ cwd: projectDir, dataDir, provider: "fake", model: "fake-model" });
    const history = [
      { role: "system" as const, content: "hidden operator instruction", provenance: "trusted" as const, ts: new Date().toISOString() },
      { role: "user" as const, content: "list files", provenance: "project" as const, ts: new Date().toISOString() },
      {
        role: "assistant" as const,
        content: "",
        provenance: "model" as const,
        ts: new Date().toISOString(),
        toolCalls: [{ id: "call-1", name: "list_dir", arguments: "{}" }],
      },
      { role: "tool" as const, content: "a.ts\nb.ts", provenance: "tool" as const, toolCallId: "call-1", ts: new Date().toISOString() },
    ];
    persistHistory(created, history, { provider: "fake", model: "fake-model" });

    const client = new AcpProcessClient(shellFixture([]));
    try {
      const initId = client.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "list-load-tool-test", version: "0" },
      });
      await client.waitFor((m) => m.id === initId, "the initialize reply");

      const loadId = client.request("session/load", { sessionId: created.summary.id, cwd: projectDir, mcpServers: [] });
      const loaded = await client.waitFor((m) => m.id === loadId, "the session/load reply");
      expect(loaded.error).toBeUndefined();

      const forSession = client.updatesForSession(created.summary.id);
      const toolCall = forSession.find((m) => (m.params?.["update"] as { sessionUpdate?: string }).sessionUpdate === "tool_call");
      const toolCallUpdate = forSession.find(
        (m) => (m.params?.["update"] as { sessionUpdate?: string }).sessionUpdate === "tool_call_update",
      );
      expect(toolCall).toBeDefined();
      expect(toolCallUpdate).toBeDefined();
      const startId = (toolCall!.params?.["update"] as { toolCallId?: string }).toolCallId;
      const endId = (toolCallUpdate!.params?.["update"] as { toolCallId?: string }).toolCallId;
      expect(endId).toBe(startId);
      expect(endId).toBe("call-1");

      // The system message never surfaced as user or agent content.
      const suspicious = forSession.filter((m) => {
        const update = m.params?.["update"] as { content?: { text?: string } } | undefined;
        return update?.content?.text === "hidden operator instruction";
      });
      expect(suspicious).toEqual([]);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("session/load for an unknown session id is refused, not a hang", async () => {
    const client = new AcpProcessClient(shellFixture([]));
    try {
      const initId = client.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "list-load-missing-test", version: "0" },
      });
      await client.waitFor((m) => m.id === initId, "the initialize reply");

      const loadId = client.request("session/load", { sessionId: "not-a-real-session", cwd: projectDir, mcpServers: [] });
      const reply = await client.waitFor((m) => m.id === loadId, "the session/load reply");
      expect(reply.error).toBeDefined();
      expect(reply.result).toBeUndefined();
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("session/list with allow_always across an actual permission request is unaffected by list/load", async () => {
    // Sanity: list/load handlers do not disturb the connection-scoped
    // permission machinery (T9) — a permission flow still works after a
    // session/list call.
    const client = new AcpProcessClient(shellFixture(["echo still-works"]));
    try {
      const sessionId = await openSession(client);
      const listId = client.request("session/list", { cwd: projectDir });
      await client.waitFor((m) => m.id === listId, "the session/list reply");

      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] });
      const ask = await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");
      client.send({ id: ask.id, result: { outcome: { outcome: "selected", optionId: ACP_PERMISSION_OPTION_IDS.allowOnce } } });
      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});
