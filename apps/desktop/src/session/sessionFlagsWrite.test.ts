import { expect, test } from "bun:test";
import { AcpClient, RpcError } from "../acp/client";
import type { SessionFlags } from "../acp/types";
import { refusalReason, writeSessionFlags } from "./sessionFlagsWrite";

/** A client whose transport records each request; the test answers it as keryx would. */
function fakeKeryx() {
  const sent: Array<{ id: number; method: string; params: unknown }> = [];
  const client = new AcpClient({ send: async line => { sent.push(JSON.parse(line)); } });
  const answer = (frame: Record<string, unknown>) => client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent.at(-1)!.id, ...frame }));
  return { client, sent, answer };
}
const settle = () => new Promise<void>(resolve => queueMicrotask(resolve));
/** The error a write rejected with; fails when it resolved. */
const failure = (write: Promise<unknown>) => write.then(() => { throw new Error("The write resolved"); }, (error: unknown) => error);

test("a stored write hands keryx's flags to onFlags and returns them", async () => {
  const keryx = fakeKeryx();
  const seen: Array<[string, SessionFlags]> = [];
  const write = writeSessionFlags({ current: { client: keryx.client } }, "/project", "s1", { flow: "517-work" }, (id, flags) => seen.push([id, flags]));
  await settle();
  expect(keryx.sent.map(({ method, params }) => [method, params])).toEqual([["_keryx/session_flags", { sessionId: "s1", cwd: "/project", flow: "517-work" }]]);
  keryx.answer({ result: { flow: "517-work" } });
  expect(await write).toEqual({ flow: "517-work" });
  expect(seen).toEqual([["s1", { flow: "517-work" }]]);
});

test("FE-R4-002: flags stored while the connection was replaced still reach the session list", async () => {
  const keryx = fakeKeryx();
  const live: { current: { client: AcpClient | null } } = { current: { client: keryx.client } };
  const seen: string[] = [];
  const write = writeSessionFlags(live, "/project", "s1", { flow: "517-work" }, id => seen.push(id));
  await settle();
  live.current = { client: fakeKeryx().client };
  keryx.answer({ result: { flow: "517-work" } });
  await write;
  expect(seen).toEqual(["s1"]);
});

test("TP-R4-008: keryx's refusal reason, without the method prefix, is the error; nothing reaches onFlags", async () => {
  const keryx = fakeKeryx();
  const seen: string[] = [];
  const write = writeSessionFlags({ current: { client: keryx.client } }, "/project", "s1", { flow: "517-work" }, id => seen.push(id));
  await settle();
  // As src/acp/server.ts refuseStore answers a held flags lock.
  keryx.answer({ error: { code: -32600, message: "Invalid request", data: {
    reason: "_keryx/session_flags: the flags of session s1 are locked by another keryx process; retry", method: "_keryx/session_flags", sessionId: "s1" } } });
  expect(((await failure(write)) as Error).message).toBe("the flags of session s1 are locked by another keryx process; retry");
  expect(seen).toEqual([]);
});

test("a refusal without a text reason, and no connection, keep their own errors", async () => {
  const keryx = fakeKeryx();
  const write = writeSessionFlags({ current: { client: keryx.client } }, "/project", "s1", { pinned: true }, () => {});
  await settle();
  keryx.answer({ error: { code: -32601, message: "Method not found: _keryx/session_flags" } });
  expect((await failure(write)) instanceof RpcError).toBe(true);
  expect(((await failure(writeSessionFlags({ current: { client: null } }, "/project", "s1", { pinned: true }, () => {}))) as Error).message).toBe("keryx is not connected.");
});

test("refusalReason reads a text error.data.reason of an RpcError only", () => {
  expect(refusalReason(new RpcError(-32600, "Invalid request", { reason: "session-leased" }))).toBe("session-leased");
  expect(refusalReason(new RpcError(-32600, "Invalid request", { reason: 7 }))).toBeUndefined();
  expect(refusalReason(new RpcError(-32600, "Invalid request"))).toBeUndefined();
  expect(refusalReason(new Error("session-leased"))).toBeUndefined();
});
