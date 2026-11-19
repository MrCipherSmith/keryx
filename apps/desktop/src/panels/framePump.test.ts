import { describe, expect, test } from "bun:test";
import type { BrowserFrame } from "../platform/panels";
import { framePump } from "./framePump";

const notice = (seq: number, tab = 1): BrowserFrame => ({ tab, seq, width: 800, height: 600 });
const bytes = (seq: number) => new Uint8Array([seq]).buffer;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("framePump", () => {
  test("a failed fetch costs that frame only: later frames are still drawn", async () => {
    const drawn: number[] = [];
    let calls = 0;
    const pump = framePump({
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new Error("ipc failed");
        return bytes(calls);
      },
      draw: async (_jpeg, f) => void drawn.push(f.seq),
      shown: () => 1,
    });
    pump.push(notice(1));
    await settle();
    pump.push(notice(2));
    await settle();
    pump.push(notice(3));
    await settle();
    expect(drawn).toEqual([2, 3]);
  });

  test("a fetch that never settles is given up, and the next frame is drawn", async () => {
    const drawn: number[] = [];
    let calls = 0;
    const pump = framePump({
      fetch: (tab) => {
        calls += 1;
        return calls === 1 ? new Promise<ArrayBuffer>(() => {}) : Promise.resolve(bytes(tab));
      },
      draw: async (_jpeg, f) => void drawn.push(f.seq),
      shown: () => 1,
      timeoutMs: 20,
    });
    pump.push(notice(1));
    pump.push(notice(2));
    await new Promise((r) => setTimeout(r, 60));
    expect(drawn).toEqual([2]);
  });

  test("while one frame is drawn only the newest of the frames that arrive is drawn next", async () => {
    const drawn: number[] = [];
    let release: () => void = () => {};
    const pump = framePump({
      fetch: async () => bytes(0),
      draw: (_jpeg, f) => {
        drawn.push(f.seq);
        return f.seq === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve();
      },
      shown: () => 1,
    });
    pump.push(notice(1));
    await settle();
    pump.push(notice(2));
    pump.push(notice(3));
    release();
    await settle();
    await settle();
    expect(drawn).toEqual([1, 3]);
  });

  test("frames of another tab, empty frames and frames after stop are not drawn", async () => {
    const drawn: number[] = [];
    let empty = false;
    const pump = framePump({
      fetch: async () => (empty ? new ArrayBuffer(0) : bytes(1)),
      draw: async (_jpeg, f) => void drawn.push(f.seq),
      shown: () => 1,
    });
    pump.push(notice(1, 2));
    await settle();
    empty = true;
    pump.push(notice(2));
    await settle();
    pump.stop();
    empty = false;
    pump.push(notice(3));
    await settle();
    expect(drawn).toEqual([]);
  });
});
