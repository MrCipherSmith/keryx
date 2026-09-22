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
import { AcpProcessClient } from "./process-client.test-helpers";
import { ACP_PROTOCOL_VERSION } from "./protocol";

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
    const client = new AcpProcessClient({ fixture: singleCallFixture("read_file", { path: "sample.txt" }), cwd: projectDir, dataDir, homeRoot: root });
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
    const client = new AcpProcessClient({ fixture: singleCallFixture("read_file", { path: "sample.txt" }), cwd: projectDir, dataDir, homeRoot: root });
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
    const client = new AcpProcessClient({ fixture: singleCallFixture("read_file", { path: "sample.txt" }), cwd: projectDir, dataDir, homeRoot: root });
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
    const client = new AcpProcessClient({ fixture: singleCallFixture("shell_exec", { command: "echo capability-matrix-ran" }), cwd: projectDir, dataDir, homeRoot: root });
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
    const client = new AcpProcessClient({ fixture: singleCallFixture("shell_exec", { command: "echo capability-matrix-ran" }), cwd: projectDir, dataDir, homeRoot: root });
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
