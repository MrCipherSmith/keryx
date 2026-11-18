import { describe, expect, test } from "bun:test";
import { AcpClient, type Transport } from "./client";

/** A transport whose sends complete only when the test says so, like an async host command. */
function slowTransport() {
  const started: string[] = [];
  const finish: Array<() => void> = [];
  const transport: Transport = {
    send(line: string) {
      started.push((JSON.parse(line) as { method?: string }).method ?? "response");
      return new Promise<void>((resolve) => finish.push(resolve));
    },
  };
  return { transport, started, finish };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("AcpClient writes", () => {
  test("a frame reaches the transport only after the previous one was sent", async () => {
    const t = slowTransport();
    const c = new AcpClient(t.transport);
    void c.request("session/prompt", {}).catch(() => {});
    c.notify("session/cancel", {});
    void c.request("session/list", {}).catch(() => {});
    await tick();
    expect(t.started).toEqual(["session/prompt"]);
    t.finish[0]!();
    await tick();
    expect(t.started).toEqual(["session/prompt", "session/cancel"]);
    t.finish[1]!();
    await tick();
    expect(t.started).toEqual(["session/prompt", "session/cancel", "session/list"]);
    c.close();
  });

  test("a failed send rejects its request and does not stall the next frame", async () => {
    const sent: string[] = [];
    let first = true;
    const c = new AcpClient({
      send(line) {
        sent.push((JSON.parse(line) as { method: string }).method);
        if (first) {
          first = false;
          return Promise.reject(new Error("pipe closed"));
        }
        return Promise.resolve();
      },
    });
    const failed = c.request("a").then(
      () => "resolved",
      (e: Error) => e.message,
    );
    c.notify("b");
    expect(await failed).toBe("pipe closed");
    await tick();
    expect(sent).toEqual(["a", "b"]);
    c.close();
  });
});

describe("AcpClient replies to keryx's requests", () => {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {} });

  test("a reply that hits a full queue is retried until it is sent", async () => {
    const sent: string[] = [];
    let refusals = 2;
    const c = new AcpClient(
      {
        send(line) {
          if (refusals > 0) {
            refusals -= 1;
            return Promise.reject(new Error("keryx is not reading its input; the message was not sent"));
          }
          sent.push(line);
          return Promise.resolve();
        },
      },
      [0, 0, 0],
    );
    c.onRequest = async () => ({ outcome: { outcome: "cancelled" } });
    let failed = "";
    c.onReplyFailed = (m) => (failed = m);
    c.handleLine(request);
    for (let i = 0; i < 10; i++) await tick();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } });
    expect(failed).toBe("");
    c.close();
  });

  test("a reply that never gets through is reported, not swallowed", async () => {
    const c = new AcpClient({ send: () => Promise.reject(new Error("full")) }, [0, 0]);
    c.onRequest = async () => ({});
    const failed: string[] = [];
    c.onReplyFailed = (m, e) => failed.push(`${m}: ${e}`);
    c.handleLine(request);
    for (let i = 0; i < 10; i++) await tick();
    expect(failed).toEqual(["session/request_permission: full"]);
    c.close();
  });
});
