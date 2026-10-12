// Flow 377 T7: `/channels` is a first-class TUI surface. The sidebar row, the modal and the
// readline text are built from one snapshot; the bot token goes through a hidden entry and
// reaches nothing but `startPairing`. The client is faked: no serve, no Telegram.

import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import type { ChannelsDisconnectResult, ChannelsResult } from "../remote/channels-client";
import type { ChannelsStatusResponse, PairingResponse, TelegramChannelState } from "../remote/protocol";
import { HELP_GROUPS } from "../standard/help-groups";
import { classifyBusyDispatch } from "./busy-dispatch";
import {
  CHANNELS_COMMAND,
  CHANNELS_USAGE,
  codeLifetime,
  channelsStatusLines,
  channelsViewLines,
  isChannelsCommand,
  loadChannelsSnapshot,
  mountChannelsPanel,
  openChannels,
  parseChannelsArgs,
  projectChannelsRow,
  readlineChannelsText,
  renderingLines,
  type ChannelsApi,
  type ChannelsSnapshot,
} from "./channels-surface";
import { CONFIRM_MIN_GAP_MS } from "./settings-modal";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { clickNode, findById, keypressSource, loadOpenTui, mountChrome, settle, textOf } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const TOKEN = "123456789:AAFakeTokenValue_xyz-0";
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

// ---- fakes -----------------------------------------------------------------

const ok = <T>(value: T): ChannelsResult<T> => ({ ok: true, value });
const fail = (code: string, reason: string): ChannelsResult<never> => ({ ok: false, code, reason });

function status(state: TelegramChannelState, extra: { reason?: string; sessions?: number } = {}): ChannelsStatusResponse {
  return { schemaVersion: "1", machine: "devbox", telegram: { state, sessions: extra.sessions ?? 0, ...(extra.reason === undefined ? {} : { reason: extra.reason }) } };
}

function pairing(partial: Partial<PairingResponse> & Pick<PairingResponse, "state">): PairingResponse {
  return { schemaVersion: "1", expiresAt: T0 + 10 * 60_000, problems: [], ...partial };
}

function fakeClient(initial: { status?: ChannelsResult<ChannelsStatusResponse>; files?: { tokenFile: boolean; configFile: boolean } } = {}) {
  const calls = { startPairing: [] as string[], pairingStatus: 0, cancel: 0, connectFinish: [] as { userId: number; chatId: number }[], test: 0, disconnect: 0, reload: 0 };
  const fake = {
    calls,
    status: initial.status ?? ok(status("not-connected")),
    files: initial.files ?? { tokenFile: false, configFile: false },
    start: ok(pairing({ state: "waiting-for-user", code: "K7Q-2MX", botUsername: "keryx_demo_bot" })) as ChannelsResult<PairingResponse>,
    pairingNow: ok(pairing({ state: "waiting-for-user", code: "K7Q-2MX", botUsername: "keryx_demo_bot" })) as ChannelsResult<PairingResponse>,
    testResult: ok({ schemaVersion: "1", delivered: true as const, machine: "devbox" }) as ChannelsResult<{ schemaVersion: string; delivered: true; machine: string }>,
    reloadResult: ok({ schemaVersion: "1", state: "connected" as const }) as ChannelsResult<{ schemaVersion: string; state: string }>,
    disconnectResult: ok({ deleted: 3, remaining: 0, topicsDeleted: true, erased: true, message: "Disconnected: 3 topics deleted, 0 remaining. The token was erased." }) as ChannelsResult<ChannelsDisconnectResult>,
  };
  const api: ChannelsApi = {
    localFiles: () => fake.files,
    status: async () => fake.status,
    startPairing: async (token) => {
      calls.startPairing.push(token);
      return fake.start;
    },
    pairingStatus: async () => {
      calls.pairingStatus += 1;
      return fake.pairingNow;
    },
    cancelPairing: async () => {
      calls.cancel += 1;
      fake.status = ok(status("not-connected"));
      return ok({ cancelled: true });
    },
    connectFinish: async (ids) => {
      calls.connectFinish.push(ids);
      fake.status = ok(status("connected"));
      return ok({ schemaVersion: "1", state: "connected" as const });
    },
    test: async () => {
      calls.test += 1;
      return fake.testResult;
    },
    reload: async () => {
      calls.reload += 1;
      if (fake.reloadResult.ok) {
        fake.status = ok(status("connected"));
      }
      return fake.reloadResult as never;
    },
    disconnect: async () => {
      calls.disconnect += 1;
      fake.status = ok(status("not-connected"));
      return fake.disconnectResult;
    },
  };
  return { api, fake };
}

function ticker() {
  const fns: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      fns.push(fn);
      return () => {
        const at = fns.indexOf(fn);
        if (at >= 0) fns.splice(at, 1);
      };
    },
    tick: () => fns.slice().forEach((fn) => fn()),
    active: () => fns.length,
  };
}

function pasteSource(renderer: unknown) {
  const internal = (renderer as { _internalKeyInput: { onInternal(e: string, h: unknown): void; offInternal(e: string, h: unknown): void } })._internalKeyInput;
  return (handler: (event: { bytes: Uint8Array }) => void): (() => void) => {
    internal.onInternal("paste", handler);
    return () => internal.offInternal("paste", handler);
  };
}

async function openModalFor(h: Awaited<ReturnType<typeof mountChrome>>, client: ChannelsApi, extra: Partial<Parameters<typeof openChannels>[2]> = {}) {
  const otui = OTUI!;
  const modal = openChannels(otui.core, h.chrome, {
    client,
    renderer: h.renderer as never,
    onKeypress: keypressSource(h.renderer) as never,
    onPaste: pasteSource(h.renderer),
    ...extra,
  });
  await settle(h, 6);
  return modal;
}

// ---- parsing and projection ------------------------------------------------

test("command: /channels and /channels status open the modal, anything else is a usage error", () => {
  expect(CHANNELS_COMMAND).toBe("/channels");
  expect(isChannelsCommand("/channels")).toBe(true);
  expect(isChannelsCommand("  /channels status ")).toBe(true);
  expect(isChannelsCommand("/channelsx")).toBe(false);
  expect(parseChannelsArgs("/channels")).toEqual({ action: "open" });
  expect(parseChannelsArgs("/channels STATUS")).toEqual({ action: "open" });
  expect(parseChannelsArgs("/channels connect")).toEqual({ action: "invalid", message: CHANNELS_USAGE });
});

test("command: listed in the agent command table, the help groups and the busy dispatch", () => {
  expect(commandsForMode("agent").some((c) => c.name === "/channels")).toBe(true);
  expect(HELP_GROUPS.some((g) => g.kind === "slash" && g.name === "/channels" && g.group === "Automation")).toBe(true);
  const idle = { isSessionInfo: false, isFlows: false, isWorkspace: false, isReview: false, isMcp: false, isMcpConsumer: false };
  expect(classifyBusyDispatch({ line: "/channels", commandName: "/channels", ...idle })).toBe("channels");
});

test("sidebar row: off, pairing, connected and serve down", () => {
  const W = SIDEBAR_TEXT_WIDTH;
  const snap = (s: Partial<ChannelsSnapshot> & Pick<ChannelsSnapshot, "state">): ChannelsSnapshot => ({ configured: s.state !== "not-connected", ...s });
  expect(projectChannelsRow(undefined, W)).toMatchObject({ text: "…", role: "muted" });
  expect(projectChannelsRow(snap({ state: "not-connected" }), W)).toMatchObject({ text: "off", role: "muted" });
  expect(projectChannelsRow(snap({ state: "pairing" }), W)).toMatchObject({ text: "pairing", role: "attention" });
  expect(projectChannelsRow(snap({ state: "connected" }), W)).toMatchObject({ text: "connected", role: "ok" });
  expect(projectChannelsRow(snap({ state: "off" }), W)).toMatchObject({ text: "off", role: "attention" });
  expect(projectChannelsRow(snap({ state: "serve-down", configured: true }), W)).toMatchObject({ text: "serve down", role: "attention" });
  expect(projectChannelsRow(snap({ state: "serve-down", configured: false }), W)).toMatchObject({ text: "off", role: "muted" });
  expect(projectChannelsRow(snap({ state: "connected" }), 4).text.length).toBeLessThanOrEqual(4);
});

test("snapshot: a served status wins; an unreachable serve is read against the local files", async () => {
  const served = fakeClient({ status: ok(status("connected", { sessions: 2 })) });
  expect(await loadChannelsSnapshot(served.api)).toMatchObject({ state: "connected", configured: true, machine: "devbox", sessions: 2 });

  const downConfigured = fakeClient({ status: fail("serve-down", "keryx serve is not running."), files: { tokenFile: true, configFile: false } });
  expect(await loadChannelsSnapshot(downConfigured.api)).toMatchObject({ state: "serve-down", configured: true, reason: "keryx serve is not running." });

  const downEmpty = fakeClient({ status: fail("serve-down", "keryx serve is not running.") });
  expect(await loadChannelsSnapshot(downEmpty.api)).toMatchObject({ state: "serve-down", configured: false });

  const refused = fakeClient({ status: fail("rejected", "serve said no") });
  expect(await loadChannelsSnapshot(refused.api)).toMatchObject({ state: "error", reason: "serve said no" });
});

test("readline: the state as text, and where Connect lives", () => {
  const down: ChannelsSnapshot = { state: "serve-down", configured: false, reason: "keryx serve is not running." };
  const text = readlineChannelsText("/channels", down);
  expect(text).toContain("keryx serve is not running");
  expect(text).toContain("keryx shell");
  expect(text).toContain("hidden token");
  expect(readlineChannelsText("/channels", { state: "connected", configured: true, machine: "devbox", sessions: 1 })).toContain("Telegram: connected");
  expect(readlineChannelsText("/channels bogus", down)).toBe(`${CHANNELS_USAGE}\n`);
  expect(channelsStatusLines({ state: "off", configured: true, reason: "another poller owns the token" }).join("\n")).toContain("another poller owns the token");
});

test("view lines: the token step shows only asterisks, and each pairing step says what to do", () => {
  const ctx = { tokenLength: 5, now: T0 };
  const tokenLines = channelsViewLines({ kind: "token" }, undefined, ctx).map((l) => l.text).join("\n");
  expect(tokenLines).toContain("Step 1 of 4");
  expect(tokenLines).toContain("Token: *****");

  const waiting = channelsViewLines({ kind: "pairing", pairing: pairing({ state: "waiting-for-user", code: "K7Q-2MX", botUsername: "keryx_demo_bot" }) }, undefined, ctx).map((l) => l.text).join("\n");
  expect(waiting).toContain("Step 2 of 4");
  expect(waiting).toContain("@keryx_demo_bot");
  expect(waiting).toContain("K7Q-2MX");
  expect(waiting).toContain("10 min");

  const group = channelsViewLines({ kind: "pairing", pairing: pairing({ state: "waiting-for-group", botUsername: "keryx_demo_bot", problems: ["topics are off in this group"] }) }, undefined, ctx).map((l) => l.text).join("\n");
  expect(group).toContain("Step 3 of 4");
  expect(group).toContain("Manage topics");
  expect(group).toContain("topics are off in this group");
  expect(group).not.toContain("valid for");

  const done = channelsViewLines({ kind: "connected", group: "Team", test: { tone: "ok", text: "Test message delivered" } }, { state: "connected", configured: true, machine: "devbox" }, ctx).map((l) => l.text).join("\n");
  expect(done).toContain("Step 4 of 4");
  expect(done).toContain("Group: Team");
  expect(done).toContain("Test message delivered");

  expect(codeLifetime(T0 + 30_000, T0)).toBe("less than a minute");
  expect(codeLifetime(T0 - 1, T0)).toBe("expired");
});

// ---- modal -----------------------------------------------------------------

otuiTest("modal: unconfigured shows only Connect", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api } = fakeClient();
  const modal = await openModalFor(h, api);
  try {
    const frame = h.captureCharFrame();
    expect(frame).toContain("Telegram: not connected");
    expect(frame).toContain("Connect");
    expect(frame).not.toContain("Disconnect");
    expect(frame).not.toContain("Test");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("modal: configured shows Test and Disconnect, not Connect", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api } = fakeClient({ status: ok(status("connected", { sessions: 2 })) });
  const modal = await openModalFor(h, api);
  try {
    const frame = h.captureCharFrame();
    expect(frame).toContain("Telegram: connected");
    expect(frame).toContain("Sessions in Telegram: 2");
    expect(frame).toContain("Test");
    expect(frame).toContain("Disconnect");
    expect(frame).not.toContain("[Connect]");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("modal: serve down names the reason and offers no Connect that cannot work", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api } = fakeClient({ status: fail("serve-down", "keryx serve is not running."), files: { tokenFile: false, configFile: false } });
  const modal = await openModalFor(h, api);
  try {
    await h.mockInput.typeText("c");
    await settle(h, 6);
    const frame = h.captureCharFrame();
    expect(frame).toContain("keryx serve is not running");
    expect(frame).not.toContain("Step 1 of 4");
    expect(frame).not.toContain("Connect");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("connect: hidden token, code, group, connected - the token reaches only startPairing", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient();
  const clock = { now: T0 };
  const timer = ticker();
  const modal = await openModalFor(h, api, { now: () => clock.now, schedule: timer.schedule });
  const frames: string[] = [];
  const snap = (): void => {
    frames.push(h.captureCharFrame());
  };
  try {
    await h.mockInput.typeText("c");
    await settle(h, 6);
    snap();
    expect(frames.at(-1)).toContain("Step 1 of 4");
    expect(frames.at(-1)).toContain("(waiting for the token)");

    // typed: `x` is a token character here, not "close the modal"
    await h.mockInput.typeText(TOKEN.slice(0, 10));
    await settle(h);
    snap();
    expect(frames.at(-1)).toContain("Token: **********");
    expect(frames.at(-1)).toContain("Step 1 of 4");

    // paste, then backspace
    await h.mockInput.pasteBracketedText(TOKEN.slice(10));
    await settle(h);
    snap();
    expect(frames.at(-1)).toContain(`Token: ${"*".repeat(TOKEN.length)}`);
    await h.mockInput.pressBackspace();
    await h.mockInput.typeText(TOKEN.slice(-1));
    await settle(h);

    await h.mockInput.pressEnter();
    await settle(h, 8);
    snap();
    expect(fake.calls.startPairing).toEqual([TOKEN]);
    expect(frames.at(-1)).toContain("Step 2 of 4");
    expect(frames.at(-1)).toContain("@keryx_demo_bot");
    expect(frames.at(-1)).toContain("K7Q-2MX");
    expect(timer.active()).toBe(1);

    // the user wrote to the bot: the group is next, with what is missing
    fake.pairingNow = ok(pairing({ state: "waiting-for-group", botUsername: "keryx_demo_bot", userId: 42, problems: ["topics are off in this group"] }));
    timer.tick();
    await settle(h, 6);
    snap();
    expect(frames.at(-1)).toContain("Step 3 of 4");
    expect(frames.at(-1)).toContain("Manage topics");
    expect(frames.at(-1)).toContain("topics are off in this group");

    // the group is ready: finish, then the test message
    fake.pairingNow = ok(pairing({ state: "ready", userId: 42, chatId: -1001234, chatTitle: "Team room", botUsername: "keryx_demo_bot" }));
    timer.tick();
    await settle(h, 10);
    snap();
    expect(fake.calls.connectFinish).toEqual([{ userId: 42, chatId: -1001234 }]);
    expect(fake.calls.test).toBe(1);
    expect(frames.at(-1)).toContain("Step 4 of 4");
    expect(frames.at(-1)).toContain("Team room");
    expect(frames.at(-1)).toContain("Test message delivered");
    expect(timer.active()).toBe(0);

    // not once in any frame, and never in a toast
    for (const frame of frames) expect(frame).not.toContain(TOKEN.slice(0, 12));
    expect(h.toasts.join(" ")).not.toContain(TOKEN.slice(0, 12));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("token entry: Esc clears what was typed, and the next entry starts empty", async () => {
  const h = await mountChrome(OTUI!, { height: 40, kittyKeyboard: true });
  const { api, fake } = fakeClient();
  const modal = await openModalFor(h, api);
  try {
    await h.mockInput.typeText("c");
    await settle(h, 6);
    await h.mockInput.typeText("abc");
    await settle(h);
    expect(h.captureCharFrame()).toContain("Token: ***");
    await h.mockInput.pressEscape();
    await settle(h, 6);
    expect(h.captureCharFrame()).toContain("Telegram: not connected");
    await h.mockInput.typeText("c");
    await settle(h, 6);
    expect(h.captureCharFrame()).toContain("(waiting for the token)");
    expect(fake.calls.startPairing).toEqual([]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("token entry: a refused token comes back with the client's reason and an empty field", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient();
  fake.start = fail("token-rejected", "Telegram did not accept that token. Copy it again from @BotFather.");
  const modal = await openModalFor(h, api);
  try {
    await h.mockInput.typeText("c");
    await settle(h, 6);
    await h.mockInput.typeText("badtoken");
    await h.mockInput.pressEnter();
    await settle(h, 8);
    const frame = h.captureCharFrame();
    expect(fake.calls.startPairing).toEqual(["badtoken"]);
    expect(frame).toContain("Step 1 of 4");
    expect(frame).toContain("Telegram did not accept that token");
    expect(frame).toContain("(waiting for the token)");
    expect(frame).not.toContain("badtoken");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("pairing: an expired code says so and offers Try again", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient();
  const timer = ticker();
  const modal = await openModalFor(h, api, { schedule: timer.schedule });
  try {
    await h.mockInput.typeText("c");
    await settle(h, 6);
    await h.mockInput.typeText("tok");
    await h.mockInput.pressEnter();
    await settle(h, 8);
    expect(h.captureCharFrame()).toContain("Step 2 of 4");
    fake.pairingNow = ok(pairing({ state: "expired" }));
    timer.tick();
    await settle(h, 8);
    const frame = h.captureCharFrame();
    expect(frame).toContain("The pairing code expired");
    expect(frame).toContain("Try again");
    expect(timer.active()).toBe(0);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("resume: a pairing that already reached ready is connected from the list view", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  // The modal was closed after the Telegram steps: serve still holds the finished pairing and reports "pairing".
  const { api, fake } = fakeClient({ status: ok(status("pairing")) });
  fake.pairingNow = ok(pairing({ state: "ready", userId: 42, chatId: -1001234, chatTitle: "Team room", botUsername: "keryx_demo_bot" }));
  const modal = await openModalFor(h, api);
  try {
    expect(h.captureCharFrame()).toContain("Resume");
    await h.mockInput.typeText("c");
    await settle(h, 10);
    expect(fake.calls.pairingStatus).toBe(1);
    expect(fake.calls.connectFinish).toEqual([{ userId: 42, chatId: -1001234 }]);
    expect(fake.calls.startPairing).toEqual([]);
    const frame = h.captureCharFrame();
    expect(frame).toContain("Step 4 of 4");
    expect(frame).toContain("Team room");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("token entry: x, X and Esc belong to the hidden field on a SECOND open too", async () => {
  const h = await mountChrome(OTUI!, { height: 40, kittyKeyboard: true });
  const { api, fake } = fakeClient();
  const first = await openModalFor(h, api);
  first?.close();
  await settle(h, 4);
  const modal = await openModalFor(h, api);
  try {
    await h.mockInput.typeText("c");
    await settle(h, 6);
    await h.mockInput.typeText("xX1");
    await settle(h);
    // the global close-on-x would have closed the modal; it is still on the token step with three characters
    const typed = h.captureCharFrame();
    expect(typed).toContain("Step 1 of 4");
    expect(typed).toContain("Token: ***");
    await h.mockInput.pressEscape();
    await settle(h, 6);
    // Esc leaves the token step, not the modal
    expect(h.captureCharFrame()).toContain("Telegram: not connected");
    expect(fake.calls.startPairing).toEqual([]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("leftovers: a token file with no config and no pairing is shown, and Disconnect erases it", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient({ status: ok(status("not-connected")), files: { tokenFile: true, configFile: false } });
  const clock = { now: T0 };
  const modal = await openModalFor(h, api, { now: () => clock.now });
  try {
    const frame = h.captureCharFrame();
    expect(frame).toContain("left on this machine");
    expect(frame).toContain("Disconnect");
    await h.mockInput.typeText("d");
    await settle(h, 6);
    await h.mockInput.pressKey("ARROW_RIGHT");
    clock.now += CONFIRM_MIN_GAP_MS;
    await h.mockInput.pressEnter();
    await settle(h, 8);
    expect(fake.calls.disconnect).toBe(1);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("leftovers: serve down with a token file still offers Disconnect", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api } = fakeClient({ status: fail("serve-down", "keryx serve is not running."), files: { tokenFile: true, configFile: false } });
  const modal = await openModalFor(h, api);
  try {
    const frame = h.captureCharFrame();
    expect(frame).toContain("keryx serve is not running");
    expect(frame).toContain("Disconnect");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("pairing: serve answering no-pairing means the code is dead (serve restarted), not a silent hang", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient();
  const timer = ticker();
  const modal = await openModalFor(h, api, { schedule: timer.schedule });
  try {
    await h.mockInput.typeText("c");
    await settle(h, 6);
    await h.mockInput.typeText("tok");
    await h.mockInput.pressEnter();
    await settle(h, 8);
    expect(h.captureCharFrame()).toContain("Step 2 of 4");
    fake.pairingNow = fail("no-pairing", "No pairing is open; start one first.");
    timer.tick();
    await settle(h, 8);
    const frame = h.captureCharFrame();
    expect(frame).toContain("no longer has this pairing");
    expect(frame).toContain("Try again");
    expect(fake.calls.cancel).toBeGreaterThan(0);
    expect(timer.active()).toBe(0);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("test: delivered, and the reason when it is not", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient({ status: ok(status("connected")) });
  const modal = await openModalFor(h, api);
  try {
    await h.mockInput.typeText("t");
    await settle(h, 8);
    expect(fake.calls.test).toBe(1);
    expect(h.captureCharFrame()).toContain("Test message delivered");

    fake.testResult = fail("not-connected", "The hub is not running, so nothing can be sent.");
    await h.mockInput.typeText("t");
    await settle(h, 8);
    expect(fake.calls.test).toBe(2);
    expect(h.captureCharFrame()).toContain("The hub is not running, so nothing can be sent.");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("disconnect: asks first, Cancel is the default, a held Enter cannot confirm, then it reports what was deleted", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient({ status: ok(status("connected")) });
  const clock = { now: T0 };
  const modal = await openModalFor(h, api, { now: () => clock.now });
  try {
    await h.mockInput.typeText("d");
    await settle(h, 6);
    expect(h.captureCharFrame()).toContain("Disconnect Telegram from this machine?");
    expect(fake.calls.disconnect).toBe(0);

    // Enter on the default button cancels
    await h.mockInput.pressEnter();
    await settle(h, 6);
    expect(fake.calls.disconnect).toBe(0);
    expect(h.captureCharFrame()).toContain("Telegram: connected");

    // → onto "Yes, disconnect": an Enter inside the gap is the old auto-repeat, not a decision
    await h.mockInput.typeText("d");
    await settle(h, 6);
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter();
    await settle(h, 6);
    expect(fake.calls.disconnect).toBe(0);
    expect(h.captureCharFrame()).toContain("Disconnect Telegram from this machine?");

    clock.now += CONFIRM_MIN_GAP_MS;
    await h.mockInput.pressEnter();
    await settle(h, 8);
    expect(fake.calls.disconnect).toBe(1);
    const frame = h.captureCharFrame();
    expect(frame).toContain("3 topics deleted, 0 remaining");
    expect(frame).toContain("Telegram: not connected");
    expect(frame).not.toContain("Disconnect Telegram from this machine?");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("disconnect: topics that stayed are reported and the notice is not green", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient({ status: ok(status("connected")) });
  fake.disconnectResult = ok({ deleted: 1, remaining: 2, topicsDeleted: true, erased: true, message: "Disconnected, but 2 topics stayed in the group." });
  const clock = { now: T0 };
  const modal = await openModalFor(h, api, { now: () => clock.now });
  try {
    await h.mockInput.typeText("d");
    await settle(h, 6);
    await h.mockInput.pressKey("ARROW_RIGHT");
    clock.now += CONFIRM_MIN_GAP_MS;
    await h.mockInput.pressEnter();
    await settle(h, 8);
    expect(h.captureCharFrame()).toContain("2 topics stayed in the group");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("modal: closing it stops the polling and drops the key handlers", async () => {
  const h = await mountChrome(OTUI!, { height: 40, kittyKeyboard: true });
  const { api, fake } = fakeClient();
  const timer = ticker();
  const modal = await openModalFor(h, api, { schedule: timer.schedule });
  try {
    await h.mockInput.typeText("c");
    await settle(h, 6);
    await h.mockInput.typeText("tok");
    await h.mockInput.pressEnter();
    await settle(h, 8);
    expect(timer.active()).toBe(1);
    modal?.close();
    await settle(h, 4);
    expect(timer.active()).toBe(0);
    const polls = fake.calls.pairingStatus;
    timer.tick();
    expect(fake.calls.pairingStatus).toBe(polls);
  } finally {
    h.destroy();
  }
});

otuiTest("modal: onChanged tells the sidebar every state the modal reads", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api } = fakeClient({ status: ok(status("connected")) });
  const seen: string[] = [];
  const modal = await openModalFor(h, api, { onChanged: (s) => seen.push(s.state) });
  try {
    expect(seen).toContain("connected");
  } finally {
    modal?.close();
    h.destroy();
  }
});

// ---- sidebar panel ---------------------------------------------------------

otuiTest("sidebar: the Telegram row follows refresh() and update(), and a click opens the modal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let state: ChannelsSnapshot = { state: "not-connected", configured: false };
  let opened = 0;
  const timer = ticker();
  const panel = mountChannelsPanel(otui.core, h.renderer, h.chrome.sidebarTop, {
    width: SIDEBAR_TEXT_WIDTH,
    load: async () => state,
    onOpen: () => (opened += 1),
    schedule: timer.schedule,
  });
  try {
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-channels-k"))).toBe("Telegram");
    expect(textOf(findById(h.chrome.sidebarTop, "sb-channels-v"))).toBe("off");

    state = { state: "connected", configured: true };
    timer.tick();
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-channels-v"))).toBe("connected");

    panel.update({ state: "pairing", configured: true });
    expect(textOf(findById(h.chrome.sidebarTop, "sb-channels-v"))).toBe("pairing");
    panel.update({ state: "serve-down", configured: true });
    expect(textOf(findById(h.chrome.sidebarTop, "sb-channels-v"))).toBe("serve down");

    await clickNode(h, findById(h.chrome.sidebarTop, "sb-channels-v"));
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-channels-k"));
    expect(opened).toBe(2);
    expect(panel.activate()).toBe("open");
    expect(opened).toBe(3);
  } finally {
    panel.dispose();
    expect(timer.active()).toBe(0);
    h.destroy();
  }
});

otuiTest("off: Retry starts Telegram again from the saved files and reports the result", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient({ status: ok(status("off", { reason: "Telegram refused the saved token." })), files: { tokenFile: true, configFile: true } });
  fake.reloadResult = fail("cannot-connect", "Telegram is unreachable.") as never;
  const modal = await openModalFor(h, api);
  try {
    let frame = h.captureCharFrame();
    expect(frame).toContain("Retry");
    expect(frame).toContain("Disconnect");

    await h.mockInput.pressEnter();
    await settle(h, 8);
    expect(fake.calls.reload).toBe(1);
    frame = h.captureCharFrame();
    expect(frame).toContain("Telegram did not start: Telegram is unreachable.");
    expect(frame).toContain("configured, but not running");

    fake.reloadResult = ok({ schemaVersion: "1", state: "connected" }) as never;
    await h.mockInput.pressEnter();
    await settle(h, 8);
    expect(fake.calls.reload).toBe(2);
    frame = h.captureCharFrame();
    expect(frame).toContain("Telegram is running again.");
    expect(frame).toContain("Telegram: connected");
    expect(fake.calls.disconnect).toBe(0);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("working: Esc is swallowed, the modal stays until the call finishes", async () => {
  const h = await mountChrome(OTUI!, { height: 40 });
  const { api, fake } = fakeClient({ status: ok(status("off", { reason: "Telegram refused the saved token." })), files: { tokenFile: true, configFile: true } });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: ChannelsApi = {
    ...api,
    reload: async () => {
      await gate;
      return api.reload();
    },
  };
  const modal = await openModalFor(h, slow);
  try {
    await h.mockInput.pressEnter();
    await settle(h, 6);
    expect(h.captureCharFrame()).toContain("Starting Telegram again");
    await h.mockInput.pressEscape();
    // a lone Esc is held back briefly by the terminal parser before it is delivered
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle(h, 6);
    expect(h.captureCharFrame()).toContain("Starting Telegram again");
    release();
    await settle(h, 8);
    expect(fake.calls.reload).toBe(1);
    expect(h.captureCharFrame()).toContain("Telegram is running again.");
  } finally {
    modal?.close();
    h.destroy();
  }
});

// ---- flow 395 (AC8): the rendering mode and the last fallback -----------------------------

test("renderingLines: nothing when serve did not report a mode", () => {
  expect(renderingLines(undefined)).toEqual([]);
});

test("renderingLines: the mode in effect with what it means, and no fallback yet", () => {
  const lines = renderingLines({ mode: "auto" });
  expect(lines[0]).toBe("Rendering: auto (rich for a reply with a table, HTML otherwise). Change it in /settings.");
  expect(lines[1]).toBe("Last fallback: none since keryx serve started.");
});

test("renderingLines: the last fallback names its step, its time and its reason", () => {
  const rich = renderingLines({ mode: "rich", lastFallback: { step: "rich-to-html", reason: "Bad Request: rich_message is invalid", at: T0 } });
  expect(rich[1]).toBe("Last fallback: rich to HTML at 12:00:00 UTC: Bad Request: rich_message is invalid");
  const plain = renderingLines({ mode: "html", lastFallback: { step: "html-to-plain", reason: "can't parse entities", at: T0 + 61_000 } });
  expect(plain[1]).toBe("Last fallback: HTML to plain text at 12:01:01 UTC: can't parse entities");
});

test("every mode has a meaning line", () => {
  for (const mode of ["auto", "rich", "html", "plain"] as const) {
    expect(renderingLines({ mode })[0]).toContain(`Rendering: ${mode} (`);
  }
});

test("the status block of a connected or stopped Telegram carries the rendering lines; not-connected does not", () => {
  const rendering = { mode: "plain" as const, lastFallback: { step: "html-to-plain" as const, reason: "x", at: T0 } };
  for (const state of ["connected", "off"] as const) {
    const text = channelsStatusLines({ state, configured: true, rendering }).join("\n");
    expect(text).toContain("Rendering: plain");
    expect(text).toContain("Last fallback: HTML to plain text");
  }
  expect(channelsStatusLines({ state: "not-connected", configured: false, rendering }).join("\n")).not.toContain("Rendering:");
});

test("loadChannelsSnapshot carries what serve reported, and the readline text shows it", async () => {
  const reported = ok<ChannelsStatusResponse>({
    schemaVersion: "1",
    machine: "devbox",
    telegram: { state: "connected", sessions: 1, rendering: { mode: "rich", lastFallback: { step: "rich-to-html", reason: "unsupported", at: T0 } } },
  });
  const snapshot = await loadChannelsSnapshot({ status: async () => reported, localFiles: () => ({ tokenFile: true, configFile: true }) });
  expect(snapshot.rendering).toEqual({ mode: "rich", lastFallback: { step: "rich-to-html", reason: "unsupported", at: T0 } });
  const text = readlineChannelsText("/channels", snapshot);
  expect(text).toContain("Rendering: rich");
  expect(text).toContain("Last fallback: rich to HTML at 12:00:00 UTC: unsupported");
});

test("loadChannelsSnapshot without a reported mode has none, and the lines stay silent", async () => {
  const snapshot = await loadChannelsSnapshot({ status: async () => ok(status("connected")), localFiles: () => ({ tokenFile: true, configFile: true }) });
  expect(snapshot.rendering).toBeUndefined();
  expect(readlineChannelsText("/channels", snapshot)).not.toContain("Rendering:");
});
