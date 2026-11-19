import { expect, test } from "bun:test";
import { createDevBridge } from "./devBridge";

test("bridge connection loss before or after sending is temporary, and a retry can reconnect", async () => {
  let socket: Socket;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    id = 0;
    constructor() { socket = this; }
    send(frame: string) { this.id = JSON.parse(frame).id; }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  try {
    const bridge = createDevBridge();
    const first = bridge.invoke("review_board").catch((e: Error) => e.message);
    socket!.onclose!();
    expect(await first).toContain("unavailable:");
    const second = bridge.invoke("review_board").catch((e: Error) => e.message);
    socket!.open();
    await Promise.resolve();
    socket!.onclose!();
    expect(await second).toContain("unavailable:");
    const third = bridge.invoke("review_board");
    socket!.open();
    await Promise.resolve();
    socket!.onmessage!({ data: JSON.stringify({id:socket!.id, ok:true, result:"ok"}) });
    expect(await third).toBe("ok");
  } finally {
    globalThis.WebSocket = original;
  }
});
