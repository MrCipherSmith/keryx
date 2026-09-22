// Client-capability matrix over a REAL stdio pipe (flow 285, T11 — AC6).
//
// `capability-tools.ts` documents three decisions: `read_file` routes
// through `fs/read_text_file` only when the client advertised
// `fs.readTextFile`; `apply_patch` (write) and `shell_exec` (terminal) stay
// local UNCONDITIONALLY. This file proves the read half both ways (present
// vs. absent) and proves the terminal half never fires in EITHER
// configuration — the stronger, simpler property `capability-tools.ts`
// chose to hold.
//
// Offline by construction: the provider is the `--fixture` scripted one, so
// no network call and no model is involved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { ACP_PROTOCOL_VERSION } from "./protocol";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const TIMEOUT_MS = 60_000;

let root = "";
let projectDir = "";
let dataDir = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-cap-")));
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

  transcript(): string {
    return this.seen.map((m) => JSON.stringify(m)).join("\n");
  }

  async kill(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}

/** A fixture whose one turn calls `toolName` with `input`, then answers with `finalText`. */
function singleCallFixture(toolName: string, input: Record<string, unknown>, finalText = "done."): string {
  const turns: Record<string, unknown>[][] = [
    [
      { kind: "tool_call_start", toolCallId: "c0", toolName },
      { kind: "tool_call_end", toolCallId: "c0", input: JSON.stringify(input) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: finalText }, { kind: "model_end" }],
  ];
  const file = path.join(root, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ turns }), "utf8");
  return file;
}

/** `initialize` with `clientCapabilities`, then `session/new`. Returns the session id. */
async function openSession(
  client: AcpProcessClient,
  clientCapabilities: Record<string, unknown>,
): Promise<string> {
  const initId = client.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities,
    clientInfo: { name: "capability-matrix-test", version: "0" },
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

/**
 * The `toolCallId` the ACP wire minted for the (single) call this turn made —
 * NOT the fixture's own scripted id (`c0`), which never reaches the wire:
 * `agent-io.ts`'s `openToolCall` mints a fresh `randomUUID()` per call.
 */
async function announcedToolCallId(client: AcpProcessClient, toolName: string): Promise<string> {
  const announced = await client.waitFor(
    (m) =>
      m.method === "session/update" &&
      (m.params?.["update"] as { sessionUpdate?: string; name?: string })?.sessionUpdate === "tool_call" &&
      (m.params?.["update"] as { name?: string }).name === toolName,
    `the tool_call announcement for ${toolName}`,
  );
  return (announced.params?.["update"] as { toolCallId: string }).toolCallId;
}

async function resultUpdate(client: AcpProcessClient, toolCallId: string): Promise<{ status: string; rawOutput: string }> {
  const message = await client.waitFor(
    (m) =>
      m.method === "session/update" &&
      (m.params?.["update"] as { sessionUpdate?: string; toolCallId?: string })?.sessionUpdate === "tool_call_update" &&
      (m.params?.["update"] as { toolCallId?: string })?.toolCallId === toolCallId,
    `the tool_call_update closing ${toolCallId}`,
  );
  const update = message.params?.["update"] as { status?: string; rawOutput?: unknown };
  return { status: String(update.status), rawOutput: String(update.rawOutput ?? "") };
}

describe("AC6 — read_file honours the fs.readTextFile capability", () => {
  test("with fs.readTextFile advertised, read_file goes through fs/read_text_file", async () => {
    writeFileSync(path.join(projectDir, "sample.txt"), "on-disk content", "utf8");
    const client = new AcpProcessClient(singleCallFixture("read_file", { path: "sample.txt" }));
    try {
      const sessionId = await openSession(client, { fs: { readTextFile: true, writeTextFile: true } });
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read it" }] });

      const fsRequest = await client.waitFor((m) => m.method === "fs/read_text_file", "an fs/read_text_file request");
      const fsParams = fsRequest.params as { sessionId: string; path: string };
      expect(fsParams.sessionId).toBe(sessionId);
      expect(path.isAbsolute(fsParams.path)).toBe(true);
      expect(path.resolve(fsParams.path)).toBe(path.resolve(projectDir, "sample.txt"));

      client.send({ id: fsRequest.id, result: { content: "content served by the CLIENT, not the disk" } });

      const closed = await resultUpdate(client, await announcedToolCallId(client, "read_file"));
      expect(closed.status).toBe("completed");
      expect(closed.rawOutput).toBe("content served by the CLIENT, not the disk");

      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      // The write and terminal halves of AC6 are unaffected by fs being
      // advertised: neither was ever called.
      expect(client.messages().some((m) => m.method === "fs/write_text_file")).toBe(false);
      expect(client.messages().some((m) => m.method?.startsWith("terminal/"))).toBe(false);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("without fs advertised, read_file never calls fs/read_text_file and still completes locally", async () => {
    writeFileSync(path.join(projectDir, "sample.txt"), "on-disk content", "utf8");
    const client = new AcpProcessClient(singleCallFixture("read_file", { path: "sample.txt" }));
    try {
      const sessionId = await openSession(client, {});
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read it" }] });

      const closed = await resultUpdate(client, await announcedToolCallId(client, "read_file"));
      expect(closed.status).toBe("completed");
      expect(closed.rawOutput).toBe("on-disk content");

      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      // Provably never called: no frame on the wire for the whole connection
      // was ever an fs/read_text_file request.
      expect(client.messages().some((m) => m.method === "fs/read_text_file")).toBe(false);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("fs.readTextFile advertised as false behaves exactly like the capability being absent", async () => {
    writeFileSync(path.join(projectDir, "sample.txt"), "on-disk content", "utf8");
    const client = new AcpProcessClient(singleCallFixture("read_file", { path: "sample.txt" }));
    try {
      const sessionId = await openSession(client, { fs: { readTextFile: false } });
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read it" }] });

      const closed = await resultUpdate(client, await announcedToolCallId(client, "read_file"));
      expect(closed.status).toBe("completed");
      expect(closed.rawOutput).toBe("on-disk content");
      await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(client.messages().some((m) => m.method === "fs/read_text_file")).toBe(false);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});

describe("AC6 — shell_exec never calls terminal/*, in every capability configuration", () => {
  test("with terminal advertised, shell_exec still runs locally and no terminal/* frame is ever sent", async () => {
    const client = new AcpProcessClient(singleCallFixture("shell_exec", { command: "echo capability-matrix-ran" }));
    try {
      const sessionId = await openSession(client, { terminal: true });
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] });

      // shell_exec is `risk: shell` and gated (T9) — it still asks for
      // permission even with `terminal` advertised, because the decision
      // (capability-tools.ts) is that shell_exec never routes through
      // `terminal/*` at all, regardless of capability.
      const ask = await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");
      const askParams = ask.params as { toolCall: { toolCallId: string } };
      client.send({ id: ask.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });

      const closed = await resultUpdate(client, askParams.toolCall.toolCallId);
      expect(closed.status).toBe("completed");
      expect(closed.rawOutput).toContain("capability-matrix-ran");

      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      expect(client.messages().some((m) => m.method?.startsWith("terminal/"))).toBe(false);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("without terminal advertised, shell_exec behaves identically", async () => {
    const client = new AcpProcessClient(singleCallFixture("shell_exec", { command: "echo capability-matrix-ran" }));
    try {
      const sessionId = await openSession(client, {});
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] });

      const ask = await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");
      const askParams = ask.params as { toolCall: { toolCallId: string } };
      client.send({ id: ask.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });

      const closed = await resultUpdate(client, askParams.toolCall.toolCallId);
      expect(closed.status).toBe("completed");
      expect(closed.rawOutput).toContain("capability-matrix-ran");

      await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(client.messages().some((m) => m.method?.startsWith("terminal/"))).toBe(false);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});
