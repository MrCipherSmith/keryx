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
