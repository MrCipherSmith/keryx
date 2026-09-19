// Flow 274 T6: the interactive agent's own bus tools (specification §7.1;
// decisions D-05, D-12, D-13). See AC8-AC10.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_RATE_LIMIT_PER_MINUTE, buildBusTools } from "./agent-tools";
import type { BusClient, BusPeer } from "./client";
import { BusRefusal } from "./errors";
import { leasePath, leasesDir } from "./paths";
import type { PauseLease, PresenceRecord } from "./schema";
import type { SendResult } from "./send";

const ROOTS: string[] = [];
afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});
async function busRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-agent-tools-"));
  ROOTS.push(dir);
  return dir;
}

const SELF_ID = "11111111-1111-4111-8111-111111111111";
const PEER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

function presence(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId: PEER_ID,
    name: "peer",
    pid: 1,
    host: "host",
    sessionId: "44444444-4444-4444-8444-444444444444",
    checkout: "/repo",
    branch: "main",
    surface: "tui",
    status: "idle",
    activity: "",
    startedAt: "2026-09-19T10:00:00.000Z",
    heartbeatAt: "2026-09-19T10:00:00.000Z",
    keryxVersion: "0.2.121",
    ...overrides,
  };
}

function pauseLease(overrides: Partial<PauseLease> = {}): PauseLease {
  return {
    schemaVersion: 1,
    leaseId: "55555555-5555-4555-8555-555555555555",
    holder: { instanceId: PEER_ID, name: "peer", origin: "agent" },
    targets: ["*"],
    scope: "advisory",
    reason: "testing",
    createdAt: "2026-09-19T10:00:00.000Z",
    expiresAt: "2026-09-19T13:00:00.000Z", // within the 4h max TTL (schema.ts's MAX_LEASE_TTL_MS)
    requestEventSeq: 1,
    ...overrides,
  };
}

const SEND_RESULT: SendResult = { seq: 1, id: "id-1", resolvedTo: [PEER_ID], event: {} as SendResult["event"] };

function fakeClient(overrides: Partial<BusClient> = {}): BusClient {
  return {
    instanceId: SELF_ID,
    root: "/does/not/matter",
    nameWasTaken: false,
    name: "self",
    peers: () => [],
    setSession: async () => {},
    rename: async () => {},
    send: async () => SEND_RESULT,
    resolveRef: () => undefined,
    reply: async () => SEND_RESULT,
    pollNow: async () => [],
    ack: () => {},
    leave: () => {},
    ...overrides,
  };
}

describe("bus_list", () => {
  test("bus-disabled when there is no client", async () => {
    const [busList] = buildBusTools(() => undefined);
    const result = await busList!.invoke({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("bus_list: bus-disabled:");
  });

  test("shape: self, peers (name/state/status/activity/checkout/branch), leases applying to or held by the instance", async () => {
    const root = await busRoot();
    await mkdir(leasesDir(root), { recursive: true });
    // Applies to me (targets @all, not held by me).
    await writeFile(leasePath(root, pauseLease().leaseId), JSON.stringify(pauseLease()), "utf8");
    // Held by me.
    const heldByMe = pauseLease({
      leaseId: "66666666-6666-4666-8666-666666666666",
      holder: { instanceId: SELF_ID, name: "self", origin: "agent" },
      targets: [PEER_ID],
    });
    await writeFile(leasePath(root, heldByMe.leaseId), JSON.stringify(heldByMe), "utf8");
    // Neither applies to nor is held by me — must be excluded.
    const unrelated = pauseLease({
      leaseId: "77777777-7777-4777-8777-777777777777",
      holder: { instanceId: PEER_ID, name: "peer", origin: "agent" },
      targets: [OTHER_ID],
    });
    await writeFile(leasePath(root, unrelated.leaseId), JSON.stringify(unrelated), "utf8");

    const peer: BusPeer = { record: presence(), state: "live", ageMs: 0 };
    const client = fakeClient({ root, peers: () => [peer] });
    const [busList] = buildBusTools(() => client, { now: () => Date.parse("2026-09-19T11:00:00.000Z") });
    const result = await busList!.invoke({});
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.output) as {
      self: { name: string; instanceId: string };
      peers: { name: string; state: string; status: string; activity: string; checkout: string; branch: string | null }[];
      leases: { leaseId: string; heldByMe: boolean }[];
    };
    expect(payload.self).toEqual({ name: "self", instanceId: SELF_ID });
    expect(payload.peers).toEqual([
      { name: "peer", state: "live", status: "idle", activity: "", checkout: "/repo", branch: "main" },
    ]);
    const leaseIds = payload.leases.map((l) => l.leaseId).sort();
    expect(leaseIds).toEqual([pauseLease().leaseId, heldByMe.leaseId].sort());
    expect(payload.leases.find((l) => l.leaseId === heldByMe.leaseId)?.heldByMe).toBe(true);
    expect(payload.leases.find((l) => l.leaseId === pauseLease().leaseId)?.heldByMe).toBe(false);
  });
});

describe("bus_send", () => {
  test("success: notice returns { seq, id, resolvedTo }", async () => {
    let sentWith: unknown;
    const client = fakeClient({
      send: async (to, kind, body) => {
        sentWith = { to, kind, body };
        return SEND_RESULT;
      },
    });
    const [, busSend] = buildBusTools(() => client);
    const result = await busSend!.invoke({ to: "@peer", kind: "notice", body: "hello" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual({ seq: 1, id: "id-1", resolvedTo: [PEER_ID] });
    expect(sentWith).toEqual({ to: "@peer", kind: "notice", body: "hello" });
  });

  test("reply by ref: calls client.reply(replyTo, body), not client.send", async () => {
    let replyArgs: unknown;
    let sendCalled = false;
    const client = fakeClient({
      reply: async (ref, body) => {
        replyArgs = { ref, body };
        return SEND_RESULT;
      },
      send: async () => {
        sendCalled = true;
        return SEND_RESULT;
      },
    });
    const [, busSend] = buildBusTools(() => client);
    const result = await busSend!.invoke({ to: "@peer", kind: "reply", body: "answer", replyTo: "abc12345" });
    expect(result.isError).toBe(false);
    expect(replyArgs).toEqual({ ref: "abc12345", body: "answer" });
    expect(sendCalled).toBe(false);
  });

  test("reply-without-replyTo: refused locally, client is never called", async () => {
    let called = false;
    const client = fakeClient({
      reply: async () => {
        called = true;
        return SEND_RESULT;
      },
    });
    const [, busSend] = buildBusTools(() => client);
    const result = await busSend!.invoke({ to: "@peer", kind: "reply", body: "answer" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("bus_send: reply-without-replyTo:");
    expect(called).toBe(false);
  });

  test("bus-disabled when there is no client", async () => {
    const [, busSend] = buildBusTools(() => undefined);
    const result = await busSend!.invoke({ to: "@peer", kind: "notice", body: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("bus_send: bus-disabled:");
  });

  for (const code of ["unknown-recipient", "recipient-not-live", "body-too-large"] as const) {
    test(`maps BusRefusal(${code}) from client.send to a named refusal`, async () => {
      const client = fakeClient({
        send: async () => {
          throw new BusRefusal(code, "from the client");
        },
      });
      const [, busSend] = buildBusTools(() => client);
      const result = await busSend!.invoke({ to: "@peer", kind: "notice", body: "hi" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain(`bus_send: ${code}:`);
      // BusRefusal's own message is already "<code>: <detail>"; the tool must
      // not format it a second time and duplicate the code.
      expect(result.output).toBe(`bus_send: ${code}: from the client`);
    });
  }

  test("maps BusRefusal(unknown-message) from client.reply to a named refusal", async () => {
    const client = fakeClient({
      reply: async () => {
        throw new BusRefusal("unknown-message", "no rendered message matches that ref");
      },
    });
    const [, busSend] = buildBusTools(() => client);
    const result = await busSend!.invoke({ to: "@peer", kind: "reply", body: "hi", replyTo: "deadbeef" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("bus_send: unknown-message:");
  });

  test("rate-limited: mapped when the client itself refuses", async () => {
    const client = fakeClient({
      send: async () => {
        throw new BusRefusal("rate-limited", "clone-wide limit");
      },
    });
    const [, busSend] = buildBusTools(() => client);
    const result = await busSend!.invoke({ to: "@peer", kind: "notice", body: "hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("bus_send: rate-limited:");
  });

  test("D-12 agent-origin rate limit: the 11th send in a minute is refused locally, without reaching the client", async () => {
    let sendCount = 0;
    const client = fakeClient({
      send: async () => {
        sendCount += 1;
        return SEND_RESULT;
      },
    });
    let clock = 0;
    const [, busSend] = buildBusTools(() => client, { now: () => clock });
    for (let i = 0; i < AGENT_RATE_LIMIT_PER_MINUTE; i += 1) {
      const result = await busSend!.invoke({ to: "@peer", kind: "notice", body: `m${i}` });
      expect(result.isError).toBe(false);
      clock += 1000; // still well within the 60s window
    }
    expect(sendCount).toBe(AGENT_RATE_LIMIT_PER_MINUTE);
    const blocked = await busSend!.invoke({ to: "@peer", kind: "notice", body: "one too many" });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("bus_send: rate-limited:");
    expect(sendCount).toBe(AGENT_RATE_LIMIT_PER_MINUTE); // the client was never called for the refused send

    // Once the window rolls past, sending is allowed again.
    clock += 61_000;
    const afterWindow = await busSend!.invoke({ to: "@peer", kind: "notice", body: "after the window" });
    expect(afterWindow.isError).toBe(false);
    expect(sendCount).toBe(AGENT_RATE_LIMIT_PER_MINUTE + 1);
  });

  test("an invalid kind is rejected before the client is ever consulted", async () => {
    let called = false;
    const client = fakeClient({
      send: async () => {
        called = true;
        return SEND_RESULT;
      },
    });
    const [, busSend] = buildBusTools(() => client);
    const result = await busSend!.invoke({ to: "@peer", kind: "bogus", body: "hi" });
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });
});
