// Flow 397 (F-004): an approval is not "Allowed" in the topic because serve WROTE the decision to the
// shell's stream; it is "Allowed" because the shell said it RECEIVED it. These tests read the wire:
// a raw stream that never acknowledges stands for a shell that is stalled, and a fake serve behind the
// real client shows what the shell sends. Fake Bot API only.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { RemoteClient } from "./client";
import type { FakeSentMessage } from "./fake-bot-api";
import {
  DEFAULT_APPROVAL_ACK_MS,
  encodeSseEvent,
  REMOTE_SCHEMA_VERSION,
  remoteRoutePath,
} from "./protocol";
import { call, makeRig, openRawStream, type RawStream, type Rig, type ServeInstance, untilFrame } from "./remote.http.test-helpers";
import { OWNER_ID, settle, until } from "./remote.test-helpers";
import { derivedBearerNonce, readShellToken, SERVE_PROOF_HEADER, serveResponseProof } from "./shell-token";
import { BotApiError } from "./types";

let rig: Rig;
let made = false;
afterEach(async () => {
  if (made) {
    made = false;
    await rig.cleanup();
  }
});

const NOT_CONFIRMED = "not confirmed; the shell denies by itself if it did not receive it";

interface Asked {
  serve: ServeInstance;
  stream: RawStream;
  sessionId: string;
  threadId: number;
  approvalId: string;
  message: FakeSentMessage;
  allow: string;
  deny: string;
}

/** A registered session with a raw stream (it never acknowledges anything) and one approval asked of it. */
async function ask(sessionId: string, approvalAckMs?: number): Promise<Asked> {
  rig = makeRig();
  made = true;
  const serve = await rig.startServe(approvalAckMs === undefined ? {} : { service: { surface: { approvalAckMs } } });
  return askOn(serve, sessionId, "release");
}

async function askOn(serve: ServeInstance, sessionId: string, name: string): Promise<Asked> {
  const registered = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("register"), { sessionId, project: `/work/${name}`, name });
  expect(registered.status).toBe(200);
  const threadId = (registered.body as { threadId: number }).threadId;
  const stream = await openRawStream(serve.origin, serve.shellToken, sessionId);
  await untilFrame(stream, "status");
  const asked = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("approval"), { sessionId, prompt: "Run `bun test`?", timeoutMs: 20_000 });
  expect(asked.status).toBe(200);
  const approvalId = (asked.body as { approvalId: string }).approvalId;
  const find = (): FakeSentMessage | undefined => rig.api.sentTo(threadId).find((message) => message.inlineKeyboard !== undefined);
  await until(() => find() !== undefined, "the approval buttons");
  const message = find() as FakeSentMessage;
  const buttons = (message.inlineKeyboard ?? []).flat();
  const allow = buttons.find((button) => button.text === "Allow")?.callback_data;
  const deny = buttons.find((button) => button.text === "Deny")?.callback_data;
  if (allow === undefined || deny === undefined) {
    throw new Error("no Allow and Deny buttons");
  }
  return { serve, stream, sessionId, threadId, approvalId, message, allow, deny };
}

function press(a: Asked, data: string): void {
  rig.api.pushCallback({ fromId: OWNER_ID, data, threadId: a.threadId, messageId: a.message.messageId });
}

function ackApproval(
  a: Asked,
  approvalId: string = a.approvalId,
  sessionId: string = a.sessionId,
  applied?: unknown,
): Promise<{ status: number; body: unknown }> {
  return call(a.serve.origin, a.serve.shellToken, "POST", remoteRoutePath("approval-ack"), {
    sessionId,
    approvalId,
    ...(applied === undefined ? {} : { applied }),
  });
}

function shown(a: Asked): string {
  return rig.api.message(a.message.messageId)?.text ?? "";
}

function textsIn(a: Asked): string[] {
  return rig.api.sentTo(a.threadId).map((message) => message.text);
}

describe("serve finishes an approval only after the shell's ack (AC2)", () => {
  test("AC2: the default wait is 5000 ms", () => {
    expect(DEFAULT_APPROVAL_ACK_MS).toBe(5000);
  });

  test("AC2: with no ack the message ends as 'not confirmed' and nothing says granted", async () => {
    const a = await ask("sess-ak-0001", 250);
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    // The decision is on the wire, but nothing has been received: the question is not finished yet.
    expect(shown(a)).not.toContain("Allowed by");
    expect(shown(a)).not.toContain("not confirmed");

    await until(() => shown(a).includes("not confirmed"), "the not confirmed ending");
    expect(shown(a)).toContain(`Sent to the shell at `);
    expect(shown(a)).toContain(NOT_CONFIRMED);
    expect(shown(a)).not.toContain("Allowed by");
    expect(shown(a)).not.toContain("Denied by");
    expect(rig.api.message(a.message.messageId)?.inlineKeyboard).toBeUndefined();
    expect(textsIn(a)).not.toContain("Approval granted.");
  });

  test("AC2: when the edit fails, the one short reply does not say granted either", async () => {
    const a = await ask("sess-ak-0002", 150);
    rig.api.failNext("editMessageText", new BotApiError("rejected", "editMessageText: 400 Bad Request: message can't be edited", { status: 400 }));
    press(a, a.allow);
    await until(() => textsIn(a).some((text) => text.includes("not confirmed")), "the short reply");
    expect(textsIn(a).some((text) => text.includes("granted"))).toBe(false);
    expect(textsIn(a).filter((text) => text.includes("not confirmed"))).toHaveLength(1);
  });

  test("AC2: with the ack the message ends as Allowed, and only then", async () => {
    const a = await ask("sess-ak-0003");
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    await settle();
    await settle();
    expect(shown(a)).not.toContain("Allowed by");

    expect((await ackApproval(a)).status).toBe(200);
    await until(() => shown(a).includes("Allowed by user"), "the Allowed ending");
    expect(shown(a)).toContain(`Allowed by user ${OWNER_ID} at `);
    expect(shown(a)).not.toContain("not confirmed");
    expect(rig.api.message(a.message.messageId)?.inlineKeyboard).toBeUndefined();
  });

  test("AC2: Deny ends as Denied after the ack", async () => {
    const a = await ask("sess-ak-0004");
    press(a, a.deny);
    await untilFrame(a.stream, "approval");
    expect((await ackApproval(a)).status).toBe(200);
    await until(() => shown(a).includes("Denied by user"), "the Denied ending");
    expect(shown(a)).not.toContain("not confirmed");
  });

  test("AC2: a second press while the ack is awaited is not a second answer and changes nothing", async () => {
    const a = await ask("sess-ak-0005", 600);
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    const edits = rig.api.edits.length;
    const sent = textsIn(a).length;
    press(a, a.deny);
    press(a, a.allow);
    await settle();
    await settle();
    expect(a.stream.frames.filter((frame) => frame.event === "approval")).toHaveLength(1);
    expect(rig.api.edits).toHaveLength(edits);
    expect(textsIn(a)).toHaveLength(sent);
    expect(textsIn(a).some((text) => text.includes("no longer active"))).toBe(false);
    // The wait is still open: the ack finishes it as the FIRST press said.
    expect((await ackApproval(a)).status).toBe(200);
    await until(() => shown(a).includes("Allowed by user"), "the Allowed ending");
  });

  test("AC2: a shell that disconnects while the ack is awaited ends it as not confirmed at once", async () => {
    const a = await ask("sess-ak-0006", 20_000);
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    a.stream.close();
    await until(() => shown(a).includes("not confirmed"), "the not confirmed ending");
    expect(shown(a)).not.toContain("Allowed by");
  });
});

describe("the ack says whether the decision was applied (finding 2)", () => {
  test("F2: applied true ends as Allowed", async () => {
    const a = await ask("sess-ak-0030");
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    expect((await ackApproval(a, a.approvalId, a.sessionId, true)).status).toBe(200);
    await until(() => shown(a).includes("Allowed by user"), "the Allowed ending");
    expect(shown(a)).not.toContain("Not applied");
    expect(textsIn(a).some((text) => text.includes("Not applied"))).toBe(false);
  });

  test("F2: applied false ends as not applied, for Allow, and nothing says Allowed or granted", async () => {
    const a = await ask("sess-ak-0031");
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    expect((await ackApproval(a, a.approvalId, a.sessionId, false)).status).toBe(200);
    await until(() => shown(a).includes("Not applied"), "the not applied ending");
    expect(shown(a)).toContain(`Not applied at `);
    expect(shown(a)).toContain(`the Allow from user ${OWNER_ID} changed nothing`);
    expect(shown(a)).not.toContain("Allowed by");
    expect(shown(a)).not.toContain("not confirmed");
    expect(rig.api.message(a.message.messageId)?.inlineKeyboard).toBeUndefined();
    expect(textsIn(a).some((text) => text.includes("granted"))).toBe(false);
  });

  test("F2: when the edit fails, the one short reply says not applied, not granted", async () => {
    const a = await ask("sess-ak-0036");
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    rig.api.failNext("editMessageText", new BotApiError("rejected", "editMessageText: 400 Bad Request: message can't be edited", { status: 400 }));
    expect((await ackApproval(a, a.approvalId, a.sessionId, false)).status).toBe(200);
    await until(() => textsIn(a).some((text) => text.includes("Not applied")), "the short reply");
    expect(textsIn(a).some((text) => text.includes("granted"))).toBe(false);
    expect(textsIn(a).filter((text) => text.includes("Not applied"))).toHaveLength(1);
  });

  test("F2: applied false ends as not applied, for Deny", async () => {
    const a = await ask("sess-ak-0032");
    press(a, a.deny);
    await untilFrame(a.stream, "approval");
    expect((await ackApproval(a, a.approvalId, a.sessionId, false)).status).toBe(200);
    await until(() => shown(a).includes("Not applied"), "the not applied ending");
    expect(shown(a)).toContain(`the Deny from user ${OWNER_ID} changed nothing`);
    expect(shown(a)).not.toContain("Denied by");
  });

  test("F2: an ack with no applied field is an older shell's received-only ack and ends as Allowed", async () => {
    const a = await ask("sess-ak-0033");
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    expect((await ackApproval(a)).status).toBe(200);
    await until(() => shown(a).includes("Allowed by user"), "the Allowed ending");
    expect(shown(a)).not.toContain("Not applied");
  });

  test("F2: an applied that is not a boolean is refused with 400 and changes nothing", async () => {
    const a = await ask("sess-ak-0034", 300);
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    const calls = rig.api.calls.length;
    expect((await ackApproval(a, a.approvalId, a.sessionId, "yes")).status).toBe(400);
    await settle();
    expect(rig.api.calls).toHaveLength(calls);
    // The question is still waiting: the real ack still finishes it.
    expect((await ackApproval(a, a.approvalId, a.sessionId, true)).status).toBe(200);
    await until(() => shown(a).includes("Allowed by user"), "the Allowed ending");
  });

  test("F2: a late applied false after the not confirmed ending changes nothing", async () => {
    const a = await ask("sess-ak-0035", 150);
    press(a, a.allow);
    await until(() => shown(a).includes("not confirmed"), "the not confirmed ending");
    await settle();
    const text = shown(a);
    const calls = rig.api.calls.length;
    expect((await ackApproval(a, a.approvalId, a.sessionId, false)).status).toBe(200);
    await settle();
    expect(shown(a)).toBe(text);
    expect(rig.api.calls).toHaveLength(calls);
  });
});

describe("an ack that should change nothing (AC3)", () => {
  test("AC3: an ack after the not confirmed ending adds no edit and no message", async () => {
    const a = await ask("sess-ak-0010", 150);
    press(a, a.allow);
    await until(() => shown(a).includes("not confirmed"), "the not confirmed ending");
    await settle();
    const calls = rig.api.calls.length;
    const sent = textsIn(a).length;
    const text = shown(a);

    const late = await ackApproval(a);
    expect(late.status).toBe(200);
    await settle();
    await settle();
    expect(rig.api.calls).toHaveLength(calls);
    expect(textsIn(a)).toHaveLength(sent);
    expect(shown(a)).toBe(text);
  });

  test("AC3: a repeated ack after the confirmed ending adds no edit and no message", async () => {
    const a = await ask("sess-ak-0011");
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    expect((await ackApproval(a)).status).toBe(200);
    await until(() => shown(a).includes("Allowed by user"), "the Allowed ending");
    await settle();
    const calls = rig.api.calls.length;
    const text = shown(a);
    expect((await ackApproval(a)).status).toBe(200);
    await settle();
    await settle();
    expect(rig.api.calls).toHaveLength(calls);
    expect(shown(a)).toBe(text);
  });

  test("AC3: an ack for an approval id serve never issued is refused with 404 and changes nothing", async () => {
    const a = await ask("sess-ak-0012", 150);
    press(a, a.allow);
    await until(() => shown(a).includes("not confirmed"), "the not confirmed ending");
    await settle();
    const calls = rig.api.calls.length;
    const refused = await ackApproval(a, "ap000000000000");
    expect(refused.status).toBe(404);
    const malformed = await ackApproval(a, "not-an-id");
    expect(malformed.status).toBe(400);
    await settle();
    expect(rig.api.calls).toHaveLength(calls);
  });

  test("AC3: an ack from another session for this session's approval is refused with 404 and does not confirm it", async () => {
    const a = await ask("sess-ak-0013", 500);
    const other = await askOn(a.serve, "sess-ak-0014", "beta");
    press(a, a.allow);
    await untilFrame(a.stream, "approval");
    const calls = rig.api.calls.length;

    const foreign = await call(a.serve.origin, a.serve.shellToken, "POST", remoteRoutePath("approval-ack"), { sessionId: other.sessionId, approvalId: a.approvalId });
    expect(foreign.status).toBe(404);
    await settle();
    await settle();
    expect(rig.api.calls).toHaveLength(calls);
    expect(shown(a)).not.toContain("Allowed by");

    // Not confirmed by anyone who could: it runs out as not confirmed, never as Allowed.
    await until(() => shown(a).includes("not confirmed"), "the not confirmed ending");
    expect(shown(a)).not.toContain("Allowed by");
  });
});

// ---- the shell's side (AC1, AC5) ----------------------------------------------------------------

interface FakeServe {
  fetchImpl: typeof fetch;
  acks: Array<{ sessionId: string; approvalId: string; applied?: boolean }>;
  /** Frames to push down the stream (the next and later streams). */
  push(frame: string): void;
  /** Make the ack route answer with this status. */
  ackStatus: number;
  /** Make the ack post itself fail (a connection that dies), instead of answering. */
  throwAcks: boolean;
  /** Run (and wait for) this before the approval request is answered, so a frame can beat its own response. */
  beforeApprovalResponse: (() => Promise<void>) | undefined;
  /** End the current stream from serve's side, as a restart would. */
  endStream(): void;
  /** Hold the ack answers until released. */
  holdAcks: boolean;
  releaseAcks(): void;
  /** Whether the stream headers carry serve's proof. */
  proven: boolean;
  streamsOpened: number;
  log: string[];
}

/** A serve that signs its answers like the real one, with a stream the test writes to. */
function fakeServe(dir: string, order: string[] = []): FakeServe {
  const token = readShellToken(dir);
  if (!token.ok) {
    throw new Error("no shell token in the rig");
  }
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const held: Array<() => void> = [];
  const state: FakeServe = {
    acks: [],
    ackStatus: 200,
    throwAcks: false,
    beforeApprovalResponse: undefined,
    endStream() {
      controller?.close();
    },
    holdAcks: false,
    proven: true,
    streamsOpened: 0,
    log: order,
    push(frame) {
      controller?.enqueue(encoder.encode(frame));
    },
    releaseAcks() {
      state.holdAcks = false;
      for (const release of held.splice(0)) {
        release();
      }
    },
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const authorization = request.headers.get("authorization") ?? "";
      const nonce = derivedBearerNonce(authorization.replace(/^Bearer /i, "").trim()) ?? "";
      const route = new URL(request.url).pathname.split("/").pop() ?? "";
      const json = (status: number, body: Record<string, unknown>): Response => {
        const text = JSON.stringify({ schemaVersion: REMOTE_SCHEMA_VERSION, ...body });
        return new Response(text, { status, headers: { "content-type": "application/json", [SERVE_PROOF_HEADER]: serveResponseProof(token.value, nonce, route, status, text) } });
      };
      switch (route) {
        case "register":
          return json(200, { name: "fake", threadId: 7, reused: false, runTimeoutMs: 60_000 });
        case "approval":
          await state.beforeApprovalResponse?.();
          return json(200, { approvalId: "ap0000000000aa", expiresAt: Date.now() + 60_000 });
        case "approval-ack": {
          state.acks.push(JSON.parse(await request.text()) as { sessionId: string; approvalId: string; applied?: boolean });
          state.log.push("ack");
          if (state.throwAcks) {
            throw new Error("connection reset");
          }
          if (state.holdAcks) {
            await new Promise<void>((resolve) => held.push(resolve));
          }
          return json(state.ackStatus, state.ackStatus === 200 ? { acknowledged: true } : { error: "refused" });
        }
        case "stream": {
          state.streamsOpened += 1;
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              // A real stream ends when the shell aborts it; without this the client's read never returns.
              request.signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
              c.enqueue(encoder.encode(encodeSseEvent("status", { kind: "ready" })));
              if (!state.proven) {
                // What a squatter would do: a frame straight away, behind headers that prove nothing.
                c.enqueue(encoder.encode(encodeSseEvent("approval", { updateId: 1, approvalId: "ap0000000000aa", decision: "allow" }, 1)));
              }
            },
          });
          const headers: Record<string, string> = { "content-type": "text/event-stream" };
          if (state.proven) {
            headers[SERVE_PROOF_HEADER] = serveResponseProof(token.value, nonce, "stream", 200, "");
          }
          return new Response(body, { headers });
        }
        default:
          return json(200, {});
      }
    }) as typeof fetch,
  };
  return state;
}

const APPROVAL = "ap0000000000aa";

function approvalFrame(approvalId: string, decision: "allow" | "deny", updateId = 1): string {
  return encodeSseEvent("approval", { updateId, approvalId, decision }, updateId);
}

async function shellWithFakeServe(options: {
  onUnconfirmedChange?: () => void;
  order?: string[];
  proven?: boolean;
  onApprovalFrame?: (frame: { approvalId: string; decision: string; applied: boolean }) => void;
  earlyDecisionMs?: number;
} = {}): Promise<{ client: RemoteClient; fake: FakeServe }> {
  rig = makeRig();
  made = true;
  await rig.startServe();
  const fake = fakeServe(rig.dir, options.order);
  fake.proven = options.proven ?? true;
  const client = rig.makeClient({
    sessionId: "sess-ak-0020",
    project: "/work/app",
    name: "release",
    onLine: () => undefined,
    fetchImpl: fake.fetchImpl,
    // Short unless a test is about the parking itself: nothing here depends on the 2 s default.
    earlyDecisionMs: options.earlyDecisionMs ?? 40,
    ...(options.onApprovalFrame === undefined ? {} : { onApprovalFrame: options.onApprovalFrame }),
    ...(options.onUnconfirmedChange === undefined ? {} : { onUnconfirmedChange: options.onUnconfirmedChange }),
  });
  const started = await client.start();
  if (!started.ok) {
    throw new Error(`the shell did not start: ${started.message}`);
  }
  await until(() => client.connected, "the stream to open");
  return { client, fake };
}

/** A question the shell is waiting on (its id is the fake serve's APPROVAL), and the frame that answers it. */
async function askAndAnswer(client: RemoteClient, fake: FakeServe, decision: "allow" | "deny", updateId = 1): Promise<"allow" | "deny"> {
  const asked = client.requestApproval("Run it?", 10_000);
  await settle();
  fake.push(approvalFrame(APPROVAL, decision, updateId));
  return asked;
}

describe("the shell acknowledges an approval frame (AC1)", () => {
  test("AC1: a frame is acknowledged once, a repeat again, and the waiter resolves once", async () => {
    const seen: string[] = [];
    const { client, fake } = await shellWithFakeServe({ onApprovalFrame: (frame) => seen.push(`${frame.approvalId}:${frame.decision}`) });
    const decision = client.requestApproval("Run it?", 10_000);
    await settle();
    fake.push(approvalFrame(APPROVAL, "allow"));
    expect(await decision).toBe("allow");
    await until(() => fake.acks.length === 1, "the first ack");
    expect(fake.acks[0]).toEqual({ sessionId: "sess-ak-0020", approvalId: APPROVAL, applied: true });

    // The same frame again (a resend after a lost ack): acknowledged again, but not acted on twice.
    fake.push(approvalFrame(APPROVAL, "allow"));
    await until(() => fake.acks.length === 2, "the second ack");
    await settle();
    expect(fake.acks).toHaveLength(2);
    expect(seen).toEqual([`${APPROVAL}:allow`]);
  });

  test("AC1: a repeat with another decision does not change what the waiter got", async () => {
    const { client, fake } = await shellWithFakeServe();
    const decision = client.requestApproval("Run it?", 10_000);
    await settle();
    fake.push(approvalFrame(APPROVAL, "deny"));
    expect(await decision).toBe("deny");
    fake.push(approvalFrame(APPROVAL, "allow"));
    await until(() => fake.acks.length === 2, "the second ack");
    await settle();
    expect(fake.acks).toHaveLength(2);
  });

  test("AC1: a frame on an unproven stream is neither acted on nor acknowledged", async () => {
    rig = makeRig();
    made = true;
    await rig.startServe();
    const fake = fakeServe(rig.dir);
    fake.proven = false;
    const seen: string[] = [];
    const client = rig.makeClient({ sessionId: "sess-ak-0021", project: "/work/app", onLine: () => undefined, fetchImpl: fake.fetchImpl, onApprovalFrame: (frame) => seen.push(frame.approvalId) });
    void client.start();
    // The stream is asked for (and carries a decision frame right away), but its headers prove nothing.
    await until(() => fake.streamsOpened >= 1, "a stream attempt");
    await settle();
    await settle();
    expect(client.connected).toBe(false);
    expect(fake.acks).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect(client.unconfirmedApprovals).toBe(0);
  });
});

describe("the shell says what it received, and counts what serve has not confirmed (AC5)", () => {
  test("AC5: the decision is said once, before the ack is posted", async () => {
    const order: string[] = [];
    const { client, fake } = await shellWithFakeServe({ order, onApprovalFrame: (frame) => order.push(`line:${frame.approvalId}:${frame.decision}`) });
    await askAndAnswer(client, fake, "allow");
    await until(() => fake.acks.length === 1, "the ack");
    expect(order).toEqual([`line:${APPROVAL}:allow`, "ack"]);
  });

  test("AC5: the counter rises while the ack is unconfirmed and clears once serve confirms, repainting both times", async () => {
    let changes = 0;
    const { client, fake } = await shellWithFakeServe({ onUnconfirmedChange: () => void (changes += 1) });
    expect(client.unconfirmedApprovals).toBe(0);
    fake.holdAcks = true;
    await askAndAnswer(client, fake, "allow");
    await until(() => fake.acks.length === 1, "the ack to be in flight");
    expect(client.unconfirmedApprovals).toBe(1);
    expect(changes).toBe(1);
    fake.releaseAcks();
    await until(() => client.unconfirmedApprovals === 0, "the counter to clear");
    expect(changes).toBe(2);
  });

  test("AC5: an ack serve refuses stays counted", async () => {
    const { client, fake } = await shellWithFakeServe();
    fake.ackStatus = 404;
    await askAndAnswer(client, fake, "deny");
    await until(() => fake.acks.length === 1, "the ack");
    await settle();
    await settle();
    expect(client.unconfirmedApprovals).toBe(1);
  });

  test("AC5: an ack whose post throws stays counted", async () => {
    const { client, fake } = await shellWithFakeServe();
    fake.throwAcks = true;
    await askAndAnswer(client, fake, "allow");
    await until(() => fake.acks.length === 1, "the ack attempt");
    await settle();
    await settle();
    expect(client.unconfirmedApprovals).toBe(1);
  });

  test("AC5: an unconfirmed approval ages out of the counter after a minute", async () => {
    const real = Date.now;
    let now = real();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { client, fake } = await shellWithFakeServe();
      fake.ackStatus = 404;
      await askAndAnswer(client, fake, "deny");
      await until(() => fake.acks.length === 1, "the ack");
      await settle();
      expect(client.unconfirmedApprovals).toBe(1);
      now += 59_000;
      expect(client.unconfirmedApprovals).toBe(1);
      now += 2_000;
      expect(client.unconfirmedApprovals).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  test("AC5: only the 64 most recent unconfirmed approvals are kept", async () => {
    const { client, fake } = await shellWithFakeServe();
    fake.ackStatus = 404;
    const id = (n: number): string => `ap${n.toString(16).padStart(12, "0")}`;
    for (let n = 1; n <= 65; n += 1) {
      fake.push(approvalFrame(id(n), "allow", n));
    }
    await until(() => fake.acks.length === 65, "all 65 acks");
    await settle();
    expect(client.unconfirmedApprovals).toBe(64);
    // The oldest was the one dropped: a repeat of it counts again (and evicts the next oldest), so the count stays at the bound.
    fake.push(approvalFrame(id(1), "allow", 66));
    await until(() => fake.acks.length === 66, "the repeat's ack");
    await settle();
    expect(client.unconfirmedApprovals).toBe(64);
  });

  test("AC5: an ack that finishes after the shell stopped adds no timer and repaints nothing", async () => {
    let changes = 0;
    const { client, fake } = await shellWithFakeServe({ onUnconfirmedChange: () => void (changes += 1) });
    fake.holdAcks = true;
    await askAndAnswer(client, fake, "allow");
    await until(() => fake.acks.length === 1, "the ack to be in flight");
    expect(changes).toBe(1);
    await client.drop();
    fake.releaseAcks();
    await settle();
    await settle();
    expect(changes).toBe(1);
    expect((client as unknown as { lingerTimers: Set<unknown> }).lingerTimers.size).toBe(0);
  });
});

describe("the ack says whether the decision was applied to a live question (finding 2)", () => {
  test("F2: a decision for a question that is waiting is applied, said as allowed, and acked applied true", async () => {
    const seen: Array<{ decision: string; applied: boolean }> = [];
    const { client, fake } = await shellWithFakeServe({ onApprovalFrame: (frame) => seen.push({ decision: frame.decision, applied: frame.applied }) });
    expect(await askAndAnswer(client, fake, "allow")).toBe("allow");
    await until(() => fake.acks.length === 1, "the ack");
    expect(fake.acks[0]?.applied).toBe(true);
    expect(seen).toEqual([{ decision: "allow", applied: true }]);
  });

  test("F2: a decision for an id nothing asked is not applied: said as not applied, acked applied false, and never allowed", async () => {
    const seen: Array<{ decision: string; applied: boolean }> = [];
    const { client, fake } = await shellWithFakeServe({ onApprovalFrame: (frame) => seen.push({ decision: frame.decision, applied: frame.applied }) });
    fake.push(approvalFrame(APPROVAL, "allow"));
    await until(() => fake.acks.length === 1, "the ack");
    expect(fake.acks[0]).toEqual({ sessionId: "sess-ak-0020", approvalId: APPROVAL, applied: false });
    expect(seen).toEqual([{ decision: "allow", applied: false }]);
    // A question that asks later does not inherit the stale decision.
    const late = client.requestApproval("Run it?", 150);
    expect(await late).toBe("deny");
  });

  test("F2: a decision that arrives after the shell gave up on the question is not applied", async () => {
    const seen: boolean[] = [];
    const { client, fake } = await shellWithFakeServe({ onApprovalFrame: (frame) => seen.push(frame.applied) });
    expect(await client.requestApproval("Run it?", 30)).toBe("deny");
    fake.push(approvalFrame(APPROVAL, "allow"));
    await until(() => fake.acks.length === 1, "the ack");
    expect(fake.acks[0]?.applied).toBe(false);
    expect(seen).toEqual([false]);
  });

  test("F2: a frame that beats its question's response is parked, and acked applied only once that question takes it", async () => {
    const seen: boolean[] = [];
    const { client, fake } = await shellWithFakeServe({ earlyDecisionMs: 10_000, onApprovalFrame: (frame) => seen.push(frame.applied) });
    let acksBefore = -1;
    let sawBefore = -1;
    fake.beforeApprovalResponse = async () => {
      fake.push(approvalFrame(APPROVAL, "allow"));
      await settle();
      await settle();
      acksBefore = fake.acks.length;
      sawBefore = seen.length;
    };
    expect(await client.requestApproval("Run it?", 10_000)).toBe("allow");
    // Nothing was said or acked while it was only parked.
    expect(acksBefore).toBe(0);
    expect(sawBefore).toBe(0);
    await until(() => fake.acks.length === 1, "the ack");
    expect(fake.acks[0]?.applied).toBe(true);
    expect(seen).toEqual([true]);
  });

  test("F2: a parked decision nobody claims within the short bound is acked applied false", async () => {
    const { client, fake } = await shellWithFakeServe({ earlyDecisionMs: 60 });
    fake.push(approvalFrame(APPROVAL, "allow"));
    await settle();
    expect(fake.acks).toHaveLength(0);
    await until(() => fake.acks.length === 1, "the ack after the bound");
    expect(fake.acks[0]?.applied).toBe(false);
    expect(client.unconfirmedApprovals).toBe(0);
  });

  test("F2: a stream that ends settles a parked decision as not applied at once", async () => {
    const seen: boolean[] = [];
    const { fake } = await shellWithFakeServe({ earlyDecisionMs: 30_000, onApprovalFrame: (frame) => seen.push(frame.applied) });
    fake.push(approvalFrame(APPROVAL, "allow"));
    await settle();
    expect(fake.acks).toHaveLength(0);
    fake.endStream();
    await until(() => fake.acks.length === 1, "the ack after the stream ended");
    expect(fake.acks[0]?.applied).toBe(false);
    expect(seen).toEqual([false]);
  });

  test("F2: a repeat of a frame that was not applied is acked again as not applied, and is not said twice", async () => {
    const seen: boolean[] = [];
    const { fake } = await shellWithFakeServe({ onApprovalFrame: (frame) => seen.push(frame.applied) });
    fake.push(approvalFrame(APPROVAL, "allow"));
    await until(() => fake.acks.length === 1, "the first ack");
    fake.push(approvalFrame(APPROVAL, "allow", 2));
    await until(() => fake.acks.length === 2, "the repeat's ack");
    expect(fake.acks.map((ack) => ack.applied)).toEqual([false, false]);
    expect(seen).toEqual([false]);
  });
});
