// RED tests for `BusClient.ack` (flow 274 T5, AC4): writing an `ack` event
// for a delivered message. Mirrors `client.test.ts`'s real-temp-git-repo
// setup (git itself is real and fast; only the production 5 s/1500 ms
// intervals are avoided, via injected fake timers).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { joinBus, type BusClient, type BusTimers, type JoinBusOptions, type RenderedBusEvent } from "./client";
import { cursorAtStart, readEvents } from "./log";
import { resolveBusRoot } from "./paths";

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-ack-"));
  ROOTS.push(dir);
  await writeFile(path.join(dir, "README.md"), "x\n", "utf8");
  await git(dir, "init", "-b", "main");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "initial");
  return dir;
}

function fakeTimers(): BusTimers {
  return {
    setInterval: () => 0,
    clearInterval: () => {},
  };
}

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const OTHER = "0f8fad5b-d9cb-469f-a165-70867728950e";

function asClient(result: BusClient | { disabled: string }): BusClient {
  if ("disabled" in result) throw new Error(`joinBus unexpectedly disabled: ${result.disabled}`);
  return result;
}

function join(cwd: string, overrides: Partial<JoinBusOptions> = {}): Promise<BusClient | { disabled: string }> {
  return joinBus({
    cwd,
    sessionId: "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f",
    surface: "readline",
    env: {},
    now: () => NOW,
    host: "this-host",
    isAlive: () => false,
    status: () => ({ status: "idle", activity: "" }),
    timers: fakeTimers(),
    onEvent: () => {},
    onPeers: () => {},
    ...overrides,
  });
}

function deliveredEvent(overrides: Partial<RenderedBusEvent> = {}): RenderedBusEvent {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    seq: 1,
    shortId: "7c9e6679",
    fromName: "release",
    fromInstanceId: OTHER,
    kind: "notice",
    preview: "hi",
    body: "hi",
    toStar: false,
    ...overrides,
  };
}

describe("AC4: BusClient.ack", () => {
  test("appends one ack event per input: origin system, addressed to the sender, refs.replyTo the delivered id", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    const { root } = await resolveBusRoot(cwd);

    client.ack([deliveredEvent()]);
    // ack() is fire-and-forget; give its internal append a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { events } = await readEvents(root, await cursorAtStart(root));
    const acks = events.filter((e) => e.kind === "ack");
    expect(acks.length).toBe(1);
    expect(acks[0]?.from).toEqual({ instanceId: client.instanceId, name: client.name, origin: "system" });
    expect(acks[0]?.to).toEqual([OTHER]);
    expect(acks[0]?.refs?.replyTo).toBe("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    expect(acks[0]?.body).toBeUndefined();
    client.leave();
  });

  test("acks several events in one call, each addressed to its own sender", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    const { root } = await resolveBusRoot(cwd);
    const secondSender = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

    client.ack([
      deliveredEvent({ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", fromInstanceId: OTHER, fromName: "release" }),
      deliveredEvent({ id: "00000000-0000-4000-8000-000000000001", fromInstanceId: secondSender, fromName: "scribe" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { events } = await readEvents(root, await cursorAtStart(root));
    const acks = events.filter((e) => e.kind === "ack");
    expect(acks.length).toBe(2);
    expect(acks.map((e) => e.to[0]).sort()).toEqual([OTHER, secondSender].sort());
    client.leave();
  });

  test("a failing append is reported via onError(\"ack\") and never thrown", async () => {
    const cwd = await repo();
    const errors: Array<[unknown, string]> = [];
    const client = asClient(await join(cwd, { onError: (error, where) => errors.push([error, where]) }));

    // An invalid sender instance id fails schema validation inside
    // appendEvent (`to` must be a UUID or exactly ["*"]) — a deterministic way
    // to make the append refuse without touching the filesystem.
    expect(() => client.ack([deliveredEvent({ fromInstanceId: "not-a-uuid" })])).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors.length).toBe(1);
    expect(errors[0]?.[1]).toBe("ack");
    client.leave();
  });

  test("no-op after leave(): no ack event is appended", async () => {
    const cwd = await repo();
    const client = asClient(await join(cwd));
    const { root } = await resolveBusRoot(cwd);
    client.leave();

    client.ack([deliveredEvent()]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { events } = await readEvents(root, await cursorAtStart(root));
    expect(events.filter((e) => e.kind === "ack").length).toBe(0);
  });
});
