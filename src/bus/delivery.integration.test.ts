// Flow 274 (agent bus P3, T8; AC2, AC4, AC5, AC6, AC7) — end-to-end DELIVERY
// tests that the unit-level suites don't cover: a real temp git repo, real
// bus files (`appendEvent`/`readEvents`/`writePresence`, the same modules
// `BusClient` itself is built from), real `BusInbox`es, `buildBusTools`, and
// scripted providers driving the real `runAgentTurn`.
//
// Two-identity caveat: `BusClient.instanceId` is always `processInstanceId()`
// (`../session/lease.ts`), a value memoized ONCE PER PROCESS. A single test
// process can therefore hold only one identity via a real `joinBus()` call —
// which is exactly why every existing real-bus test that needs a "peer"
// (`client.test.ts`, `client-ack.test.ts`) builds that peer by calling
// `writePresence`/`appendEvent` directly rather than a second `joinBus()`.
// This file follows the same convention for BOTH sides of every exchange:
// `makePeer` below gives each side an explicit instanceId and wires a real
// `BusClient`-shaped object from the SAME underlying primitives `joinBus`
// itself uses (`sendMessage`, `appendEvent`, `readEvents`, `writePresence`),
// so every event, presence record and ack in these tests is real, on disk,
// under a real git repo — only the join/heartbeat/poll-timer ORCHESTRATION
// layer (already covered by `client.test.ts`/`client-ack.test.ts`) is
// swapped for direct, test-driven calls (poll on demand, no timers).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn, resolveMaxAutoWake } from "../commands/agent";
import type { AgentDeps, AgentIO } from "../commands/agent";
import { buildBusTools } from "./agent-tools";
import type { BusClient, RenderedBusEvent, ResolvedBusRef } from "./client";
import { BusRefusal } from "./errors";
import { createBusInbox, type BusInbox } from "./inbox";
import { appendEvent, cursorAtEnd, cursorAtStart, readEvents, type BusCursor } from "./log";
import { resolveBusRoot } from "./paths";
import { writePresence } from "./presence";
import { sendMessage, type SendableKind } from "./send";
import { createBusWakeController } from "../tui/bus-wake";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type {
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  ProviderDescription,
} from "../harness/provider/types";

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-delivery-"));
  ROOTS.push(dir);
  await writeFile(path.join(dir, "README.md"), "x\n", "utf8");
  await git(dir, "init", "-b", "main");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "initial");
  return dir;
}

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const now = (): number => NOW;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// A real (non-`joinBus`) bus peer — see the file-header comment for why.
// ---------------------------------------------------------------------------

interface Peer {
  instanceId: string;
  name: string;
  root: string;
  busInbox: BusInbox;
  client: BusClient;
  /** Real `readEvents` since the last poll; pushes every renderable, addressed-to-me event into `busInbox` (mirrors `shell.ts`'s `onEvent` wiring). Returns what it delivered. */
  poll(): Promise<RenderedBusEvent[]>;
}

async function makePeer(root: string, instanceId: string, name: string): Promise<Peer> {
  await writePresence(root, {
    schemaVersion: 1,
    instanceId,
    name,
    pid: process.pid,
    host: "test-host",
    sessionId: instanceId, // any UUID; not exercised by these tests
    checkout: "/repo",
    branch: null,
    surface: "readline",
    status: "idle",
    activity: "",
    startedAt: new Date(now()).toISOString(),
    heartbeatAt: new Date(now()).toISOString(),
    keryxVersion: "0.0.0-test",
  });

  let cursor: BusCursor = await cursorAtEnd(root);
  // Simplified `resolveRef` (mirrors `client.ts`'s `resolveRefImpl`): these
  // tests always pass the literal full event id as `replyTo`, never a #seq
  // or short prefix, so a plain id match is enough — the prefix/seq
  // resolution itself is already covered by `client.test.ts`.
  const renderedStore: RenderedBusEvent[] = [];

  async function poll(): Promise<RenderedBusEvent[]> {
    const read = await readEvents(root, cursor);
    cursor = read.cursor;
    const delivered: RenderedBusEvent[] = [];
    for (const event of read.events) {
      const addressedToMe = event.to.includes(instanceId) || (event.to.length === 1 && event.to[0] === "*" && event.from.instanceId !== instanceId);
      if (!addressedToMe) continue;
      if (event.kind === "ack" || event.kind === "override" || event.kind === "lease-expired") continue;
      const rendered: RenderedBusEvent = {
        id: event.id,
        seq: event.seq,
        shortId: event.id.slice(0, 8),
        fromName: event.from.name,
        fromInstanceId: event.from.instanceId,
        kind: event.kind,
        preview: (event.body ?? "").slice(0, 160),
        body: event.body ?? "",
        toStar: event.to.length === 1 && event.to[0] === "*",
        ...(event.refs?.replyTo !== undefined ? { replyTo: event.refs.replyTo } : {}),
      };
      renderedStore.push(rendered);
      delivered.push(rendered);
      busInbox.push({ ...rendered, body: rendered.body ?? "" });
    }
    return delivered;
  }

  function resolveRefImpl(ref: string): ResolvedBusRef | undefined {
    const found = renderedStore.find((event) => event.id === ref.trim());
    return found === undefined ? undefined : { id: found.id, seq: found.seq, fromInstanceId: found.fromInstanceId, fromName: found.fromName };
  }

  const busInbox = createBusInbox();
  const client: BusClient = {
    instanceId,
    root,
    nameWasTaken: false,
    get name() {
      return name;
    },
    peers: () => [],
    async setSession() {},
    async rename() {},
    async send(toLabel, kind, body, replyTo) {
      return sendMessage(root, {
        toLabel,
        kind,
        body,
        ...(replyTo !== undefined ? { replyTo } : {}),
        origin: "operator",
        from: { instanceId, name, origin: "operator" },
        now,
        liveness: { isAlive: () => true, host: "test-host" },
        env: {},
      });
    },
    resolveRef: resolveRefImpl,
    async reply(ref, body) {
      const resolved = resolveRefImpl(ref);
      if (resolved === undefined) {
        throw new BusRefusal("unknown-message", `no rendered message matches ${JSON.stringify(ref)}`);
      }
      return sendMessage(root, {
        toLabel: `@${resolved.fromName}`,
        kind: "reply",
        body,
        replyTo: resolved.id,
        toInstanceId: resolved.fromInstanceId,
        origin: "operator",
        from: { instanceId, name, origin: "operator" },
        now,
        liveness: { isAlive: () => true, host: "test-host" },
        env: {},
      });
    },
    async sendAsAgent(toLabel, kind, body) {
      return sendMessage(root, {
        toLabel,
        kind,
        body,
        origin: "agent",
        from: { instanceId, name, origin: "agent" },
        now,
        liveness: { isAlive: () => true, host: "test-host" },
        env: {},
      });
    },
    async replyAsAgent(ref, body) {
      const resolved = resolveRefImpl(ref);
      if (resolved === undefined) {
        throw new BusRefusal("unknown-message", `no rendered message matches ${JSON.stringify(ref)}`);
      }
      return sendMessage(root, {
        toLabel: `@${resolved.fromName}`,
        kind: "reply",
        body,
        replyTo: resolved.id,
        toInstanceId: resolved.fromInstanceId,
        origin: "agent",
        from: { instanceId, name, origin: "agent" },
        now,
        liveness: { isAlive: () => true, host: "test-host" },
        env: {},
      });
    },
    pollNow: async () => [],
    ack(events) {
      for (const event of events) {
        void appendEvent(
          root,
          {
            from: { instanceId, name, origin: "system" },
            to: [event.fromInstanceId],
            toLabel: `@${event.fromName}`,
            kind: "ack",
            refs: { replyTo: event.id },
          },
          { now },
        );
      }
    },
    leave() {},
  };

  return { instanceId, name, root, busInbox, client, poll };
}

const PEER_A_ID = "00000000-0000-4000-8000-0000000000a1";
const PEER_B_ID = "00000000-0000-4000-8000-0000000000b1";

// ---------------------------------------------------------------------------
// Scripted providers.
// ---------------------------------------------------------------------------

function providerDescription(): ProviderDescription {
  return {
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "scripted" },
  };
}

/** One script (array of event batches) consumed per `stream()` call, in order — mirrors `agent-bus-notification.test.ts`'s helper. */
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): {
  provider: AgentDeps["provider"];
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let call = 0;
  const description = providerDescription();
  return {
    requests,
    provider: {
      describe: () => description,
      stream: (request, opts) => {
        requests.push(request);
        const events = scripts[call] ?? [];
        call += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) {
            yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

/**
 * Always answers a pending `<peer-message kind="question"|"reply">` with a
 * `bus_send` reply (AC6's "always answer" agent): when the request's last
 * message is NOT a tool result, it finds the newest peer-message block and
 * calls `bus_send` with `kind: "reply"`, `replyTo` set to that block's `id`;
 * once the reply's tool result comes back (the next round), it finishes with
 * plain text so the turn ends.
 */
function autoReplyProvider(replyBody: string): { provider: AgentDeps["provider"]; sentReplyTo: string[] } {
  const sentReplyTo: string[] = [];
  const description = providerDescription();
  return {
    sentReplyTo,
    provider: {
      describe: () => description,
      stream: (request, opts) => {
        const last = request.messages[request.messages.length - 1];
        const justRanTool = last?.role === "tool";
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          if (justRanTool) {
            yield { sequence: sequence++, attemptId: opts.attemptId, kind: "text_delta", text: "sent" } as NormalizedEvent;
            yield { sequence, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
            return;
          }
          const peerMessage = [...request.messages].reverse().find(
            (m) => typeof m.content === "string" && m.content.includes("<peer-message"),
          );
          const content = typeof peerMessage?.content === "string" ? peerMessage.content : "";
          const id = /id="([^"]+)"/.exec(content)?.[1] ?? "";
          const fromName = /from="@([^"]+)"/.exec(content)?.[1] ?? "unknown";
          sentReplyTo.push(id);
          const input = JSON.stringify({ to: `@${fromName}`, kind: "reply" as SendableKind, body: replyBody, replyTo: id });
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "tool_call_start", toolCallId: "reply-1", toolName: "bus_send" } as NormalizedEvent;
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "tool_call_end", toolCallId: "reply-1", input } as NormalizedEvent;
          yield { sequence, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
        })();
      },
    },
  };
}

let idCounter = 0;
function fixedIdSeq(): () => string {
  idCounter = 0;
  return () => `id-${idCounter++}`;
}

function collectingIo(): { io: AgentIO; systemLines: string[] } {
  const systemLines: string[] = [];
  return { io: { write: () => {}, onToolResult: () => {}, onSystem: (text) => systemLines.push(text) }, systemLines };
}

function readTool(name: string, onInvoke?: () => Promise<void> | void): InteractiveTool {
  return {
    definition: { name, description: "", inputSchema: { type: "object", properties: {} }, risk: "read" },
    invoke: async () => {
      await onInvoke?.();
      return { output: `${name} ok`, isError: false };
    },
  };
}

function peerMessages(history: NormalizedMessage[]): NormalizedMessage[] {
  return history.filter((m) => typeof m.content === "string" && m.content.includes("<peer-message"));
}

function makeDeps(over: Record<string, unknown>): AgentDeps {
  return {
    providerId: "scripted",
    modelId: "m",
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
    ...over,
  } as unknown as AgentDeps;
}

async function acksAddressedTo(root: string, instanceId: string): Promise<number> {
  const { events } = await readEvents(root, await cursorAtStart(root));
  return events.filter((e) => e.kind === "ack" && e.to.includes(instanceId)).length;
}

// ===========================================================================
// 1. Two real peers, one busInbox each: bus_send -> poll -> runAgentTurn ->
//    single delivery, tool provenance, ack after (never before), idempotent
//    re-drain.
// ===========================================================================
describe("delivery: A sends a question via bus_send, B drains it exactly once and acks after", () => {
  test("one <peer-message kind=\"question\"> lands in B's history with provenance tool; ack follows, not precedes; a second drain is empty", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const a = await makePeer(root, PEER_A_ID, "alpha");
    const b = await makePeer(root, PEER_B_ID, "beta");

    const aTools = buildBusTools(() => a.client);
    const busSend = aTools.find((t) => t.definition.name === "bus_send");
    if (busSend === undefined) throw new Error("bus_send not built");
    const sendResult = await busSend.invoke({ to: "@beta", kind: "question", body: "are you there?" });
    expect(sendResult.isError).toBe(false);
    const { id: sentId } = JSON.parse(sendResult.output) as { id: string };

    // Nothing acked yet.
    expect(await acksAddressedTo(root, a.instanceId)).toBe(0);

    const delivered = await b.poll();
    expect(delivered.length).toBe(1);
    expect(b.busInbox.size).toBe(1);

    const { provider, requests } = scriptedProvider([[{ kind: "text_delta", text: "got it" }, { kind: "model_end" }]]);
    const { io } = collectingIo();
    const history: NormalizedMessage[] = [];
    const result = await runAgentTurn(
      io,
      makeDeps({ provider, tools: [], busInbox: b.busInbox, busAck: (events: readonly RenderedBusEvent[]) => b.client.ack(events) }),
      history,
      "",
      { origin: "bus-message" },
    );
    expect(result).toEqual({});

    const notices = peerMessages(history);
    expect(notices.length).toBe(1);
    expect(history[0]?.role).toBe("user");
    expect(history[0]?.provenance).toBe("tool");
    expect(history[0]?.content).toContain('kind="question"');
    expect(history[0]?.content).toContain("are you there?");
    expect(requests.length).toBe(1);

    await sleep(50); // ack() is fire-and-forget; give its append a tick to land
    expect(await acksAddressedTo(root, a.instanceId)).toBe(1);
    const { events } = await readEvents(root, await cursorAtStart(root));
    const ack = events.find((e) => e.kind === "ack");
    expect(ack?.refs?.replyTo).toBe(sentId);

    // A second drain returns nothing and costs no model call.
    const second = await runAgentTurn(
      io,
      makeDeps({ provider, tools: [], busInbox: b.busInbox, busAck: () => {} }),
      [],
      "",
      { origin: "bus-message" },
    );
    expect(second).toEqual({});
    expect(requests.length).toBe(1); // unchanged: the empty drain never called the provider
  });
});

// ===========================================================================
// 2. Reply loop at the auto-wake cap (AC6).
// ===========================================================================
describe("delivery: two always-answer agents stop waking at the auto-wake cap (AC6)", () => {
  test("each side's own consecutiveAutoWakes reaches resolveMaxAutoWake() and the exchange halts via the capped path — driven through createBusWakeController (review r1 F11), not a reimplemented decision loop", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const a = await makePeer(root, PEER_A_ID, "alpha");
    const b = await makePeer(root, PEER_B_ID, "beta");
    const cap = resolveMaxAutoWake({ KERYX_SHELL_MAX_AUTO_WAKE: "2" });
    expect(cap).toBe(2);

    const aProvider = autoReplyProvider("roger-from-alpha");
    const bProvider = autoReplyProvider("roger-from-beta");
    const aHistory: NormalizedMessage[] = [];
    const bHistory: NormalizedMessage[] = [];
    const { io } = collectingIo();

    const aDeps = makeDeps({
      provider: aProvider.provider,
      tools: buildBusTools(() => a.client),
      busInbox: a.busInbox,
      busAck: (events: readonly RenderedBusEvent[]) => a.client.ack(events),
    });
    const bDeps = makeDeps({
      provider: bProvider.provider,
      tools: buildBusTools(() => b.client),
      busInbox: b.busInbox,
      busAck: (events: readonly RenderedBusEvent[]) => b.client.ack(events),
    });

    // A kicks off the exchange with a manual, non-wake question.
    await a.client.send("@beta", "question", "start");

    let wakesA = 0;
    let wakesB = 0;
    let cappedSide: "A" | "B" | undefined;
    let pendingRunSide: "A" | "B" | undefined;

    // review r1 F11: the real stateful wake wiring (`createBusWakeController`,
    // `../tui/bus-wake.ts`) drives this loop — not a second, hand-rolled copy
    // of `decideBusWake`'s call shape. `runWake`/`printCapped` only RECORD
    // what the controller decided; this loop performs the actual (async)
    // work, since the controller's own contract is fire-and-forget, same as
    // the real `runLine("", "bus-message")` call site.
    const controllerFor = (side: "A" | "B") =>
      createBusWakeController({
        isIdle: () => true,
        inbox: side === "A" ? a.busInbox : b.busInbox,
        getWakes: () => (side === "A" ? wakesA : wakesB),
        incWakes: () => {
          if (side === "A") wakesA += 1;
          else wakesB += 1;
        },
        cap: () => cap,
        runWake: () => {
          pendingRunSide = side;
        },
        printCapped: () => {
          cappedSide = side;
        },
        hasBusDeps: () => true,
      });
    const controllers = { A: controllerFor("A"), B: controllerFor("B") };

    let active: "A" | "B" = "B"; // B is the one holding the opening question
    for (let round = 0; round < 20; round += 1) {
      const peer = active === "A" ? a : b;
      const delivered = await peer.poll();
      pendingRunSide = undefined;
      controllers[active].onPoll(delivered.length > 0);
      if (cappedSide !== undefined) break;
      if (pendingRunSide === undefined) break; // not idle / not eligible — nothing to do
      if (pendingRunSide === "A") {
        await runAgentTurn(io, aDeps, aHistory, "", { origin: "bus-message" });
      } else {
        await runAgentTurn(io, bDeps, bHistory, "", { origin: "bus-message" });
      }
      active = active === "A" ? "B" : "A";
    }

    expect(cappedSide).toBeDefined();
    expect(wakesA).toBe(cap);
    expect(wakesB).toBe(cap);
    // The capped side's message stayed queued (never drained) rather than lost.
    const cappedPeer = cappedSide === "A" ? a : b;
    expect(cappedPeer.busInbox.size).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. Never inside a tool_calls batch: a bus event that arrives WHILE the
//    first of two tools executes must land only after BOTH tool results.
// ===========================================================================
describe("delivery: a bus event arriving mid-tool-batch never splices between tool_calls and its results", () => {
  test("the peer-message notification lands right after both tool results, never between them or before", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const a = await makePeer(root, PEER_A_ID, "alpha");
    const b = await makePeer(root, PEER_B_ID, "beta");

    // "alpha" is the first tool in the batch: while IT executes, A sends B a
    // real event and B polls for it — simulating the real poll timer firing
    // mid-tool-execution.
    const alphaTool = readTool("alpha", async () => {
      await a.client.send("@beta", "notice", "meanwhile");
      await b.poll();
    });
    const betaTool = readTool("beta");

    const { provider, requests } = scriptedProvider([
      [
        { kind: "tool_call_start", toolCallId: "c1", toolName: "alpha" },
        { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
        { kind: "tool_call_start", toolCallId: "c2", toolName: "beta" },
        { kind: "tool_call_end", toolCallId: "c2", input: "{}" },
        { kind: "model_end" },
      ],
      [{ kind: "text_delta", text: "all done" }, { kind: "model_end" }],
    ]);
    const { io } = collectingIo();
    const history: NormalizedMessage[] = [];

    await runAgentTurn(
      io,
      makeDeps({
        provider,
        tools: [alphaTool, betaTool],
        busInbox: b.busInbox,
        busAck: (events: readonly RenderedBusEvent[]) => b.client.ack(events),
      }),
      history,
      "status",
    );

    expect(b.busInbox.size).toBe(0); // drained by the round-boundary site
    const assistantIdx = history.findIndex((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) === 2);
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(history[assistantIdx + 1]?.role).toBe("tool");
    expect(history[assistantIdx + 2]?.role).toBe("tool");
    // The notification is the very next entry after both tool results — never
    // spliced in between them, and never before the assistant's own message.
    const notifIdx = history.findIndex((m) => typeof m.content === "string" && m.content.includes("<peer-message"));
    expect(notifIdx).toBe(assistantIdx + 3);
    expect(history[notifIdx]?.role).toBe("user");
    expect(history[notifIdx]?.provenance).toBe("tool");
    expect(requests.length).toBe(2);
  });
});

// ===========================================================================
// 4. Readline delivery: a message pending before an operator turn is
//    delivered within that SAME turn (post-answer or round-boundary site).
// ===========================================================================
describe("delivery: a message already pending before an operator line is delivered within that same turn (AC7)", () => {
  test("post-answer site: a text-only first round still gets a second round that carries the pending message", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const a = await makePeer(root, PEER_A_ID, "alpha");
    const b = await makePeer(root, PEER_B_ID, "beta");

    await a.client.send("@beta", "notice", "fyi: deploy done");
    const delivered = await b.poll(); // the message is already pending BEFORE the operator's line
    expect(delivered.length).toBe(1);

    const { provider, requests } = scriptedProvider([
      [{ kind: "text_delta", text: "sure" }, { kind: "model_end" }],
      [{ kind: "text_delta", text: "noted the fyi" }, { kind: "model_end" }],
    ]);
    const { io } = collectingIo();
    const history: NormalizedMessage[] = [];

    const result = await runAgentTurn(
      io,
      makeDeps({ provider, tools: [], busInbox: b.busInbox, busAck: (events: readonly RenderedBusEvent[]) => b.client.ack(events) }),
      history,
      "how did it go?",
    ); // origin defaults to "operator"

    expect(result).toEqual({});
    expect(history[0]).toMatchObject({ role: "user", provenance: "project", content: "how did it go?" });
    expect(peerMessages(history).length).toBe(1);
    expect(requests.length).toBe(2); // the turn continued to deliver it, rather than ending
    expect(b.busInbox.size).toBe(0);
  });

  test("round-boundary site: a tool-calling first round delivers the pending message right after the tool result", async () => {
    const cwd = await repo();
    const { root } = await resolveBusRoot(cwd);
    const a = await makePeer(root, PEER_A_ID, "alpha");
    const b = await makePeer(root, PEER_B_ID, "beta");

    await a.client.send("@beta", "notice", "fyi: build green");
    await b.poll();

    const { provider, requests } = scriptedProvider([
      [
        { kind: "tool_call_start", toolCallId: "c1", toolName: "check" },
        { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
        { kind: "model_end" },
      ],
      [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
    ]);
    const { io } = collectingIo();
    const history: NormalizedMessage[] = [];

    await runAgentTurn(
      io,
      makeDeps({
        provider,
        tools: [readTool("check")],
        busInbox: b.busInbox,
        busAck: (events: readonly RenderedBusEvent[]) => b.client.ack(events),
      }),
      history,
      "run the check",
    );

    const toolIdx = history.findIndex((m) => m.role === "tool");
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    const notifIdx = history.findIndex((m) => typeof m.content === "string" && m.content.includes("<peer-message"));
    expect(notifIdx).toBe(toolIdx + 1); // right after the tool result, at the round boundary
    expect(requests.length).toBe(2);
    expect(b.busInbox.size).toBe(0);
  });
});
