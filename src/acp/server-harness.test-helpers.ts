// An in-process `runAcpServer` harness: a controllable stdin plus a frame log
// with event-driven waits. Shared by `server-mcp.test.ts` (flow 287) and
// `server-models.test.ts` (flow 288).

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAcpServer, type AcpServerOptions } from "./server";

export interface Frame {
  id?: string | number | null;
  method?: string;
  params?: { sessionId?: string; update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

/** A controllable stdin plus a frame log with event-driven waits. */
export function harness(overrides: Partial<AcpServerOptions>) {
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const input: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (lines.length > 0) yield lines.shift() as string;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
  const frames: Frame[] = [];
  const stderr: string[] = [];
  const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-server-mcp-")));
  const done = runAcpServer({
    input,
    write: (chunk) => {
      for (const line of chunk.split("\n").filter((l) => l.trim().length > 0)) {
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        for (const waiter of [...waiters]) {
          if (waiter.match(frame)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      }
    },
    logError: (line) => stderr.push(line),
    providerId: "test",
    modelId: "test-model",
    dataDir: path.join(root, "data"),
    // Flow 306 (W6, T15): this harness runs `runAcpServer` IN-PROCESS, inside
    // `bun test` — a built-in command hook's `resolveKeryxArgv` would resolve
    // to the test runner's own entry script, not `keryx`'s, so a spawned
    // built-in here would fail for a reason that says nothing about ACP or
    // about hooks. A REAL subprocess launch of `keryx acp`
    // (`AcpProcessClient`'s `*.process.test.ts` suites) has no such problem
    // and is unaffected by this default. A test that wants to exercise the
    // real hook path overrides this back to `{}` (or a fixed test env) via
    // `overrides.hooksEnv`.
    hooksEnv: { KERYX_HOOKS: "off" },
    ...overrides,
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown>): number => {
    const id = nextId++;
    lines.push(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    wake?.();
    return id;
  };
  const notify = (method: string, params: Record<string, unknown>): void => {
    lines.push(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    wake?.();
  };
  const waitFor = (match: (f: Frame) => boolean): Promise<Frame> => {
    const already = frames.find(match);
    if (already !== undefined) return Promise.resolve(already);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const end = async (): Promise<void> => {
    ended = true;
    wake?.();
    await done;
  };
  return { request, notify, waitFor, frames, stderr, end, done, projectDir: root };
}

