// Flow 376 AC12: `/remote-control` is a first-class TUI surface. The sidebar row,
// the modal, the slash menu entry, the typed command's text, the readline text
// and the `tg` label on Telegram lines are all built from one `RemoteStatus`.

import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { postureLines, postureSidebarText } from "../commands/remote-policy-command";
import type { NormalizedMessage } from "../harness/provider/types";
import type { RemoteBridgeHost, RemoteClientLike, RemoteEvent, RemoteStatus } from "../remote/shell-bridge";
import { REMOTE_EVENT_LIMIT, RemoteBridge, TG_SOURCE } from "../remote/shell-bridge";
import { HELP_GROUPS } from "../standard/help-groups";
import { classifyBusyDispatch } from "./busy-dispatch";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { appendUserEcho } from "./transcript-blocks";
import { createTuiAgentIo } from "./tui-shell";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { chunkColors, clickNode, findById, loadOpenTui, mountChrome, settle, textOf } from "./ops-sidebar.test-helpers";
import {
  REMOTE_CONTROL_COMMAND,
  REMOTE_CONTROL_USAGE,
  REMOTE_FOOTER,
  REMOTE_TABS,
  TG_ECHO_MARKER,
  TG_LABEL,
  commandEchoText,
  HISTORY_COMMAND,
  HISTORY_POSTING_NOTE,
  formatAge,
  formatHistoryStatus,
  isHistoryCommand,
  readlineHistoryText,
  formatRemoteCommandLines,
  formatRemoteEventLines,
  formatRemoteStatusLines,
  isRemoteControlCommand,
  labelTelegramLine,
  mountRemotePanel,
  parseRemoteControlArgs,
  presentRemoteControl,
  projectPostureLine,
  projectRemoteRow,
  readlineRemoteControlText,
  renderRemoteControlText,
} from "./remote-control-surface";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const OFF: RemoteStatus = { state: "off", events: [] };
const ON: RemoteStatus = { state: "on", name: "keryx-demo", heartbeatAgeMs: 12_000, events: [] };
const OFFLINE: RemoteStatus = { state: "offline", name: "keryx-demo", events: [] };

function events(count: number): RemoteEvent[] {
  return Array.from({ length: count }, (_, i) => ({ at: Date.UTC(2026, 9, 1, 10, 0, i), kind: "line" as const, text: `Telegram: line ${i}` }));
}

// ---- sidebar row -----------------------------------------------------------

test("sidebar row: Remote is off, the topic name, or offline", () => {
  expect(projectRemoteRow(undefined, SIDEBAR_TEXT_WIDTH)).toMatchObject({ text: "off", role: "muted", action: "open" });
  expect(projectRemoteRow(OFF, SIDEBAR_TEXT_WIDTH)).toMatchObject({ text: "off", role: "muted" });
  expect(projectRemoteRow(ON, SIDEBAR_TEXT_WIDTH)).toMatchObject({ text: "keryx-demo", role: "ok" });
  expect(projectRemoteRow(OFFLINE, SIDEBAR_TEXT_WIDTH)).toMatchObject({ text: "offline", role: "attention" });
  expect(projectRemoteRow({ state: "on", events: [] }, SIDEBAR_TEXT_WIDTH).text).toBe("connecting");
});

test("sidebar row: a long topic name is cut to the sidebar width", () => {
  const row = projectRemoteRow({ state: "on", name: "a-very-long-topic-name-that-will-not-fit", events: [] }, 12);
  expect(row.text.length).toBeLessThanOrEqual(12);
  expect(row.text.endsWith("…")).toBe(true);
});

otuiTest("sidebar: the mounted row reads Remote plus the state and follows refresh()", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let status: RemoteStatus = OFF;
  const panel = mountRemotePanel(otui.core, h.renderer, h.chrome.sidebarTop, { width: SIDEBAR_TEXT_WIDTH, getStatus: () => status, onOpen: () => {} });
  try {
    expect(textOf(findById(h.chrome.sidebarTop, "sb-remote-k"))).toBe("Remote");
    expect(textOf(findById(h.chrome.sidebarTop, "sb-remote-v"))).toBe("off");
    status = ON;
    panel.refresh();
    expect(textOf(findById(h.chrome.sidebarTop, "sb-remote-v"))).toBe("keryx-demo");
    status = OFFLINE;
    panel.refresh();
    expect(textOf(findById(h.chrome.sidebarTop, "sb-remote-v"))).toBe("offline");
    status = OFF;
    panel.refresh();
    expect(textOf(findById(h.chrome.sidebarTop, "sb-remote-v"))).toBe("off");
  } finally {
    panel.dispose();
    h.destroy();
  }
});

const POSTURE = { defaultMode: "trust" as const, runTimeoutMs: 0, approvalTimeoutMs: 900_000, savedRules: 2 };

test("posture line: shown only while remote control is on or retrying, fitted to the sidebar width", () => {
  const text = postureSidebarText(POSTURE);
  expect(projectPostureLine(OFF, text, SIDEBAR_TEXT_WIDTH)).toBeUndefined();
  expect(projectPostureLine(undefined, text, SIDEBAR_TEXT_WIDTH)).toBeUndefined();
  expect(projectPostureLine(ON, undefined, SIDEBAR_TEXT_WIDTH)).toBeUndefined();
  expect(projectPostureLine(ON, "", SIDEBAR_TEXT_WIDTH)).toBeUndefined();
  const shown = projectPostureLine(ON, text, SIDEBAR_TEXT_WIDTH);
  expect(shown).toContain("trust");
  expect(shown).toContain("2 saved shell rules");
  expect(projectPostureLine(OFFLINE, text, SIDEBAR_TEXT_WIDTH)).toBeDefined();
  for (const line of (shown ?? "").split("\n")) expect(line.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
  expect((projectPostureLine(ON, "x".repeat(80), 12) ?? "").length).toBeLessThanOrEqual(12);
});

otuiTest("sidebar: the posture line follows refresh() and is hidden while remote control is off", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let status: RemoteStatus = OFF;
  let posture: string | undefined = postureSidebarText(POSTURE);
  const panel = mountRemotePanel(otui.core, h.renderer, h.chrome.sidebarTop, {
    width: SIDEBAR_TEXT_WIDTH,
    getStatus: () => status,
    getPosture: () => posture,
    onOpen: () => {},
  });
  try {
    const node = findById(h.chrome.sidebarTop, "sb-remote-p");
    expect(textOf(node)).toBe("");
    status = ON;
    panel.refresh();
    expect(textOf(node)).toContain("trust");
    expect(textOf(node)).toContain("no limit");
    posture = postureSidebarText({ ...POSTURE, defaultMode: "ask", approvalTimeoutMs: 300_000, savedRules: 0 });
    panel.refresh();
    expect(textOf(node)).toContain("ask");
    expect(textOf(node)).toContain("wait 5m");
    status = OFF;
    panel.refresh();
    expect(textOf(node)).toBe("");
  } finally {
    panel.dispose();
    h.destroy();
  }
});

otuiTest("sidebar: a click on the posture line opens /permissions, and the Remote row still opens the modal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let permissions = 0;
  let remote = 0;
  const panel = mountRemotePanel(otui.core, h.renderer, h.chrome.sidebarTop, {
    width: SIDEBAR_TEXT_WIDTH,
    getStatus: () => ON,
    getPosture: () => postureSidebarText(POSTURE),
    onOpen: () => (remote += 1),
    onOpenPermissions: () => (permissions += 1),
  });
  try {
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-remote-p"));
    expect(permissions).toBe(1);
    expect(remote).toBe(0);
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-remote-v"));
    expect(remote).toBe(1);
    expect(permissions).toBe(1);
  } finally {
    panel.dispose();
    h.destroy();
  }
});

test("the status block lists the Telegram permissions and names /remote-policy; without a posture it is unchanged", () => {
  const lines = formatRemoteStatusLines(ON, postureLines({ ...POSTURE, inForce: "ask (shell /mode)" }));
  const text = lines.join("\n");
  expect(text).toContain("Telegram permissions (change with /remote-policy):");
  expect(text).toContain("In force now: ask (shell /mode)");
  expect(text).toContain("Approval wait: 15m");
  expect(formatRemoteStatusLines(ON)).toEqual(formatRemoteStatusLines(ON, undefined));
  expect(formatRemoteStatusLines(ON).join("\n")).not.toContain("Telegram permissions");
  expect(formatRemoteStatusLines(ON, []).join("\n")).not.toContain("Telegram permissions");
});

test("/remote-policy is registered for the agent shell only, in help, and runs while a turn is busy", () => {
  expect(commandsForMode("agent").some((c) => c.name === "/remote-policy")).toBe(true);
  expect(commandsForMode("chat").some((c) => c.name === "/remote-policy")).toBe(false);
  expect(HELP_GROUPS.some((e) => e.kind === "slash" && e.name === "/remote-policy")).toBe(true);
  const target = classifyBusyDispatch({
    line: "/remote-policy mode ask",
    commandName: "/remote-policy",
    isSessionInfo: false,
    isFlows: false,
    isWorkspace: false,
    isReview: false,
    isMcp: false,
    isMcpConsumer: false,
  });
  expect(target).toBe("remote-policy");
});

otuiTest("sidebar: clicking the label or the value opens the modal and starts nothing by itself", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let opened = 0;
  const panel = mountRemotePanel(otui.core, h.renderer, h.chrome.sidebarTop, { width: SIDEBAR_TEXT_WIDTH, getStatus: () => OFF, onOpen: () => (opened += 1) });
  try {
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-remote-v"));
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-remote-k"));
    expect(opened).toBe(2);
    expect(panel.activate()).toBe("open");
    expect(opened).toBe(3);
  } finally {
    panel.dispose();
    h.destroy();
  }
});

otuiTest("sidebar: a /theme switch recolours the row", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const before = getThemeId();
  const panel = mountRemotePanel(otui.core, h.renderer, h.chrome.sidebarTop, { width: SIDEBAR_TEXT_WIDTH, getStatus: () => ON, onOpen: () => {} });
  try {
    applyThemeId("groknight");
    const dark = chunkColors(findById(h.chrome.sidebarTop, "sb-remote-v"));
    expect(dark).toEqual([roleColor("ok").toLowerCase()]);
    applyThemeId("grokday");
    const light = chunkColors(findById(h.chrome.sidebarTop, "sb-remote-v"));
    expect(light).toEqual([roleColor("ok").toLowerCase()]);
    expect(light).not.toEqual(dark);
  } finally {
    applyThemeId(before);
    panel.dispose();
    h.destroy();
  }
});

otuiTest("sidebar: a disposed panel is not repainted by a theme change", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const before = getThemeId();
  let reads = 0;
  const panel = mountRemotePanel(otui.core, h.renderer, h.chrome.sidebarTop, {
    width: SIDEBAR_TEXT_WIDTH,
    getStatus: () => {
      reads += 1;
      return ON;
    },
    onOpen: () => {},
  });
  try {
    panel.dispose();
    const seen = reads;
    applyThemeId(before === "groknight" ? "grokday" : "groknight");
    expect(reads).toBe(seen);
  } finally {
    applyThemeId(before);
    h.destroy();
  }
});

// ---- modal -----------------------------------------------------------------

type Key = { name: string; sequence: string };

function openModalFake(
  getStatus: () => RemoteStatus,
  onToggle: () => void = () => {},
  extra: { getPostureLines?: () => readonly string[] | undefined; visibleRows?: number; onHistory?: () => void | Promise<string | undefined> } = {},
) {
  const painted = new Map<string, { content: string }>();
  let input: { title: string; tabs: readonly { id: string; label: string }[]; initialTab?: string; footer?: readonly { key: string; label: string }[] } | undefined;
  let renderTab!: (tabId: string, body: unknown, ctx?: { width?: number }) => void;
  let keyHandler: ((key: Key) => void) | undefined;
  let released = false;
  let closed = 0;
  const handle = presentRemoteControl(
    (_otui, _chrome, modalInput) => {
      input = modalInput as never;
      renderTab = modalInput.renderTab as never;
      renderTab(modalInput.initialTab ?? "status", {
        add: (child: { content: string; id?: string }) => {
          painted.set(modalInput.initialTab ?? "status", child);
        },
      });
      return { close: () => modalInput.onClose?.(), setTab: () => {}, activeTab: () => modalInput.initialTab ?? "status" };
    },
    {
      TextRenderable: class {
        content: string;
        constructor(_r: unknown, opts: { content: string }) {
          this.content = opts.content;
        }
      },
    },
    {},
    {
      getStatus,
      onToggle,
      visibleRows: 8,
      ...extra,
      onKeypress: (handler) => {
        keyHandler = handler;
        return () => {
          released = true;
        };
      },
    },
  );
  return {
    handle,
    input: () => input,
    switchTo: (tab: string) => {
      renderTab(tab, {
        add: (child: { content: string }) => {
          painted.set(tab, child);
        },
      });
    },
    text: (tab: string) => painted.get(tab)?.content ?? "",
    press: (name: string) => keyHandler?.({ name, sequence: name }),
    released: () => released,
    close: () => {
      closed += 1;
      handle?.close();
    },
    closed: () => closed,
  };
}

test("modal: title, the Status, Events and Commands tabs, and the footer", () => {
  const m = openModalFake(() => ON);
  const input = m.input()!;
  expect(input.title).toBe(REMOTE_CONTROL_COMMAND);
  expect(input.tabs.map((t) => t.id)).toEqual(["status", "events", "commands"]);
  expect(input.tabs).toEqual(REMOTE_TABS as never);
  expect(input.initialTab).toBe("status");
  expect(input.footer).toEqual(REMOTE_FOOTER as never);
  expect(REMOTE_FOOTER.map((f) => f.key)).toEqual(["o", "h", "←/→", "esc"]);
});

test("modal status tab: off, on and offline each say what they are and what turns them on or off", () => {
  const off = openModalFake(() => OFF).text("status");
  expect(off).toContain("Remote control: off");
  expect(off).toContain("Topic: none");
  expect(off).toContain("/remote-control <name>");

  const on = openModalFake(() => ON).text("status");
  expect(on).toContain("Remote control: on");
  expect(on).toContain("Topic: keryx-demo");
  expect(on).toContain("Last heartbeat: 12s ago");
  expect(on).toContain("/remote-control off");

  const offline = openModalFake(() => OFFLINE).text("status");
  expect(offline).toContain("Remote control: offline");
  expect(offline).toContain("Last heartbeat: none yet");
  expect(offline).toContain("Serve is not reachable");
});

test("modal status tab: the Telegram permissions follow the shell, and a posture that changes is repainted", () => {
  let inForce = "trust (Telegram default)";
  const m = openModalFake(() => ON, () => {}, { visibleRows: 30, getPostureLines: () => postureLines({ ...POSTURE, inForce }) });
  expect(m.text("status")).toContain("In force now: trust (Telegram default)");
  expect(m.text("status")).toContain("Telegram permissions (change with /remote-policy):");
  inForce = "ask (shell /mode)";
  m.switchTo("events");
  m.switchTo("status");
  expect(m.text("status")).toContain("In force now: ask (shell /mode)");
});

test("modal events tab: newest first, at most the ring size, and an empty note", () => {
  expect(openModalFake(() => OFF).input()).toBeDefined();
  const empty = openModalFake(() => OFF);
  empty.switchTo("events");
  expect(empty.text("events")).toBe("No remote events yet.");

  const ring = events(REMOTE_EVENT_LIMIT);
  const lines = formatRemoteEventLines({ ...ON, events: ring });
  expect(lines).toHaveLength(REMOTE_EVENT_LIMIT);
  expect(lines[0]).toContain(`line ${REMOTE_EVENT_LIMIT - 1}`);
  expect(lines[0]).toContain("10:00:19");
  expect(lines.at(-1)).toContain("line 0");
  // The status is built from what the bridge keeps (20); a longer list is still shown at most that long.
  expect(formatRemoteEventLines({ ...ON, events: events(REMOTE_EVENT_LIMIT + 5) })).toHaveLength(REMOTE_EVENT_LIMIT);

  const m = openModalFake(() => ({ ...ON, events: events(3) }));
  m.switchTo("events");
  expect(m.text("events")).toContain("line 2");
});

test("modal: o asks the host to toggle; closing releases the key handler", () => {
  let toggles = 0;
  const m = openModalFake(() => OFF, () => (toggles += 1));
  m.press("o");
  m.press("down");
  expect(toggles).toBe(1);
  expect(m.released()).toBe(false);
  m.close();
  expect(m.released()).toBe(true);
});

test("modal status repaints with the new status after o", () => {
  let status: RemoteStatus = OFF;
  const m = openModalFake(
    () => status,
    () => {
      status = ON;
    },
  );
  expect(m.text("status")).toContain("Remote control: off");
  m.press("o");
  expect(m.text("status")).toContain("Remote control: on");
});

// ---- slash command, readline, menu --------------------------------------------

test("slash command parsing: status by default, off, on, and a topic name; never starts without a word", () => {
  expect(isRemoteControlCommand("/remote-control")).toBe(true);
  expect(isRemoteControlCommand("  /remote-control off")).toBe(true);
  expect(isRemoteControlCommand("/remote-controls")).toBe(false);
  expect(isRemoteControlCommand("/reviews")).toBe(false);
  expect(parseRemoteControlArgs("/remote-control")).toEqual({ action: "status" });
  expect(parseRemoteControlArgs("/remote-control status")).toEqual({ action: "status" });
  expect(parseRemoteControlArgs("/remote-control OFF")).toEqual({ action: "off" });
  expect(parseRemoteControlArgs("/remote-control on")).toEqual({ action: "on" });
  expect(parseRemoteControlArgs("/remote-control my-topic")).toEqual({ action: "on", name: "my-topic" });
  expect(parseRemoteControlArgs("/remote-control a b")).toEqual({ action: "invalid", message: REMOTE_CONTROL_USAGE });
});

test("slash command text: the status block, then the recent events, ending with a newline", () => {
  const text = renderRemoteControlText({ ...ON, events: events(2) });
  expect(text).toContain("Remote control: on");
  expect(text).toContain("Topic: keryx-demo");
  expect(text).toContain("Recent events:");
  expect(text).toContain("line 1");
  expect(text.endsWith("\n")).toBe(true);
  expect(renderRemoteControlText(OFF)).toContain("No remote events yet.");
  expect(formatRemoteStatusLines(OFF)[0]).toBe("Remote control: off");
});

test("readline text: always off, says where it can be turned on, and rejects bad input with usage", () => {
  const status = readlineRemoteControlText("/remote-control");
  expect(status).toContain("Remote control: off");
  expect(readlineRemoteControlText("/remote-control off")).toContain("Remote control: off");
  const on = readlineRemoteControlText("/remote-control my-topic");
  expect(on).toContain("full-screen shell");
  expect(on).toContain("Remote control: off");
  expect(readlineRemoteControlText("/remote-control a b c")).toBe(`${REMOTE_CONTROL_USAGE}\n`);
});

test("age formatting reads shortest", () => {
  expect([formatAge(0), formatAge(12_000), formatAge(59_400), formatAge(90_000), formatAge(2 * 3_600_000)]).toEqual(["0s", "12s", "59s", "2m", "2h"]);
  expect(formatAge(-5)).toBe("0s");
});

test("the command is registered for the agent shell, not chat, and a busy turn still runs it", () => {
  const agent = commandsForMode("agent").find((c) => c.name === REMOTE_CONTROL_COMMAND);
  expect(agent).toBeDefined();
  expect(agent?.description).toContain("Off by default");
  expect(commandsForMode("chat").some((c) => c.name === REMOTE_CONTROL_COMMAND)).toBe(false);
  const target = classifyBusyDispatch({
    line: "/remote-control off",
    commandName: "/remote-control",
    isSessionInfo: false,
    isFlows: false,
    isWorkspace: false,
    isReview: false,
    isMcp: false,
    isMcpConsumer: false,
  });
  expect(target).toBe("remote-control");
  expect(HELP_GROUPS.some((e) => e.kind === "slash" && e.name === REMOTE_CONTROL_COMMAND)).toBe(true);
});

otuiTest("menu: typing the slash menu lists /remote-control", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  try {
    expect(h.chrome.menu.options.some((o) => o.name === REMOTE_CONTROL_COMMAND)).toBe(true);
  } finally {
    h.destroy();
  }
});

// ---- tg label ---------------------------------------------------------------

test("a Telegram line is labelled tg in the queue text and the echo marker", () => {
  expect(TG_LABEL).toBe("tg");
  expect(TG_SOURCE).toBe("tg");
  expect(labelTelegramLine("fix the build")).toBe("[tg] fix the build");
  expect(TG_ECHO_MARKER).toBe("tg ❯");
});

otuiTest("transcript: a Telegram line is echoed with the tg marker; a typed line keeps the arrow", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  try {
    appendUserEcho(otui.core, h.renderer, h.chrome.transcript, { id: "ue-tg", line: "fix the build", marker: TG_ECHO_MARKER });
    appendUserEcho(otui.core, h.renderer, h.chrome.transcript, { id: "ue-typed", line: "hello" });
    await settle(h);
    expect(textOf(findById(h.chrome.transcript, "ue-tg-t"))).toBe("tg ❯ fix the build");
    expect(textOf(findById(h.chrome.transcript, "ue-typed-t"))).toBe("❯ hello");
  } finally {
    h.destroy();
  }
});

// ---- Flow 387, AC13: recent remote commands --------------------------------------

function at(second: number, kind: RemoteEvent["kind"], text: string): RemoteEvent {
  return { at: Date.UTC(2026, 9, 2, 10, 0, second), kind, text };
}

const COMMAND_EVENTS: RemoteEvent[] = [
  at(1, "line", "Telegram: fix the build"),
  at(2, "command", "/model"),
  at(3, "command", "/model switched"),
  at(4, "command", "refused /mcp: Not available remotely. Run it in the shell."),
  at(5, "command", "/mode waiting for a press in the topic"),
  at(6, "status", "heartbeat ok"),
];

test("commands tab: only remote commands, newest first, with the time", () => {
  const lines = formatRemoteCommandLines({ ...ON, events: COMMAND_EVENTS });
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe("10:00:05  /mode waiting for a press in the topic");
  expect(lines.at(-1)).toBe("10:00:02  /model");
  expect(lines.join("\n")).not.toContain("fix the build");
  expect(lines.join("\n")).not.toContain("heartbeat");
});

test("commands tab: a refused command is listed with the reason", () => {
  const lines = formatRemoteCommandLines({ ...ON, events: COMMAND_EVENTS });
  expect(lines.some((line) => line.includes("refused /mcp") && line.includes("Not available remotely"))).toBe(true);
});

test("commands tab: a confirmation still waiting for a press is listed", () => {
  const lines = formatRemoteCommandLines({ ...ON, events: COMMAND_EVENTS });
  expect(lines.some((line) => line.includes("/mode waiting for a press in the topic"))).toBe(true);
});

test("commands tab: an empty note, and at most the ring size", () => {
  expect(formatRemoteCommandLines(ON)).toEqual(["No remote commands yet."]);
  const many = Array.from({ length: REMOTE_EVENT_LIMIT + 5 }, (_, i) => at(i % 60, "command", `/cmd${i}`));
  expect(formatRemoteCommandLines({ ...ON, events: many })).toHaveLength(REMOTE_EVENT_LIMIT);
});

test("modal commands tab: paints the recent remote commands and follows the live status", () => {
  let status: RemoteStatus = { ...ON, events: [] };
  const m = openModalFake(() => status);
  m.switchTo("commands");
  expect(m.text("commands")).toBe("No remote commands yet.");
  status = { ...ON, events: COMMAND_EVENTS };
  m.switchTo("commands");
  expect(m.text("commands")).toContain("refused /mcp");
  expect(m.text("commands")).toContain("/mode waiting for a press in the topic");
  expect(m.text("commands")).not.toContain("fix the build");
});

test("the transcript echo of a slash command carries the tg label only when it came from the topic", () => {
  expect(commandEchoText("/model", TG_SOURCE)).toBe("tg ❯ /model");
  expect(commandEchoText("/model")).toBe("❯ /model");
  expect(commandEchoText("/model", undefined)).toBe("❯ /model");
});

// Flow 397 (AC5): a decision serve has not confirmed is visible in the status block and in the sidebar row, and is gone when it clears.
test("AC5: the status block and the sidebar row show the unconfirmed-approvals count, and drop it at zero", () => {
  const base: RemoteStatus = { state: "on", name: "release", heartbeatAgeMs: 1000, events: [] };
  expect(formatRemoteStatusLines(base).join("\n")).not.toContain("not confirmed");
  expect(projectRemoteRow(base, 40)).toMatchObject({ text: "release", role: "ok" });

  const pending: RemoteStatus = { ...base, unconfirmedApprovals: 2 };
  expect(formatRemoteStatusLines(pending).join("\n")).toContain("Approvals not confirmed: 2");
  expect(projectRemoteRow(pending, 40)).toMatchObject({ text: "release · 2 unconfirmed", role: "attention" });
  expect(projectRemoteRow(pending, 12).text.length).toBeLessThanOrEqual(12);

  // Off says nothing about approvals, whatever a stale count was.
  expect(formatRemoteStatusLines({ state: "off", unconfirmedApprovals: 3, events: [] }).join("\n")).not.toContain("not confirmed");
  expect(projectRemoteRow({ state: "off", unconfirmedApprovals: 3, events: [] }, 40).text).toBe("off");
});

// ---- history (flow 399) -----------------------------------------------------------

// The surface prints event times in UTC (`clock`), so the fixture is a UTC instant: built in local
// time it reads 17:52 under TZ=Pacific/Auckland and the tests below fail on an unchanged tree.
const POSTED_AT = Date.UTC(2026, 9, 3, 6, 52, 11);

test("history status line: not posted yet, then how many and when, and how it got there", () => {
  expect(formatHistoryStatus(ON)).toContain("not posted yet");
  expect(formatHistoryStatus(ON)).toContain("/history");
  const manual = formatHistoryStatus({ ...ON, history: { at: POSTED_AT, count: 5, auto: false } });
  expect(manual).toContain("5 messages posted at 06:52:11");
  expect(manual).toContain("(/history)");
  const auto = formatHistoryStatus({ ...ON, history: { at: POSTED_AT, count: 1, auto: true } });
  expect(auto).toContain("1 message posted");
  expect(auto).toContain("restored automatically");
  expect(formatRemoteStatusLines(ON).some((line) => line.startsWith("History:"))).toBe(true);
  expect(formatRemoteStatusLines(OFF).some((line) => line.startsWith("History:"))).toBe(false);
});

test("sidebar row: the detail line appears once history was posted, and never before", () => {
  expect(projectRemoteRow(ON, SIDEBAR_TEXT_WIDTH).detail).toBeUndefined();
  const row = projectRemoteRow({ ...ON, history: { at: POSTED_AT, count: 10, auto: true } }, SIDEBAR_TEXT_WIDTH);
  expect(row.detail).toBe("history 10 · 06:52");
  expect((row.detail ?? "").length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
});

otuiTest("sidebar: the history line follows refresh()", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let status: RemoteStatus = ON;
  const panel = mountRemotePanel(otui.core, h.renderer, h.chrome.sidebarTop, { width: SIDEBAR_TEXT_WIDTH, getStatus: () => status, onOpen: () => {} });
  try {
    expect(textOf(findById(h.chrome.sidebarTop, "sb-remote-h"))).toBe("");
    status = { ...ON, history: { at: POSTED_AT, count: 10, auto: false } };
    panel.refresh();
    expect(textOf(findById(h.chrome.sidebarTop, "sb-remote-h"))).toContain("history 10");
  } finally {
    panel.dispose();
    h.destroy();
  }
});

test("modal: h asks the host to post the history, and the status repaints", () => {
  let status: RemoteStatus = ON;
  let posts = 0;
  const m = openModalFake(
    () => status,
    () => {},
    {
      onHistory: () => {
        posts += 1;
        status = { ...ON, history: { at: POSTED_AT, count: 10, auto: false } };
      },
    },
  );
  expect(m.text("status")).toContain("not posted yet");
  m.press("h");
  expect(posts).toBe(1);
  expect(m.text("status")).toContain("10 messages posted");
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("modal: h while the posts run says so at once, ignores a second press, and repaints when they finish", async () => {
  let status: RemoteStatus = ON;
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  const m = openModalFake(
    () => status,
    () => {},
    {
      onHistory: async () => {
        posts += 1;
        await done;
        status = { ...ON, history: { at: POSTED_AT, count: 10, auto: false } };
        return undefined;
      },
    },
  );
  expect(m.text("status")).toContain("not posted yet");
  m.press("h");
  // Not finished: the line says it is working, and the History line is still the old one.
  expect(m.text("status")).toContain(HISTORY_POSTING_NOTE);
  expect(m.text("status")).toContain("not posted yet");
  m.press("h");
  expect(posts).toBe(1);
  release();
  await tick();
  await tick();
  // Finished: the note is gone and the History line shows the result, without another key.
  expect(m.text("status")).not.toContain(HISTORY_POSTING_NOTE);
  expect(m.text("status")).toContain("10 messages posted");
  // And it can be pressed again.
  m.press("h");
  expect(posts).toBe(2);
});

test("modal: the answer to h (remote control off, an empty history) is shown in the modal itself", async () => {
  const off = "Remote control is off, so there is no topic to post to. Turn it on with /remote-control <name>.";
  const m = openModalFake(
    () => OFF,
    () => {},
    { onHistory: async () => off },
  );
  m.press("h");
  await tick();
  await tick();
  expect(m.text("status")).toContain("Remote control is off, so there is no topic to post to");
  const empty = openModalFake(
    () => ON,
    () => {},
    { onHistory: async () => "There is no history to post yet: this session has no messages." },
  );
  empty.press("h");
  await tick();
  await tick();
  expect(empty.text("status")).toContain("There is no history to post yet");
  // The note sits under the History line of an "on" status.
  const lines = empty.text("status").split("\n");
  const at = lines.findIndex((line) => line.startsWith("History:"));
  expect(lines[at + 1] ?? "").toContain("There is no history to post yet");
});

test("modal: a post that finishes after the modal closed repaints nothing", async () => {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const m = openModalFake(
    () => ON,
    () => {},
    {
      onHistory: async () => {
        await done;
        return "late answer";
      },
    },
  );
  m.press("h");
  m.close();
  release();
  await tick();
  await tick();
  expect(m.text("status")).not.toContain("late answer");
});

// Flow 399 AC15: the transcript says so on every restore. The line is the bridge's own notice,
// written by the shell's own transcript IO into a real chrome, and read back from the rendered frame.
otuiTest("transcript: an automatic and a manual restore each leave a notice line in the rendered transcript", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { width: 140, height: 30 });
  try {
    const io = createTuiAgentIo(otui.core, h.renderer, h.chrome.transcript);
    const conversation: NormalizedMessage[] = [];
    for (let n = 1; n <= 6; n += 1) {
      conversation.push({ role: "user", content: `q${n}`, provenance: "trusted" }, { role: "assistant", content: `a${n}` });
    }
    const fakeClient = (): RemoteClientLike =>
      ({
        connected: true,
        name: "keryx-demo",
        runTimeoutMs: 0,
        lastHeartbeatAt: undefined,
        start: async () => ({ ok: true, name: "keryx-demo", threadId: 7, runTimeoutMs: 0, reused: false }),
        close: async () => undefined,
        reply: async () => true,
        requestApproval: async () => "deny" as const,
        requestChoice: async () => undefined,
      }) as unknown as RemoteClientLike;
    const host: RemoteBridgeHost = {
      sessionId: () => "sess-tui-1",
      project: () => "/proj",
      isBusy: () => false,
      runLine: () => undefined,
      enqueue: () => undefined,
      // The same wiring the shell uses for the bridge's notices.
      notice: (text) => io.onSystem?.(`${text}\n`),
      cancelTurn: () => undefined,
      recordOn: () => undefined,
      recordOff: () => undefined,
      history: () => conversation,
      sessionResumed: () => true,
    };
    const bridge = new RemoteBridge({ host, makeClient: fakeClient, historyPaceMs: 0 });
    await bridge.enable("keryx-demo");
    for (let i = 0; i < 100 && bridge.status().history === undefined; i += 1) await tick();
    await settle(h);
    expect(h.captureCharFrame()).toContain("history restored to the topic: 10 messages (this session was resumed).");

    expect(await bridge.historyForCommand("3")).toBeUndefined();
    await settle(h);
    expect(h.captureCharFrame()).toContain("history posted to the topic: 3 messages.");
  } finally {
    h.destroy();
  }
});

test("/history: recognised by name only, runs while a turn runs, listed for the agent shell", () => {
  expect(HISTORY_COMMAND).toBe("/history");
  expect(isHistoryCommand("/history")).toBe(true);
  expect(isHistoryCommand("  /history 5")).toBe(true);
  expect(isHistoryCommand("/historyx")).toBe(false);
  expect(isHistoryCommand("/help")).toBe(false);
  expect(commandsForMode("agent").some((c) => c.name === "/history")).toBe(true);
  const target = classifyBusyDispatch({
    line: "/history 5",
    commandName: "/history",
    isSessionInfo: false,
    isFlows: false,
    isWorkspace: false,
    isReview: false,
    isMcp: false,
    isMcpConsumer: false,
  });
  expect(target).toBe("history");
});

test("readline /history: always off here, says where it works, and rejects a bad number with usage", () => {
  expect(readlineHistoryText("/history")).toContain("full-screen shell");
  expect(readlineHistoryText("/history 5")).toContain("full-screen shell");
  expect(readlineHistoryText("/history lots")).toContain("Usage: /history");
});
