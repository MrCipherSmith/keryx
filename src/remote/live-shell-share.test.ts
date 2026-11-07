import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { NormalizedMessage } from "../harness/provider/types";
import type { LiveShellCommand, LiveShellUpdate } from "../remote-control/live-shell";
import { liveShellHistory, LiveShellShare, parseHubShareCommand } from "./live-shell-share";

const previous: NormalizedMessage[] = [
  { role: "user", content: "Original terminal question" },
  { role: "assistant", content: "I'll inspect it", toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }] },
  { role: "tool", content: "private tool output", toolCallId: "1" },
  { role: "assistant", content: "Original terminal answer" },
];
const operationId = (): string => randomBytes(32).toString("hex");

test("Hub sharing is an explicit local subcommand and keeps Telegram topic syntax", () => {
  expect(parseHubShareCommand("/remote-control hub on")).toBe("on");
  expect(parseHubShareCommand("/remote-control hub off")).toBe("off");
  expect(parseHubShareCommand("/remote-control hub status")).toBe("status");
  expect(parseHubShareCommand("/remote-control hub attach")).toBe("usage");
  expect(parseHubShareCommand("/remote-control hub")).toBeUndefined();
});

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
