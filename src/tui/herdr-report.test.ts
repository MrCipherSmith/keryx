import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createHerdrReporter,
  herdrStateFor,
  type SocketWriter,
} from "./herdr-report";

const SAVED = {
  env: process.env.HERDR_ENV,
  pane: process.env.HERDR_PANE_ID,
  sock: process.env.HERDR_SOCKET_PATH,
};

function setHerdrEnv(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w7:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr-test.sock";
}

function clearHerdrEnv(): void {
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_SOCKET_PATH;
}

beforeEach(clearHerdrEnv);
afterEach(() => {
  if (SAVED.env !== undefined) process.env.HERDR_ENV = SAVED.env;
  else delete process.env.HERDR_ENV;
  if (SAVED.pane !== undefined) process.env.HERDR_PANE_ID = SAVED.pane;
  else delete process.env.HERDR_PANE_ID;
  if (SAVED.sock !== undefined) process.env.HERDR_SOCKET_PATH = SAVED.sock;
  else delete process.env.HERDR_SOCKET_PATH;
});

/** Capture every request instead of touching a real socket. */
function recorder(): { calls: Array<{ path: string; request: any }>; write: SocketWriter } {
  const calls: Array<{ path: string; request: any }> = [];
  const write: SocketWriter = (path, request) => {
    calls.push({ path, request });
    return Promise.resolve();
  };
  return { calls, write };
}

const CLOCK = (): number => 1000;

test("herdrStateFor maps the TUI vocabulary onto herdr states", () => {
  expect(herdrStateFor("running")).toBe("working");
  expect(herdrStateFor("blocked")).toBe("blocked");
  expect(herdrStateFor("queued")).toBe("idle");
  expect(herdrStateFor("done")).toBe("idle");
  expect(herdrStateFor("failed")).toBe("idle");
});

test("reporter is a no-op when the pane was not launched by herdr", async () => {
  const { calls, write } = recorder();
  const r = createHerdrReporter(CLOCK, write);
  r.report("working");
  await r.release();
  expect(calls).toHaveLength(0);
});

test("reporter is a no-op when HERDR_ENV is set but pane/socket are missing", () => {
  process.env.HERDR_ENV = "1";
  const { calls, write } = recorder();
  createHerdrReporter(CLOCK, write).report("working");
  expect(calls).toHaveLength(0);
});

test("report emits pane.report_agent with keryx identity and state", async () => {
  setHerdrEnv();
  const { calls, write } = recorder();
  const r = createHerdrReporter(CLOCK, write);
  r.report("working");
  await r.release(); // drain the serialized chain
  const first = calls[0]!.request;
  expect(first.method).toBe("pane.report_agent");
  expect(first.params.pane_id).toBe("w7:p1");
  expect(first.params.source).toBe("herdr:keryx");
  expect(first.params.agent).toBe("keryx");
  expect(first.params.state).toBe("working");
  expect(calls[0]!.path).toBe("/tmp/herdr-test.sock");
});

test("repeated identical states are deduped; changes are sent", async () => {
  setHerdrEnv();
  const { calls, write } = recorder();
  const r = createHerdrReporter(CLOCK, write);
  r.report("working");
  r.report("working");
  r.report("blocked");
  r.report("idle");
  await r.release();
  const states = calls.filter((c) => c.request.method === "pane.report_agent").map((c) => c.request.params.state);
  expect(states).toEqual(["working", "blocked", "idle"]);
});

test("release emits pane.release_agent and resolves", async () => {
  setHerdrEnv();
  const { calls, write } = recorder();
  const r = createHerdrReporter(CLOCK, write);
  await r.release();
  const last = calls.at(-1)!.request;
  expect(last.method).toBe("pane.release_agent");
  expect(last.params.agent).toBe("keryx");
});

test("seq is strictly increasing across reports", async () => {
  setHerdrEnv();
  const { calls, write } = recorder();
  const r = createHerdrReporter(CLOCK, write);
  r.report("working");
  r.report("blocked");
  await r.release();
  const seqs = calls.map((c) => c.request.params.seq as number);
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  }
});
