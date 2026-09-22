// Every outgoing request settles exactly once — including the ones the client
// never answers (flow 285, T9). A pending promise here is a hung turn.

import { describe, expect, test } from "bun:test";
import { AcpClientRequests } from "./client-requests";
import { errorResponse, successResponse, type JsonRpcRequestMessage } from "./jsonrpc";

function harness(): { requests: AcpClientRequests; sent: JsonRpcRequestMessage[] } {
  const sent: JsonRpcRequestMessage[] = [];
  let n = 0;
  const requests = new AcpClientRequests({
    send: (message) => {
      sent.push(message);
    },
    idSeq: () => `${n++}`,
  });
  return { requests, sent };
}

describe("AcpClientRequests", () => {
  test("an answered request resolves with its result", async () => {
    const { requests, sent } = harness();
    const pending = requests.request("session/request_permission", { sessionId: "s1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("session/request_permission");
    expect(requests.pendingCount).toBe(1);

    requests.resolve(successResponse(sent[0]!.id, { outcome: { outcome: "cancelled" } }));
    expect(await pending).toEqual({ kind: "result", result: { outcome: { outcome: "cancelled" } } });
    expect(requests.pendingCount).toBe(0);
  });

  test("an error answer resolves as an error, not a throw", async () => {
    const { requests, sent } = harness();
    const pending = requests.request("session/request_permission", {});
    requests.resolve(errorResponse(sent[0]!.id, { code: -32601, message: "Method not found" }));
    const outcome = await pending;
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" ? outcome.error.code : undefined).toBe(-32601);
  });

  test("close settles everything still open, and nothing is left pending", async () => {
    const { requests } = harness();
    const first = requests.request("session/request_permission", {});
    const second = requests.request("session/request_permission", {});
    requests.close("stdin ended");
    expect(await first).toEqual({ kind: "closed", reason: "stdin ended" });
    expect(await second).toEqual({ kind: "closed", reason: "stdin ended" });
    expect(requests.pendingCount).toBe(0);
  });

  test("after close a new request answers immediately and writes nothing", async () => {
    const { requests, sent } = harness();
    requests.close("stdin ended");
    expect(await requests.request("session/request_permission", {})).toEqual({
      kind: "closed",
      reason: "stdin ended",
    });
    expect(sent).toHaveLength(0);
  });

  test("a response nobody asked for is reported, not swallowed into a pending slot", () => {
    const { requests } = harness();
    expect(requests.resolve(successResponse("not-ours", {}))).toBe(false);
    expect(requests.resolve(successResponse(null, {}))).toBe(false);
  });

  test("a duplicate answer to the same id is refused the second time", async () => {
    const { requests, sent } = harness();
    const pending = requests.request("session/request_permission", {});
    expect(requests.resolve(successResponse(sent[0]!.id, { first: true }))).toBe(true);
    expect(requests.resolve(successResponse(sent[0]!.id, { second: true }))).toBe(false);
    expect(await pending).toEqual({ kind: "result", result: { first: true } });
  });

  test("a write that throws settles the request instead of stranding it", async () => {
    const requests = new AcpClientRequests({
      send: () => {
        throw new Error("EPIPE");
      },
      idSeq: () => "x",
    });
    const outcome = await requests.request("session/request_permission", {});
    expect(outcome.kind).toBe("closed");
    expect(requests.pendingCount).toBe(0);
  });
});
