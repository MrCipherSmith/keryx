// Flow 403 (AC19): the intake on the TUI surfaces. The status source and the decision door are fakes,
// so no test touches GitHub, Telegram or the intake store.
import { expect, test } from "bun:test";
import type { IntakeDecideOptions, IntakeDecideResult } from "../intake/actions";
import type { IntakeAction, IntakeCardSummary, IntakePollResult, IntakeStatus } from "../intake/types";
import {
  INTAKE_TABS,
  formatIntakeTab,
  intakeActionsFor,
  intakeListText,
  intakeStatusText,
  isIntakeCommand,
  mountIntakeSidebar,
  parseIntakeArgs,
  projectIntakePanel,
  readlineIntakeText,
  routeIntakeCommand,
  runIntakeText,
} from "./intake-surface";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { findById, keypressSource, loadOpenTui, manualInterval, mountChrome, settle, textOf, clickNode } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function card(id: string, overrides: Partial<IntakeCardSummary> = {}): IntakeCardSummary {
  return {
    id,
    kind: "issue",
    repo: "acme/api",
    title: `Issue ${id}`,
    state: "sent",
    actions: ["take", "decline", "later"],
    createdAt: "2026-10-04T10:00:00.000Z",
    ...overrides,
  };
}

/** A tiny stand-in for the store: the status is derived from it the way `buildIntakeStatus` derives it. */
class World {
  cards: IntakeCardSummary[];
  paused = false;
  enabled = true;
  configured = true;
  statusReads = 0;
  decisions: Array<{ root: string; id: string; action: IntakeAction; options: IntakeDecideOptions }> = [];
  pauseCalls: boolean[] = [];
  constructor(cards: IntakeCardSummary[]) {
    this.cards = cards;
  }
  status = async (): Promise<IntakeStatus> => {
    this.statusReads += 1;
    return this.snapshot();
  };
  snapshot(): IntakeStatus {
    const waiting = this.cards.filter((c) => c.state === "sent" || c.state === "failed");
    const deferred = this.cards.filter((c) => c.state === "decided" && c.choice === "later");
    const decided = this.cards.filter((c) => (c.state === "decided" && c.choice !== "later") || c.state === "taken");
    const line = !this.configured
      ? "Intake: не настроен"
      : !this.enabled
      ? "Intake: выкл"
      : this.paused
        ? `Intake: ${waiting.length} ждут | пауза`
        : `Intake: ${waiting.length} ждут | следующий опрос 12:05`;
    return {
      configured: this.configured,
      ...(this.configured ? {} : { disabledReason: "intake не настроен в этом проекте: создайте .metaproject/data/intake/config.json" }),
      problems: [],
      enabled: this.enabled,
      paused: this.paused,
      waiting: waiting.length,
      queued: 0,
      deferred: deferred.length,
      decided: decided.length,
      lastPollAt: "2026-10-04T12:00:00.000Z",
      nextPollAt: "2026-10-04T12:05:00.000Z",
      quiet: false,
      repos: ["acme/api"],
      ghAccount: "personal",
      line,
      tabs: {
        waiting,
        decided,
        deferred,
        events: [{ at: "2026-10-04T11:59:00.000Z", key: "issue:acme/api#7", kind: "issue", cardId: "c1" }],
      },
    };
  }
  decide = async (root: string, id: string, action: IntakeAction, options: IntakeDecideOptions): Promise<IntakeDecideResult> => {
    this.decisions.push({ root, id, action, options });
    const hit = this.cards.find((c) => c.id === id);
    if (hit === undefined || (hit.state !== "sent" && hit.state !== "failed")) return { ok: false, message: "Карточка уже решена." };
    this.cards = this.cards.map((c) =>
      c.id === id
        ? { ...c, state: "decided", choice: action, decidedBy: options.decidedBy, decidedAt: "2026-10-04T12:01:00.000Z" }
        : c,
    );
    return { ok: true, message: `Готово: ${action}` };
  };
  /** Another surface decided the card: the Telegram button, say. */
  decideElsewhere(id: string, action: IntakeAction): void {
    this.cards = this.cards.map((c) => (c.id === id ? { ...c, state: "decided", choice: action, decidedBy: "12345" } : c));
  }
  setPaused = async (paused: boolean): Promise<void> => {
    this.pauseCalls.push(paused);
    this.paused = paused;
  };
  polls = 0;
  poll = async (): Promise<IntakePollResult> => {
    this.polls += 1;
    return { runId: "r1", outcome: "ok", detail: "найдено 1 событие", baseline: false, newEvents: 1, cardIds: [], sent: 1, collapsed: 0, held: 0, failures: [], notes: [], costUsd: 0 };
  };
}

function mount(h: Awaited<ReturnType<typeof mountChrome>>, world: World, notices: string[] = []) {
  const timer = manualInterval();
  const sidebar = mountIntakeSidebar({
    otui: OTUI!.core,
    chrome: h.chrome,
    parent: h.chrome.sidebarTop,
    width: SIDEBAR_TEXT_WIDTH,
    root: "/proj",
    onKeypress: keypressSource(h.renderer),
    notice: (text) => notices.push(text),
    status: world.status,
    decide: world.decide,
    setPaused: world.setPaused,
    poll: world.poll,
    interval: timer.interval,
  });
  return { sidebar, timer };
}

const modalText = (sidebar: ReturnType<typeof mount>["sidebar"]): string => sidebar.openModal()?.visibleLines().join("\n") ?? "";

test("the command: only /intake, and its arguments", () => {
  expect(isIntakeCommand("/intake")).toBe(true);
  expect(isIntakeCommand("  /intake list")).toBe(true);
  expect(isIntakeCommand("/intakes")).toBe(false);
  expect(isIntakeCommand("intake")).toBe(false);
  expect(parseIntakeArgs("/intake")).toEqual({ action: "open" });
  for (const sub of ["status", "list", "pause", "resume", "poll"] as const) expect(parseIntakeArgs(`/intake ${sub}`)).toEqual({ action: sub });
  expect(parseIntakeArgs("/intake nonsense").action).toBe("invalid");
  expect(parseIntakeArgs("/intake pause now").action).toBe("invalid");
});

test("routeIntakeCommand: idle and busy reach the handler; other lines do not", () => {
  const taken: string[] = [];
  const fake = { handleCommand: (line: string) => (taken.push(line), true) };
  expect(routeIntakeCommand("/intake", fake)).toBe(true);
  expect(routeIntakeCommand("/intake pause", fake)).toBe(true);
  expect(routeIntakeCommand("/approvals", fake)).toBe(false);
  expect(taken).toEqual(["/intake", "/intake pause"]);
});

test("projectIntakePanel: the row is status.line; off, paused and waiting read differently", () => {
  const world = new World([card("c1"), card("c2")]);
  const on = projectIntakePanel(world.snapshot(), 200);
  expect(on.rows).toEqual(["Intake: 2 ждут | следующий опрос 12:05"]);
  expect(on.role).toBe("attention");
  world.paused = true;
  expect(projectIntakePanel(world.snapshot(), 200).rows).toEqual(["Intake: 2 ждут | пауза"]);
  world.enabled = false;
  const off = projectIntakePanel(world.snapshot(), 200);
  expect(off.rows).toEqual(["Intake: выкл"]);
  expect(off.role).toBe("muted");
  const narrow = projectIntakePanel(new World([card("c1")]).snapshot(), 14);
  for (const row of narrow.rows) expect(row.length).toBeLessThanOrEqual(14);
  expect(narrow.rows.join(" ")).toContain("Intake");
  expect(projectIntakePanel(undefined, 40).rows).toHaveLength(1);
});

test("L2: a project with no intake config shows no sidebar row at all", () => {
  const world = new World([]);
  world.configured = false;
  const panel = projectIntakePanel(world.snapshot(), 200);
  expect(panel.rows).toEqual([]);
  expect(panel.role).toBe("muted");
});

test("the tabs are Ждут, Решённые, Отложенные, События, and the keys map onto what a card offers", () => {
  expect(INTAKE_TABS.map((t) => t.label)).toEqual(["Ждут", "Решённые", "Отложенные", "События"]);
  expect(intakeActionsFor(card("a"))).toEqual({ t: "take", d: "decline", l: "later" });
  expect(intakeActionsFor(card("r", { kind: "review", actions: ["review-flow", "skip"] }))).toEqual({ t: "review-flow", d: "skip" });
  expect(intakeActionsFor(card("n", { kind: "comment", actions: ["understood"] }))).toEqual({ t: "understood" });
  const world = new World([card("c1")]);
  const status = world.snapshot();
  expect(formatIntakeTab(status, "waiting", 0).lines.join("\n")).toContain("Issue c1");
  expect(formatIntakeTab(status, "events", 0).lines.join("\n")).toContain("issue:acme/api#7");
  expect(formatIntakeTab(status, "decided", 0).lines.join("\n")).toContain("Решённых карточек пока нет.");
});

test("a title from GitHub cannot put control bytes on the terminal", () => {
  const text = intakeListText(new World([card("c1", { title: "bad\u001b[2Jtitle\u0007" })]).snapshot());
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\u0007");
  expect(text).toContain("title");
});

test("every text surface is cut from the one status object", async () => {
  const world = new World([card("c1"), card("c2", { state: "decided", choice: "later", remindAt: "2026-10-05T09:00:00.000Z" })]);
  const status = world.snapshot();
  expect(intakeStatusText(status).split("\n")[0]).toBe(status.line);
  const asked = await readlineIntakeText("/intake", { root: "/proj", status: world.status });
  expect(asked.split("\n")[0]).toBe(status.line);
  expect(asked).toContain("Issue c1");
  expect(asked).toContain("Отложенные (1)");
  const viaCommand = await runIntakeText({ action: "status" }, { root: "/proj", status: world.status });
  expect(viaCommand).toBe(intakeStatusText(status));
  expect(await readlineIntakeText("/intake list", { root: "/proj", status: world.status })).toBe(intakeListText(status));
});

test("/intake pause and resume go through setPaused and print the new line; poll runs one poll by hand; no store means no throw", async () => {
  const world = new World([card("c1")]);
  const deps = { root: "/proj", status: world.status, setPaused: world.setPaused, poll: world.poll };
  const paused = await runIntakeText({ action: "pause" }, deps);
  expect(world.pauseCalls).toEqual([true]);
  expect(paused).toContain("Intake: 1 ждут | пауза");
  const resumed = await runIntakeText({ action: "resume" }, deps);
  expect(world.pauseCalls).toEqual([true, false]);
  expect(resumed).toContain("следующий опрос");
  const polled = await runIntakeText({ action: "poll" }, deps);
  expect(world.polls).toBe(1);
  expect(polled).toContain("найдено 1 событие");
  const broken = await runIntakeText({ action: "status" }, {
    root: "/proj",
    status: async () => {
      throw new Error("store unreadable");
    },
  });
  expect(broken).toContain("store unreadable");
});

otuiTest("the sidebar row shows status.line, and follows pause and off", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([card("c1")]);
  const { sidebar, timer } = mount(h, world);
  try {
    await settle(h);
    expect(textOf(findById(h.chrome.sidebarTop, "sb-intake-row-0"))).toContain("Intake: 1 ждут");
    world.paused = true;
    await timer.fire();
    await settle(h);
    expect(sidebar.projection().rows.join(" ")).toContain("пауза");
    world.enabled = false;
    await timer.fire();
    await settle(h);
    expect(sidebar.projection().rows.join(" ")).toContain("выкл");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("L2: with no config the row is hidden and /intake says how to enable it instead of opening", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([]);
  world.configured = false;
  const notices: string[] = [];
  const { sidebar } = mount(h, world, notices);
  try {
    await settle(h);
    expect(sidebar.projection().rows).toEqual([]);
    await sidebar.show();
    expect(sidebar.openModal()).toBeUndefined();
    expect(notices.join("")).toContain("не настроен");
    expect(notices.join("")).toContain("config.json");
    expect(world.polls).toBe(0);
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("a new card shows in the row and in an open modal without a restart", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([]);
  const { sidebar, timer } = mount(h, world);
  try {
    await settle(h);
    expect(sidebar.projection().rows.join(" ")).toContain("0 ждут");
    await sidebar.show();
    expect(modalText(sidebar)).toContain("Нет карточек, которые ждут решения.");
    world.cards = [card("fresh", { title: "A brand new ticket" })];
    await timer.fire();
    await settle(h);
    expect(sidebar.projection().rows.join(" ")).toContain("1 ждут");
    expect(modalText(sidebar)).toContain("A brand new ticket");
    const paints = sidebar.paintCount();
    await timer.fire();
    expect(sidebar.paintCount()).toBe(paints);
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("/intake and a click on the row open the modal; list and the others print text; foreign lines are left alone", async () => {
  const h = await mountChrome(OTUI!);
  const notices: string[] = [];
  const world = new World([card("c1")]);
  const { sidebar } = mount(h, world, notices);
  try {
    await settle(h);
    expect(sidebar.handleCommand("/approvals")).toBe(false);
    expect(sidebar.openModal()).toBeUndefined();
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-intake-row-0"));
    await settle(h);
    expect(modalText(sidebar)).toContain("Issue c1");
    sidebar.openModal()?.close();
    expect(sidebar.handleCommand("/intake list")).toBe(true);
    await settle(h);
    expect(notices.join("\n")).toContain("Issue c1");
    expect(sidebar.handleCommand("/intake")).toBe(true);
    await settle(h);
    expect(sidebar.openModal()).toBeDefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("the tabs show what each holds, and one status object feeds the row, the modal and the text", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([
    card("w1", { title: "Waiting one" }),
    card("d1", { title: "Done one", state: "decided", choice: "decline", decidedBy: "tui" }),
    card("l1", { title: "Later one", state: "decided", choice: "later", remindAt: "2026-10-05T09:00:00.000Z" }),
  ]);
  const { sidebar } = mount(h, world);
  try {
    await sidebar.show();
    const status = world.snapshot();
    expect(sidebar.status()?.line).toBe(status.line);
    // the sidebar is narrow: the line is cut at its separators into rows, nothing else changes
    expect(sidebar.projection().rows.join(" | ")).toBe(status.line);
    expect(modalText(sidebar)).toContain(status.line);
    expect(modalText(sidebar)).toContain("Waiting one");
    expect(modalText(sidebar)).not.toContain("Done one");
    await h.mockInput.pressKey("2");
    await settle(h);
    expect(modalText(sidebar)).toContain("Done one");
    expect(modalText(sidebar)).toContain("tui");
    await h.mockInput.pressKey("3");
    await settle(h);
    expect(modalText(sidebar)).toContain("Later one");
    expect(modalText(sidebar)).toContain("2026-10-05");
    await h.mockInput.pressKey("4");
    await settle(h);
    expect(modalText(sidebar)).toContain("issue:acme/api#7");
    expect(intakeStatusText(status)).toContain(status.line);
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("t decides through the door with decidedBy tui, shows the message, and updates the row", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([card("c1")]);
  const { sidebar } = mount(h, world);
  try {
    await sidebar.show();
    await h.mockInput.pressKey("t");
    await settle(h);
    expect(world.decisions).toEqual([{ root: "/proj", id: "c1", action: "take", options: { decidedBy: "tui" } }]);
    expect(modalText(sidebar)).toContain("Готово: take");
    expect(sidebar.projection().rows.join(" ")).toContain("0 ждут");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("d declines, l defers, and a review card takes its own actions on t and d", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([
    card("a", { title: "first" }),
    card("b", { title: "second" }),
    card("r", { kind: "review", title: "a PR", actions: ["review-flow", "skip"] }),
  ]);
  const { sidebar } = mount(h, world);
  try {
    await sidebar.show();
    await h.mockInput.pressKey("d");
    await settle(h);
    await h.mockInput.pressKey("l");
    await settle(h);
    await h.mockInput.pressKey("t");
    await settle(h);
    expect(world.decisions.map((d) => [d.id, d.action, d.options.decidedBy])).toEqual([
      ["a", "decline", "tui"],
      ["b", "later", "tui"],
      ["r", "review-flow", "tui"],
    ]);
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("a card another surface already decided is not decided again", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([card("c1")]);
  const { sidebar } = mount(h, world);
  try {
    await sidebar.show();
    expect(modalText(sidebar)).toContain("Issue c1");
    // the Telegram button won the race, and the modal has not heard of it yet
    world.decideElsewhere("c1", "take");
    await h.mockInput.pressKey("d");
    await settle(h);
    expect(world.decisions).toEqual([]);
    expect(modalText(sidebar)).toContain("уже решена");
    expect(modalText(sidebar)).toContain("12345");
    expect(sidebar.projection().rows.join(" ")).toContain("0 ждут");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("the door's own refusal reaches the modal as it is", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([card("c1")]);
  // the status still lists the card as waiting, but the door says no: its message is the one shown
  world.decide = async (root, id, action, options) => {
    world.decisions.push({ root, id, action, options });
    return { ok: false, message: "Карточку уже взяли в Telegram." };
  };
  const { sidebar } = mount(h, world);
  try {
    await sidebar.show();
    await h.mockInput.pressKey("t");
    await settle(h);
    expect(world.decisions).toHaveLength(1);
    expect(modalText(sidebar)).toContain("Карточку уже взяли в Telegram.");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("p pauses and resumes, and the row follows at once", async () => {
  const h = await mountChrome(OTUI!);
  const world = new World([card("c1")]);
  const { sidebar } = mount(h, world);
  try {
    await sidebar.show();
    await h.mockInput.pressKey("p");
    await settle(h);
    expect(world.pauseCalls).toEqual([true]);
    expect(sidebar.projection().rows.join(" ")).toContain("пауза");
    await h.mockInput.pressKey("p");
    await settle(h);
    expect(world.pauseCalls).toEqual([true, false]);
    expect(sidebar.projection().rows.join(" ")).toContain("следующий опрос");
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});

otuiTest("keys on a tab that holds no decision do nothing, and esc closes the modal", async () => {
  const h = await mountChrome(OTUI!, { kittyKeyboard: true });
  const world = new World([card("c1", { state: "decided", choice: "decline", decidedBy: "tui" })]);
  const { sidebar } = mount(h, world);
  try {
    await sidebar.show();
    await h.mockInput.pressKey("2");
    await settle(h);
    await h.mockInput.pressKey("t");
    await settle(h);
    expect(world.decisions).toEqual([]);
    expect(modalText(sidebar)).toContain("Решать можно на вкладке");
    h.mockInput.pressEscape();
    await settle(h);
    expect(findById(h.chrome.sidebarTop, "intake-body")).toBeUndefined();
  } finally {
    sidebar.dispose();
    h.destroy();
  }
});
