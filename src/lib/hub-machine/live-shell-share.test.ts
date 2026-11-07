import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { NormalizedMessage } from "../../harness/provider/types";
import { liveShellContextHeader, type LiveShellCommand, type LiveShellContext, type LiveShellUpdate } from "../../remote-control/live-shell";
import { liveShellHistory, LiveShellShare } from "./live-shell-share";

const previous: NormalizedMessage[] = [
  { role: "user", content: "Original terminal question" },
  { role: "assistant", content: "I'll inspect it", toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }] },
  { role: "tool", content: "private tool output", toolCallId: "1" },
  { role: "assistant", content: "Original terminal answer" },
];
const operationId = (): string => randomBytes(32).toString("hex");

test("shares only human-facing history, redacts secrets, and excludes an unfinished assistant message", () => {
  const secret = "-----BEGIN PRIVATE KEY-----";
  const messages = liveShellHistory([
    ...previous,
    { role: "user", content: `Copied: ${secret}` },
    { role: "assistant", content: "Unfinished" },
  ], true);
  expect(messages.slice(0, 2)).toEqual([
    { role: "user", text: "Original terminal question" },
    { role: "assistant", text: "Original terminal answer" },
  ]);
  expect(messages).toHaveLength(3);
  expect(messages[2]?.text).not.toContain(secret);
  expect(JSON.stringify(messages)).not.toContain("private tool output");
});

test("shares native history, rejects a busy race, deduplicates delivery, pins Stop, and detaches on a session switch", async () => {
  let nativeSession = "first-session";
  let busy = false;
  const shellId = randomUUID();
  const turnId = randomUUID();
  const busyMessage: LiveShellCommand = { id: operationId(), kind: "message", text: "preserve me in the browser" };
  const message: LiveShellCommand = { id: operationId(), kind: "message", text: "/exit is literal input" };
  const staleStop: LiveShellCommand = { id: operationId(), kind: "stop", turnId: randomUUID() };
  const stop: LiveShellCommand = { id: operationId(), kind: "stop", turnId };
  const lateMessage: LiveShellCommand = { id: operationId(), kind: "message", text: "do not enter the next shell" };
  const commands = [busyMessage, message, message, staleStop, stop, lateMessage];
  const updates: LiveShellUpdate[] = [];
  const submitted: string[] = [];
  const stopped: string[] = [];
  const detached = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "DELETE") {
        detached.resolve();
        return new Response(null, { status: 204 });
      }
      const index = updates.length;
      updates.push(await request.json() as LiveShellUpdate);
      if (index === 0) busy = true; // The local operator started a turn after the idle heartbeat.
      if (index === 1) busy = false;
      if (index === 2) busy = true;
      if (index === 5) nativeSession = "second-session";
      return Response.json({ command: commands[index] ?? null });
    },
  });
  const share = new LiveShellShare({
    sessionId: () => nativeSession,
    history: () => previous,
    isBusy: () => busy,
    turnId: () => busy ? turnId : undefined,
    submit: (text) => { submitted.push(text); return true; },
    stop: (id) => { stopped.push(id); return true; },
    notice: () => {},
  }, { url: new URL(`/hub/v2/machines/demo/live-shells/${shellId}`, server.url).href, headers: {}, projectId: "project", checkoutId: "checkout" });
  try {
    share.start();
    await detached.promise;
    expect(updates[0]).toMatchObject({ projectId: "project", checkoutId: "checkout", busy: false });
    expect(updates[1]).toMatchObject({ busy: true, turnId });
    expect(updates[0]?.messages?.[0]).toEqual({ role: "user", text: "Original terminal question" });
    expect(updates.slice(1).map((update) => update.ack)).toEqual([
      { id: busyMessage.id, status: "rejected" },
      { id: message.id, status: "applied" },
      { id: message.id, status: "applied" },
      { id: staleStop.id, status: "rejected" },
      { id: stop.id, status: "applied" },
    ]);
    expect(submitted).toEqual([message.text]);
    expect(stopped).toEqual([turnId]);
    expect(share.active).toBe(false);
  } finally {
    await share.close();
    await server.stop(true);
  }
}, 15_000);

test("negotiates context, rechecks the local approval and deduplicates an applied decision", async () => {
  const originalApproval = { id: randomUUID(), tool: "shell_exec", summary: "echo one", reason: "Approval required", canAnswer: true };
  const nextApproval = { ...originalApproval, id: randomUUID(), summary: "echo two" };
  let approval: LiveShellContext["approval"] = originalApproval;
  const stale: LiveShellCommand = { id: operationId(), kind: "answer-approval", approvalId: originalApproval.id, decision: "allow" };
  const current: LiveShellCommand = { id: operationId(), kind: "answer-approval", approvalId: nextApproval.id, decision: "deny" };
  const invoke: LiveShellCommand = { id: operationId(), kind: "invoke", name: "status" };
  const commands = [null, stale, current, current, invoke, null];
  const updates: LiveShellUpdate[] = [];
  const decisions: unknown[] = [];
  const checked = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const update = await request.json() as LiveShellUpdate;
      const index = updates.push(update) - 1;
      if (index === 1) approval = nextApproval; // The local dock changed after the heartbeat.
      if (index === 5) return new Response(null, { status: 503 });
      if (index === 7) checked.resolve();
      const headers = new Headers();
      if (index < 6) headers.set(liveShellContextHeader, "1");
      return Response.json({ command: commands[index] ?? null }, { headers });
    },
  });
  const share = new LiveShellShare({
    sessionId: () => "shared-session",
    history: () => previous,
    isBusy: () => approval !== undefined,
    turnId: () => undefined,
    submit: () => false,
    stop: () => false,
    notice: () => {},
    inspect: () => ({
      ...(approval ? { approval } : {}),
      commands: [{ name: "status", description: "Show status" }],
    }),
    answerApproval: (id, decision) => {
      decisions.push({ id, decision });
      approval = undefined;
      return true;
    },
    invoke: () => ({ output: "-----BEGIN PRIVATE KEY-----" }),
  }, { url: server.url.href, headers: {}, projectId: "project", checkoutId: "checkout" });
  try {
    share.start();
    await checked.promise;
    expect(updates[0]?.context).toBeUndefined();
    expect(updates[1]?.context?.approval?.id).toBe(originalApproval.id);
    expect(updates[2]?.ack).toEqual({ id: stale.id, status: "rejected" });
    expect(updates[3]?.ack).toEqual({ id: current.id, status: "applied" });
    expect(updates[4]?.ack).toEqual({ id: current.id, status: "applied" });
    expect(updates[5]?.ack).toEqual({ id: invoke.id, status: "applied", output: "[REDACTED:secret]" });
    expect(updates[6]?.ack).toEqual(updates[5]?.ack);
    expect(updates[7]?.context).toBeUndefined();
    expect(decisions).toEqual([{ id: nextApproval.id, decision: "deny" }]);
  } finally {
    await share.close();
    await server.stop(true);
  }
}, 15_000);
