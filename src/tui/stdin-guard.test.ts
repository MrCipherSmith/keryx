import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDebugRun, stopDebugRun } from "./debug-log";
import {
  installInputRecoverySignal,
  instrumentStdin,
  recoverStdin,
  registerRendererInputListener,
  stdinIsDead,
  stdinLooksStalled,
  stdinSnapshot,
  type StdinLike,
} from "./stdin-guard";

/** Minimal stand-in for a tty `process.stdin`. */
class FakeStdin extends EventEmitter implements StdinLike {
  isTTY = true;
  isRaw = true;
  paused = false;
  calls: string[] = [];
  setRawMode(mode: boolean): this {
    this.calls.push(`setRawMode(${mode})`);
    this.isRaw = mode;
    return this;
  }
  isPaused(): boolean {
    return this.paused;
  }
  pause(): this {
    this.calls.push("pause");
    this.paused = true;
    return this;
  }
  resume(): this {
    this.calls.push("resume");
    this.paused = false;
    return this;
  }
  get readableFlowing(): boolean {
    return !this.paused;
  }
}

const dirs: string[] = [];
afterEach(() => {
  stopDebugRun();
  registerRendererInputListener(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function debugRunInTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-debug-"));
  dirs.push(dir);
  return startDebugRun({ configDir: dir }).shellLog;
}

const events = (file: string): { kind: string; [k: string]: unknown }[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string });

describe("stdinLooksStalled", () => {
  test("a flowing raw tty with its renderer listener attached is healthy", () => {
    const stdin = new FakeStdin();
    const listener = (): void => {};
    stdin.on("data", listener);
    registerRendererInputListener(listener);
    expect(stdinLooksStalled(stdinSnapshot(stdin))).toBe(false);
  });
  test("paused, raw mode off, or the renderer listener gone → stalled", () => {
    const listener = (): void => {};
    registerRendererInputListener(listener);
    const paused = new FakeStdin();
    paused.on("data", listener);
    paused.paused = true;
    expect(stdinLooksStalled(stdinSnapshot(paused))).toBe(true);
    const cooked = new FakeStdin();
    cooked.on("data", listener);
    cooked.isRaw = false;
    expect(stdinLooksStalled(stdinSnapshot(cooked))).toBe(true);
    const detached = new FakeStdin();
    detached.on("data", () => {}); // some other listener keeps the count above 0
    expect(stdinLooksStalled(stdinSnapshot(detached))).toBe(true);
  });
});

describe("recoverStdin", () => {
  test("restores raw mode, re-attaches the renderer listener and cycles pause/resume", () => {
    const stdin = new FakeStdin();
    stdin.isRaw = false;
    stdin.paused = true;
    const listener = (): void => {};
    registerRendererInputListener(listener);
    const actions = recoverStdin(stdin, { cycle: true });
    expect(actions).toEqual(["setRawMode(true)", "re-attach renderer data listener", "pause()", "resume()"]);
    expect(stdin.listeners("data")).toContain(listener);
    expect(stdin.isRaw).toBe(true);
    expect(stdin.isPaused()).toBe(false);
  });
  test("never attaches the listener twice", () => {
    const stdin = new FakeStdin();
    const listener = (): void => {};
    stdin.on("data", listener);
    recoverStdin(stdin, { listener });
    expect(stdin.listenerCount("data")).toBe(1);
  });
});

describe("installInputRecoverySignal", () => {
  test("SIGUSR2 re-arms input and reports what it did", () => {
    const stdin = new FakeStdin();
    stdin.paused = true;
    let reported: string[] | undefined;
    const uninstall = installInputRecoverySignal(stdin, (actions) => {
      reported = actions;
    });
    try {
      process.emit("SIGUSR2", "SIGUSR2");
    } finally {
      uninstall();
    }
    expect(stdin.isPaused()).toBe(false);
    expect(reported).toEqual(["pause()", "resume()"]);
  });
  test("does nothing while input is stopped on purpose", () => {
    const stdin = new FakeStdin();
    stdin.paused = true;
    const uninstall = installInputRecoverySignal(stdin, undefined, () => false);
    try {
      process.emit("SIGUSR2", "SIGUSR2");
    } finally {
      uninstall();
    }
    expect(stdin.isPaused()).toBe(true);
  });
});

describe("instrumentStdin", () => {
  test("logs who paused input, with a stack, and never logs typed text", () => {
    const log = debugRunInTmp();
    const stdin = new FakeStdin();
    stdin.on("data", () => {});
    const undo = instrumentStdin(stdin);
    stdin.emit("data", Buffer.from("secret-token\x1b[<65;20;35M"));
    stdin.pause();
    undo();
    const all = events(log);
    const pause = all.find((e) => e.kind === "stdin.pause");
    expect(pause?.stack).toEqual(expect.stringContaining("stdin-guard.test.ts"));
    const data = all.find((e) => e.kind === "stdin.data");
    expect(data).toMatchObject({ printable: 12, control: 1 });
    expect(readFileSync(log, "utf8")).not.toContain("secret");
  });
  test("undo restores the original methods", () => {
    debugRunInTmp();
    const stdin = new FakeStdin();
    const original = stdin.pause;
    const undo = instrumentStdin(stdin);
    expect(stdin.pause).not.toBe(original);
    undo();
    expect(stdin.pause).toBe(original);
  });
});

describe("stdinIsDead", () => {
  test("ended or destroyed streams are dead; a paused one is not", () => {
    const paused = new FakeStdin();
    paused.paused = true;
    expect(stdinIsDead(paused)).toBe(false);
    expect(stdinIsDead(Object.assign(new FakeStdin(), { readableEnded: true }))).toBe(true);
    expect(stdinIsDead(Object.assign(new FakeStdin(), { destroyed: true }))).toBe(true);
  });
});
