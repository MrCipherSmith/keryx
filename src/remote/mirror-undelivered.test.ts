// Flow 464 (AC5): an operator card the Telegram topic cannot get says so. The card is answered in the shell as
// before; the remote side only reports that the mirror was not delivered.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { raceApproval } from "../tui/approval-mirror";
import { withMirrorNote } from "../tui/tui-shell";
import { RemoteClient } from "./client";
import { endpointPath } from "./endpoint";
import { MIRROR_NOT_DELIVERED, RemoteBridge, type RemoteApprovalAnswer, mapApprovalAnswer, mirrorUndeliveredNote } from "./shell-bridge";
import { mintShellToken } from "./shell-token";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("mirrorUndeliveredNote", () => {
  test("no bridge, or remote control off: the note says it is not on in this shell", () => {
    expect(mirrorUndeliveredNote(undefined)).toContain(MIRROR_NOT_DELIVERED);
    expect(mirrorUndeliveredNote(undefined)).toContain("not on in this shell");
    expect(mirrorUndeliveredNote({ active: false, connected: false })).toContain("not on in this shell");
  });

  test("remote control on but the channel is down: the note says it is not connected", () => {
    const note = mirrorUndeliveredNote({ active: true, connected: false });
    expect(note).toContain(MIRROR_NOT_DELIVERED);
    expect(note).toContain("not connected");
  });

  test("a live channel needs no note", () => {
    expect(mirrorUndeliveredNote({ active: true, connected: true })).toBeUndefined();
  });
});

describe("the card carries the note above its subject line", () => {
  test("the subject stays last, so the dialog subtitle is unchanged", () => {
    const card = ["Complete review X?", "reviewed head: abc", "subject: review X"];
    expect(withMirrorNote(card, "NOTE")).toEqual(["Complete review X?", "reviewed head: abc", "NOTE", "subject: review X"]);
  });
});

describe("an unreachable client reports undelivered", () => {
  test("a RemoteClient with no stream answers a card deny with undelivered", async () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-undelivered-")));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const dir = path.join(base, "config");
    mkdirSync(dir, { recursive: true });
    expect(mintShellToken(dir).ok).toBe(true);
    writeOwnerOnlyFileAtomic(endpointPath(dir), `${JSON.stringify({ address: "example.invalid", port: 4455, pid: process.pid })}\n`);
    const client = new RemoteClient({
      sessionId: "sess-un-0001",
      project: "/work/app",
      dir,
      onLine: () => undefined,
      fetchImpl: ((_input: RequestInfo | URL) => Promise.reject(new Error("no network"))) as typeof fetch,
    });
    cleanups.push(() => client.drop());
    await client.start();
    const answer = await client.askApproval("Complete review X?", 200, {});
    expect(answer).toMatchObject({ decision: "deny", undelivered: true });
  });

  test("a bridge with no client denies and says undelivered", async () => {
    const bridge = new RemoteBridge({
      host: {
        sessionId: () => "s",
        project: () => "/p",
        isBusy: () => false,
        runLine: () => undefined,
        enqueue: () => undefined,
        notice: () => undefined,
        cancelTurn: () => undefined,
        recordOn: () => undefined,
        recordOff: () => undefined,
        dropQueuedTelegramLines: () => [],
        onChange: () => undefined,
      },
    });
    expect(await bridge.askApproval("card")).toEqual({ decision: "deny", always: false, undelivered: true });
    expect(bridge.connected).toBe(false);
  });

  test("mapApprovalAnswer keeps the flag on a deny and never lets a press carry it", () => {
    expect(mapApprovalAnswer({ decision: "deny", undelivered: true }, false)).toMatchObject({ decision: "deny", undelivered: true });
    expect(mapApprovalAnswer({ decision: "allow", undelivered: true }, false).undelivered).toBeUndefined();
    expect(mapApprovalAnswer({ decision: "deny" }, false).undelivered).toBeUndefined();
  });
});

describe("raceApproval: a topic leg that never delivered", () => {
  const undelivered: RemoteApprovalAnswer = { decision: "deny", always: false, undelivered: true };

  test("onUndelivered fires and the dock stays the only place to answer", async () => {
    let told = 0;
    const outcome = await raceApproval({
      turnSignal: new AbortController().signal,
      onUndelivered: () => {
        told += 1;
      },
      dock: async (race) => {
        race.opened();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(race.signal.aborted).toBe(false);
        return "answered-in-dock";
      },
      topic: async () => undelivered,
    });
    expect(told).toBe(1);
    expect(outcome).toEqual({ from: "dock", result: "answered-in-dock" });
  });

  test("a delivered question that simply timed out does not fire it", async () => {
    let told = 0;
    await raceApproval({
      turnSignal: new AbortController().signal,
      onUndelivered: () => {
        told += 1;
      },
      dock: async (race) => {
        race.opened();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "dock";
      },
      topic: async () => ({ decision: "deny", always: false }),
    });
    expect(told).toBe(0);
  });
});
