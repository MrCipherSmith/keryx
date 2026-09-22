// The permission path over a REAL stdio pipe (flow 285, T9 — AC3).
//
// Why a subprocess and not `runAcpServer` in-process: the thing AC3 is about is
// a REVERSAL of the wire. Until now the client asked and keryx answered; here
// keryx asks in the middle of a turn and blocks a tool call on the reply, which
// arrives as the next line on the same stdin the server is reading. That
// round trip is exactly what an in-process harness papers over — a test that
// hands the server a pre-baked answer would have passed against a server that
// deadlocks, and against one that never asks at all.
//
// So every assertion below is on frames: `session/request_permission` was SENT
// (asserting only "the denied call did not run" would pass against a keryx that
// never asked — context.md F-4's failure-in-the-safe-direction), it carried the
// tool call the client had already been shown, and the answer decided whether
// the command ran.
//
// Offline by construction: the provider is the `--fixture` scripted one
// (`fixture-provider.ts`), so no network call and no model is involved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import { ACP_PROTOCOL_VERSION } from "./protocol";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const TIMEOUT_MS = 60_000;

/** What `executeCall` returns when the operator says no — the local denial, verbatim. */
const LOCAL_DENIAL = "command not approved by the user; not executed";

let root = "";
let projectDir = "";
let dataDir = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-perm-")));
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

/** One `keryx acp` subprocess, driven as a client would drive it. */
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

  /** Sends a request and returns its id (the caller waits for the matching reply). */
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

  /** Every frame received so far — the evidence a test reasons over. */
  messages(): readonly WireMessage[] {
    return this.seen;
  }

  updates(kind: string): WireMessage[] {
    return this.seen.filter(
      (m) => m.method === "session/update" && (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === kind,
    );
  }

  permissionRequests(): WireMessage[] {
    return this.seen.filter((m) => m.method === "session/request_permission");
  }

  transcript(): string {
    return this.seen.map((m) => JSON.stringify(m)).join("\n");
  }

  /** Closes stdin (the client going away) and waits for the process to finish. */
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

/** `initialize` + `session/new`, returning the session id. */
async function openSession(client: AcpProcessClient): Promise<string> {
  const initId = client.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "permission-process-test", version: "0" },
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

/** The `tool_call_update` that closed `toolCallId`, once one arrives. */
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

/** Drives one turn up to the permission request, returning the ids involved. */
async function promptUntilAsked(
  client: AcpProcessClient,
  sessionId: string,
  text: string,
): Promise<{ promptId: number; askId: string | number; toolCallId: string; options: { optionId: string; kind: string }[] }> {
  const promptId = client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
  const ask = await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");
  const params = ask.params as {
    sessionId: string;
    toolCall: { toolCallId: string; name?: string; status?: string; rawInput?: unknown };
    options: { optionId: string; kind: string }[];
  };
  expect(params.sessionId).toBe(sessionId);
  expect(params.toolCall.name).toBe("shell_exec");
  return { promptId, askId: ask.id as string | number, toolCallId: params.toolCall.toolCallId, options: params.options };
}

describe("AC3 — a gated tool call asks the client", () => {
  test("the tool_call update precedes the ask, and carries the same id (F-3)", async () => {
    const client = new AcpProcessClient(shellFixture(["echo keryx-ran-this"]));
    try {
      const sessionId = await openSession(client);
      const { askId, toolCallId, options } = await promptUntilAsked(client, sessionId, "run it");

      // The client was SHOWN the call before being asked to authorise it: the
      // `tool_call` update for this exact id is already in the transcript, and
      // it arrived earlier than the request.
      const announced = client
        .updates("tool_call")
        .find((m) => (m.params?.["update"] as { toolCallId?: string }).toolCallId === toolCallId);
      expect(announced).toBeDefined();
      const frames = client.messages();
      expect(frames.indexOf(announced!)).toBeLessThan(frames.findIndex((m) => m.id === askId));

      // And the options are the four a client needs to render the choice.
      expect(options.map((option) => option.optionId).sort()).toEqual(
        [
          ACP_PERMISSION_OPTION_IDS.allowAlways,
          ACP_PERMISSION_OPTION_IDS.allowOnce,
          ACP_PERMISSION_OPTION_IDS.rejectAlways,
          ACP_PERMISSION_OPTION_IDS.rejectOnce,
        ].sort(),
      );
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("allow_once runs the command and the turn ends normally", async () => {
    const client = new AcpProcessClient(shellFixture(["echo keryx-ran-this"]));
    try {
      const sessionId = await openSession(client);
      const { promptId, askId, toolCallId } = await promptUntilAsked(client, sessionId, "run it");

      client.send({ id: askId, result: { outcome: { outcome: "selected", optionId: ACP_PERMISSION_OPTION_IDS.allowOnce } } });

      const closed = await resultUpdate(client, toolCallId);
      expect(closed.status).toBe("completed");
      expect(closed.rawOutput).toContain("keryx-ran-this");

      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("allow_always runs the command too — the fingerprint it carries matches this call", async () => {
    // `allow_always` is the one answer that maps to the OBJECT form,
    // `{ approved: true, fingerprint }`, which `isApprovalFor` accepts only
    // when the fingerprint is the one the gate asked about. A fingerprint
    // mismatch is a denial, so this is the branch where a wrong id would look
    // exactly like a rejection — worth proving over the real wire and not only
    // against a hand-built meta in a unit test.
    const client = new AcpProcessClient(shellFixture(["echo keryx-ran-this"]));
    try {
      const sessionId = await openSession(client);
      const { promptId, askId, toolCallId } = await promptUntilAsked(client, sessionId, "run it");

      client.send({
        id: askId,
        result: { outcome: { outcome: "selected", optionId: ACP_PERMISSION_OPTION_IDS.allowAlways } },
      });

      const closed = await resultUpdate(client, toolCallId);
      expect(closed.status).toBe("completed");
      expect(closed.rawOutput).toContain("keryx-ran-this");
      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("reject_once leaves the call unexecuted and the turn ends as a local denial does", async () => {
    const client = new AcpProcessClient(shellFixture(["echo keryx-ran-this"]));
    try {
      const sessionId = await openSession(client);
      const { promptId, askId, toolCallId } = await promptUntilAsked(client, sessionId, "run it");

      client.send({
        id: askId,
        result: { outcome: { outcome: "selected", optionId: ACP_PERMISSION_OPTION_IDS.rejectOnce } },
      });

      const closed = await resultUpdate(client, toolCallId);
      expect(closed.status).toBe("failed");
      // Not "a denial-shaped message": the EXACT string `executeCall` returns
      // when a local operator says no. The turn took the same branch.
      expect(closed.rawOutput).toBe(LOCAL_DENIAL);

      // The turn continued (the model got the refusal back and answered) and
      // ended with the ordinary stop reason, exactly as it does locally.
      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
      expect(
        client
          .updates("agent_message_chunk")
          .map((m) => ((m.params?.["update"] as { content?: { text?: string } }).content?.text ?? ""))
          .join(""),
      ).toContain("done.");
      // And the command really did not run: nothing on this wire ever carried
      // its output (the `echo` text alone appears in the call's `rawInput`,
      // which is why this checks the outputs and not the transcript).
      expect(
        client
          .updates("tool_call_update")
          .map((m) => String((m.params?.["update"] as { rawOutput?: unknown }).rawOutput ?? "")),
      ).toEqual([LOCAL_DENIAL]);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("cancelled is not an answer: the call is denied, not approved", async () => {
    const client = new AcpProcessClient(shellFixture(["echo keryx-ran-this"]));
    try {
      const sessionId = await openSession(client);
      const { promptId, askId, toolCallId } = await promptUntilAsked(client, sessionId, "run it");

      client.send({ id: askId, result: { outcome: { outcome: "cancelled" } } });

      const closed = await resultUpdate(client, toolCallId);
      expect(closed.status).toBe("failed");
      expect(closed.rawOutput).toBe(LOCAL_DENIAL);
      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("a client that never answers denies the call instead of hanging the turn", async () => {
    const client = new AcpProcessClient(shellFixture(["echo keryx-ran-this"]));
    try {
      const sessionId = await openSession(client);
      const { promptId, toolCallId } = await promptUntilAsked(client, sessionId, "run it");

      // The client goes away with the question open. Nothing can answer it any
      // more — so it must settle as a denial, and the turn must still finish
      // and be REPORTED (stdout is still open), not die pending.
      client.send({ id: 999, method: "$/nothing" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const ended = client.end();

      const closed = await resultUpdate(client, toolCallId);
      expect(closed.status).toBe("failed");
      expect(closed.rawOutput).toBe(LOCAL_DENIAL);
      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });
      await ended;
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("a client that cannot answer the method is asked once, then denied locally", async () => {
    // There is no ACP capability to advertise for this (v1 `ClientCapabilities`
    // has no permission field), so "cannot be asked" is discovered from the
    // first answer. After that the call is denied WITHOUT a request going out:
    // the second gated call of the same turn never reaches the client.
    const client = new AcpProcessClient(shellFixture(["echo first-command", "echo second-command"]));
    try {
      const sessionId = await openSession(client);
      const { promptId, askId, toolCallId } = await promptUntilAsked(client, sessionId, "run them");

      client.send({ id: askId, error: { code: -32601, message: "Method not found" } });

      const first = await resultUpdate(client, toolCallId);
      expect(first.status).toBe("failed");
      expect(first.rawOutput).toBe(LOCAL_DENIAL);

      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      // Two gated calls in the turn, one question asked.
      const denials = client
        .updates("tool_call_update")
        .filter((m) => (m.params?.["update"] as { rawOutput?: unknown }).rawOutput === LOCAL_DENIAL);
      expect(denials.length).toBe(2);
      expect(client.permissionRequests()).toHaveLength(1);
      // Neither command ran: every tool result on this wire is the denial.
      expect(
        client
          .updates("tool_call_update")
          .map((m) => String((m.params?.["update"] as { rawOutput?: unknown }).rawOutput ?? "")),
      ).toEqual([LOCAL_DENIAL, LOCAL_DENIAL]);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("a call the driver refuses on its own never reaches the client", async () => {
    // AC3's other half: "a policy that denies outright never reaches the
    // client at all". A tool that is not on the session's roster is refused by
    // `executeCall` before any gate runs, and a read-risk tool auto-allows —
    // neither produces a question, so neither can be answered into running.
    const turns = [
      [
        { kind: "tool_call_start", toolCallId: "c0", toolName: "definitely_not_a_tool" },
        { kind: "tool_call_end", toolCallId: "c0", input: "{}" },
        { kind: "model_end" },
      ],
      [
        { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
        { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
        { kind: "model_end" },
      ],
      [{ kind: "text_delta", text: "done." }, { kind: "model_end" }],
    ];
    const fixture = path.join(root, "fixture-ungated.json");
    writeFileSync(fixture, JSON.stringify({ turns }), "utf8");

    const client = new AcpProcessClient(fixture);
    try {
      const sessionId = await openSession(client);
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      expect(client.permissionRequests()).toHaveLength(0);
      const outputs = client
        .updates("tool_call_update")
        .map((m) => String((m.params?.["update"] as { rawOutput?: unknown }).rawOutput ?? ""));
      expect(outputs.some((output) => output.includes("unknown tool: definitely_not_a_tool"))).toBe(true);
      // The read-risk tool ran with no question asked.
      expect(outputs.some((output) => output.includes(projectDir))).toBe(true);
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});
