import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { attachRendererGuards } from "./renderer-debug";
import type { StdinLike } from "./stdin-guard";

class FakeStream extends EventEmitter implements StdinLike {
  isTTY = true;
  isRaw = true;
  destroyed = false;
  readableEnded = false;
  paused = false;
  isPaused(): boolean {
    return this.paused;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  /** What Bun does on a tty read that returns 0 bytes. */
  eof(): void {
    this.readableEnded = true;
    this.emit("end");
    this.destroyed = true;
    this.emit("close");
  }
}

function fakeRenderer(): { r: never; state: { stdin: unknown; renders: number; destroyed: boolean } } {
  const state = { stdin: undefined as unknown, renders: 0, destroyed: false };
  const received: Buffer[] = [];
  const r = {
    get isDestroyed() {
      return state.destroyed;
    },
    controlState: "idle",
    set stdin(v: unknown) {
      state.stdin = v;
    },
    get stdin() {
      return state.stdin;
    },
    stdinListener: (chunk: Buffer) => received.push(chunk),
    requestRender: () => {
      state.renders += 1;
    },
    received,
  };
  return { r: r as never, state };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("an EOF on terminal input reopens it and hands the renderer the new stream", async () => {
  const { r, state } = fakeRenderer();
  const initial = new FakeStream();
  initial.on("data", (r as { stdinListener: (c: Buffer) => void }).stdinListener);
  const reopened = new FakeStream();
  let opens = 0;
  const detach = attachRendererGuards(r, initial, {
    openInput: () => {
      opens += 1;
      return reopened;
    },
  });
  initial.eof();
  await tick();
  expect(opens).toBe(1);
  expect(state.stdin).toBe(reopened);
  reopened.emit("data", Buffer.from("x"));
  expect((r as { received: Buffer[] }).received.map(String)).toEqual(["x"]);
  detach();
  // The reopened descriptor is released on teardown so the process can exit.
  expect(reopened.destroyed).toBe(true);
});

test("no reopen once the renderer is destroyed", async () => {
  const { r, state } = fakeRenderer();
  const initial = new FakeStream();
  let opens = 0;
  const detach = attachRendererGuards(r, initial, {
    openInput: () => {
      opens += 1;
      return new FakeStream();
    },
  });
  state.destroyed = true;
  initial.eof();
  await tick();
  expect(opens).toBe(0);
  detach();
});

test("reopening is rate-limited when the terminal keeps ending", async () => {
  const { r } = fakeRenderer();
  const initial = new FakeStream();
  const streams: FakeStream[] = [];
  const detach = attachRendererGuards(r, initial, {
    openInput: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
  });
  initial.eof();
  await tick();
  for (let i = 0; i < 10; i++) {
    streams.at(-1)?.eof();
    await tick();
  }
  expect(streams.length).toBe(5);
  detach();
});

test("SIGUSR2 on a dead stream reopens it", async () => {
  const { r, state } = fakeRenderer();
  const initial = new FakeStream();
  initial.destroyed = true; // died before anyone noticed
  const reopened = new FakeStream();
  const detach = attachRendererGuards(r, initial, { openInput: () => reopened });
  process.emit("SIGUSR2", "SIGUSR2");
  expect(state.stdin).toBe(reopened);
  detach();
});
