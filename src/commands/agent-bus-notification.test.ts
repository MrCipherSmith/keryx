// RED tests (flow 274 T5, AC2) for BUS MESSAGE DELIVERY into `runAgentTurn` —
// the three busInbox drain sites (turn start, round boundary, post-answer)
// mirroring how `agent-task-notification.test.ts` already covers the
// equivalent `jobRegistry` drains. Drives the REAL `runAgentTurn` with a
// scripted provider and a fully injected fake `BusInbox` — no real bus root,
// no timers, no network.
import { describe, expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { BusInbox, BusInboxEvent } from "../bus/inbox";
import type {
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  ProviderDescription,
} from "../harness/provider/types";

function busEvent(overrides: Partial<BusInboxEvent> = {}): BusInboxEvent {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    seq: 1,
    shortId: "7c9e6679",
    fromName: "release",
    fromInstanceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    kind: "notice",
    preview: "please check the deploy",
    body: "please check the deploy",
    toStar: false,
    ...overrides,
  };
}

// --- fully injected fake BusInbox, mirroring `agent-task-notification.test.ts`'s fakeRegistry ---
function fakeBusInbox(pending: BusInboxEvent[] = []): { inbox: BusInbox; drains: number } {
  let queue = [...pending];
  const state = {
    inbox: {} as BusInbox,
    drains: 0,
  };
  const inbox: BusInbox = {
    push: (event) => queue.push(event),
    drainUndelivered: () => {
      state.drains += 1;
      const out = queue;
      queue = [];
      return out;
    },
    hasWakeEligible: () => queue.length > 0,
    get size() {
      return queue.length;
    },
    get droppedCount() {
      return 0;
    },
  };
  state.inbox = inbox;
  return state;
}

// --- test harness (mirrors `agent.test.ts`/`agent-task-notification.test.ts`) ---
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): {
  provider: AgentDeps["provider"];
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let call = 0;
  const description: ProviderDescription = {
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

let idCounter = 0;
function fixedIdSeq(): () => string {
  idCounter = 0;
  return () => `id-${idCounter++}`;
}

function collectingIo(): { io: AgentIO } {
  return { io: { write: () => {}, onToolResult: () => {}, onSystem: () => {} } };
}

function readTool(name: string): InteractiveTool {
  return {
    definition: { name, description: "", inputSchema: { type: "object", properties: {} }, risk: "read" },
    invoke: async () => ({ output: `${name} ok`, isError: false }),
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

// =======================================================================
// AC2: turn start (`origin: "bus-message"`)
// =======================================================================
describe("AC2: turn start drains the busInbox when origin is bus-message", () => {
  test("a non-empty drain pushes ONE peer-message notification, then acks, before the model is called", async () => {
    const { provider, requests } = scriptedProvider([[{ kind: "text_delta", text: "noted" }, { kind: "model_end" }]]);
    const fake = fakeBusInbox([busEvent()]);
    const { io } = collectingIo();
    const history: NormalizedMessage[] = [];
    const ackCalls: BusInboxEvent[][] = [];
    const historyLenAtAck: number[] = [];

    const result = await runAgentTurn(
      io,
      makeDeps({
        provider,
        tools: [],
        busInbox: fake.inbox,
        busAck: (events: BusInboxEvent[]) => {
          historyLenAtAck.push(history.length);
          ackCalls.push(events);
        },
      }),
      history,
      "",
      { origin: "bus-message" },
    );

    expect(result).toEqual({});
    expect(peerMessages(history).length).toBe(1);
    expect(history[0]?.role).toBe("user");
    expect(history[0]?.provenance).toBe("tool");
    expect(history[0]?.content).toContain("please check the deploy");

    // The one model round carries the notification (AC2: it is the turn's input).
    expect(requests.length).toBe(1);
    const carried = (requests[0]?.messages ?? []).some(
      (m) => typeof m.content === "string" && m.content.includes("please check the deploy"),
    );
    expect(carried).toBe(true);

    // busAck fires with the drained events, and only AFTER the push landed in history.
    expect(ackCalls.length).toBe(1);
    expect(ackCalls[0]?.[0]?.id).toBe(busEvent().id);
    expect(historyLenAtAck[0]).toBe(1);
  });

  test("an empty drain ends the turn with NO model call", async () => {
    const { provider, requests } = scriptedProvider([]);
    const fake = fakeBusInbox([]);
    const { io } = collectingIo();
    const history: NormalizedMessage[] = [];

    const result = await runAgentTurn(
      io,
      makeDeps({ provider, tools: [], busInbox: fake.inbox, busAck: () => {} }),
      history,
      "",
      { origin: "bus-message" },
    );

    expect(result).toEqual({});
    expect(requests.length).toBe(0);
    expect(history.length).toBe(0);
    expect(fake.drains).toBe(1); // the drain is what decided the turn was empty
  });
});

// =======================================================================
// AC2: round boundary
// =======================================================================
describe("AC2: the round-boundary drain", () => {
  test("lands AFTER both tool results of a parallel batch and before the next round", async () => {
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
    const fake = fakeBusInbox([busEvent()]);
    const { io } = collectingIo();
    const history: NormalizedMessage[] = [];
    const ackCalls: BusInboxEvent[][] = [];

    await runAgentTurn(
      io,
      makeDeps({
        provider,
        tools: [readTool("alpha"), readTool("beta")],
        busInbox: fake.inbox,
        busAck: (events: BusInboxEvent[]) => ackCalls.push(events),
      }),
      history,
      "status",
    );

    const toolIdx = history.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    expect(toolIdx.length).toBe(2);
    const notifIdx = history.findIndex((m) => typeof m.content === "string" && m.content.includes("<peer-message"));
    expect(notifIdx).toBeGreaterThanOrEqual(0);

    // Never spliced between two `tool` results answering one batch.
    for (let i = toolIdx[0] ?? 0; i <= (toolIdx[toolIdx.length - 1] ?? 0); i++) {
      expect(history[i]?.role).toBe("tool");
    }
    expect(notifIdx).toBeGreaterThan(toolIdx[toolIdx.length - 1] ?? 0);
    expect(history[notifIdx]?.role).toBe("user");
    expect(history[notifIdx]?.provenance).toBe("tool");

    expect(requests.length).toBe(2);
    expect(ackCalls.length).toBe(1);
  });
});

// =======================================================================
// AC2: the post-answer (text-only finish) drain
// =======================================================================
describe("AC2: the post-answer drain continues the turn instead of ending it", () => {
  test("a peer message pending at a text-only finish is delivered, and the turn gets another round", async () => {
    const { provider, requests } = scriptedProvider([
      [{ kind: "text_delta", text: "first note" }, { kind: "model_end" }],
      [{ kind: "text_delta", text: "second note" }, { kind: "model_end" }],
    ]);
    const fake = fakeBusInbox([busEvent()]);
    const { io } = collectingIo();
    const history: NormalizedMessage[] = [];
    const ackCalls: BusInboxEvent[][] = [];

    await runAgentTurn(
      io,
      makeDeps({
        provider,
        tools: [],
        busInbox: fake.inbox,
        busAck: (events: BusInboxEvent[]) => ackCalls.push(events),
      }),
      history,
      "status",
    );

    expect(requests.length).toBe(2); // the turn continued instead of ending
    expect(peerMessages(history).length).toBe(1);
    expect(ackCalls.length).toBe(1);
  });
});
