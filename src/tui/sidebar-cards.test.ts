// Flow 468 phase C (sidebar) — the seven themed cards.
//
// RED until `src/tui/sidebar-cards.ts` exists (and, for the chrome tests, until
// `createShellChrome` takes the `sidebar` option pinned in sidebar-geometry.test.ts).
// Both modules are loaded with a runtime `import()` inside each test, so this file
// always loads and each test fails on its own for the right reason.
//
// API this file pins (T15/T16 implement it):
//   sidebar-cards.ts
//     SIDEBAR_CARD_IDS = ["session","workspace","work","reviews","ops","policy","remote"]
//     SIDEBAR_SECTION_IDS: every FORMER sidebar section, in sidebar order
//     SIDEBAR_SECTION_CARD: Record<sectionId, cardId>   (each section belongs to exactly one card)
//     buildSidebarCards(snapshot) -> SidebarCardModel[]  (pure, seven entries in order)
//       snapshot = { sections?: Partial<Record<sectionId, string>>,   // display text per former section
//                    approvalsPending?: number, hold?: string,
//                    updateAvailable?: string, reviewsNotReady?: number }
//       card = { id, order, icon, asciiIcon, title, severity: "normal"|"attention"|"error",
//                badge?: string, tabs: Tab[],
//                lines(textWidth, mode) -> string[],      // default|wide: 3..5 lines, each <= textWidth;
//                                                         //   lines[0] = `${icon} ${title}` + badge; rail: 1 line, <= 3 cells
//                rail() -> { glyph, badge? } }
//       tab  = { id /*= sectionId*/, label, command?: string, lines(width) -> string[] /*full value, wrapped*/ }
//     mountSidebarCards(otui, renderer, parent, { geometry, snapshot: () => snapshot,
//                                                 onOpenCard(cardId), asciiIcons? })
//       -> { refresh(), destroy() }; one slot Box `sb-card-<id>` per card, in order, never removed
//     openSidebarCard(otui, chrome, cardId, { snapshot: () => snapshot, initialTab?, runCommand?(command) })
//       -> ModalHandle | undefined; modal tab ids = the card's tab ids; Enter on a tab with a
//          `command` calls runCommand(command)
//
// Former sections (verified against the section mounts in tui-shell.ts, 4297-4650):
// the plan's table, plus `tools` (the "Tools: N available" row, which the plan does not
// place) under Policy, next to Guard/EditGuard — it describes what the agent may call.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { displayWidth } from "../lib/live-render";
import { createShellChrome, themeColorToHex, type ShellChrome, type ShellChromeOptions } from "./shell-chrome";
import { applyThemeId, getThemeId, resolveTheme, roleColor } from "./theme";

type Mode = "default" | "wide" | "rail";
type Severity = "normal" | "attention" | "error";
interface Tab {
  id: string;
  label: string;
  command?: string;
  lines(width: number): string[];
}
interface Card {
  id: string;
  order: number;
  icon: string;
  asciiIcon: string;
  title: string;
  severity: Severity;
  badge?: string;
  tabs: Tab[];
  lines(textWidth: number, mode: Mode): string[];
  rail(): { glyph: string; badge?: string };
}
interface Snapshot {
  sections?: Record<string, string>;
  approvalsPending?: number;
  hold?: string;
  updateAvailable?: string;
  reviewsNotReady?: number;
}
interface Geometry {
  state(): { mode: Mode; preferred: Mode; width: number };
  setMode(mode: Mode): void;
  resize(columns: number): void;
}
interface CardsModule {
  SIDEBAR_CARD_IDS: readonly string[];
  SIDEBAR_SECTION_IDS: readonly string[];
  SIDEBAR_SECTION_CARD: Record<string, string>;
  buildSidebarCards(snapshot: Snapshot): Card[];
  mountSidebarCards(
    otui: unknown,
    renderer: unknown,
    parent: unknown,
    opts: { geometry: Geometry; snapshot: () => Snapshot; onOpenCard: (cardId: string) => void; asciiIcons?: boolean },
  ): { refresh(): void; destroy(): void };
  openSidebarCard(
    otui: unknown,
    chrome: unknown,
    cardId: string,
    opts: { snapshot: () => Snapshot; initialTab?: string; runCommand?: (command: string) => void },
  ): { close(): void; activeTab(): string } | undefined;
}
interface GeometryModule {
  createSidebarGeometry(opts: { columns: number; configDir?: string; mode?: Mode }): Geometry;
  sidebarTextWidth(width: number): number;
}

// Variable specifiers keep `tsc` quiet while the modules do not exist yet.
const CARDS_MODULE = "./sidebar-cards";
const GEOMETRY_MODULE = "./sidebar-geometry";
async function loadCards(): Promise<CardsModule> {
  return (await import(CARDS_MODULE)) as CardsModule;
}
async function loadGeometry(): Promise<GeometryModule> {
  return (await import(GEOMETRY_MODULE)) as GeometryModule;
}

const MODES: readonly Mode[] = ["default", "wide", "rail"];
const DEFAULT_TEXT_WIDTH = 30; // 34 - border 1 - padding 3
const WIDE_TEXT_WIDTH = 64; // 68 - 4

/** Card id -> its former sections, in the order their tabs appear. */
const FORMER_SECTIONS: Record<string, readonly string[]> = {
  session: ["model", "mode", "usage", "context", "balance"],
  workspace: ["directory", "branch", "pr", "workspace"],
  work: ["status", "plan", "subagents", "jobs"],
  reviews: ["catchup", "findings", "autoreview", "external-diff"],
  ops: ["governance", "triggers", "schedules", "intake", "decisions", "research-sync"],
  policy: ["route", "guard", "edit-guard", "rewind", "project-ctx", "external", "tools"],
  remote: ["remote", "telegram", "approvals", "hold"],
};
const CARD_ORDER = ["session", "workspace", "work", "reviews", "ops", "policy", "remote"];
const CARD_TITLES = ["Session", "Workspace", "Work", "Reviews", "Ops", "Policy", "Remote"];
const ALL_SECTIONS = CARD_ORDER.flatMap((card) => [...(FORMER_SECTIONS[card] ?? [])]);

/** A distinctive multi-word value for a section, long enough to overflow 30 columns. */
function longValue(section: string): string {
  return `UNIQ-${section} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron`;
}

function fullSnapshot(): Snapshot {
  const sections: Record<string, string> = {};
  for (const section of ALL_SECTIONS) sections[section] = longValue(section);
  return { sections, approvalsPending: 2, hold: "held by peer-a until 12:04", updateAvailable: "0.3.200", reviewsNotReady: 3 };
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cardOf(cards: readonly Card[], id: string): Card {
  const card = cards.find((entry) => entry.id === id);
  if (card === undefined) throw new Error(`no card ${id}`);
  return card;
}

// ---------------------------------------------------------------------------
// AC12 — seven cards, 3..5 lines, nothing lost
// ---------------------------------------------------------------------------

test("flow 468 AC12: the sidebar has seven cards in the fixed order Session, Workspace, Work, Reviews, Ops, Policy, Remote", async () => {
  const c = await loadCards();
  expect([...c.SIDEBAR_CARD_IDS]).toEqual(CARD_ORDER);
  const cards = c.buildSidebarCards({});
  expect(cards.map((card) => card.id)).toEqual(CARD_ORDER);
  expect(cards.map((card) => card.title)).toEqual(CARD_TITLES);
  expect(cards.map((card) => card.order)).toEqual([...cards.map((card) => card.order)].sort((a, b) => a - b));
  expect(new Set(cards.map((card) => card.order)).size).toBe(7);
});

test("flow 468 AC12: at default width every card is 3 to 5 lines, pre-fit to the text width, empty or overflowing", async () => {
  const c = await loadCards();
  for (const [name, snapshot] of [["empty", {}], ["full", fullSnapshot()]] as const) {
    for (const card of c.buildSidebarCards(snapshot)) {
      const lines = card.lines(DEFAULT_TEXT_WIDTH, "default");
      expect(lines.length, `${name} ${card.id}`).toBeGreaterThanOrEqual(3);
      expect(lines.length, `${name} ${card.id}`).toBeLessThanOrEqual(5);
      for (const line of lines) {
        expect(displayWidth(line), `${name} ${card.id}: "${line}"`).toBeLessThanOrEqual(DEFAULT_TEXT_WIDTH);
        expect(line).not.toContain("\n");
      }
      expect(lines[0]).toContain(card.title);
      expect(lines[0]?.startsWith(card.icon)).toBe(true);
    }
  }
});

test("flow 468 AC12: wide mode keeps 3 to 5 lines and uses the extra columns instead of truncating", async () => {
  const c = await loadCards();
  const modelValue = "anthropic/claude-with-a-long-name-for-testing-0042";
  expect(displayWidth(modelValue)).toBeLessThanOrEqual(WIDE_TEXT_WIDTH - 12);
  expect(displayWidth(modelValue)).toBeGreaterThan(DEFAULT_TEXT_WIDTH);
  const cards = c.buildSidebarCards({ ...fullSnapshot(), sections: { ...fullSnapshot().sections, model: modelValue } });
  for (const card of cards) {
    const lines = card.lines(WIDE_TEXT_WIDTH, "wide");
    expect(lines.length, card.id).toBeGreaterThanOrEqual(3);
    expect(lines.length, card.id).toBeLessThanOrEqual(5);
    for (const line of lines) expect(displayWidth(line), card.id).toBeLessThanOrEqual(WIDE_TEXT_WIDTH);
  }
  const session = cardOf(cards, "session");
  expect(session.lines(WIDE_TEXT_WIDTH, "wide").join("\n")).toContain(modelValue);
  expect(session.lines(DEFAULT_TEXT_WIDTH, "default").join("\n")).not.toContain(modelValue); // truncated, not wrapped past 5 lines
});

test("flow 468 AC12: the default-mode card shows the headline value of its first sections (Session the model, Work the status)", async () => {
  const c = await loadCards();
  const cards = c.buildSidebarCards({ sections: { model: "anthropic/sonnet", status: "Ready" } });
  expect(cardOf(cards, "session").lines(DEFAULT_TEXT_WIDTH, "default").join("\n")).toContain("anthropic/sonnet");
  expect(cardOf(cards, "work").lines(DEFAULT_TEXT_WIDTH, "default").join("\n")).toContain("Ready");
});

test("flow 468 AC12: rail mode is one row per card: a single-cell glyph, an optional short badge, and nothing wider than 3 cells", async () => {
  const c = await loadCards();
  for (const card of c.buildSidebarCards(fullSnapshot())) {
    const rail = card.rail();
    expect(displayWidth(rail.glyph), card.id).toBe(1);
    if (rail.badge !== undefined) expect(displayWidth(rail.badge), card.id).toBeLessThanOrEqual(2);
    const lines = card.lines(DEFAULT_TEXT_WIDTH, "rail");
    expect(lines, card.id).toHaveLength(1);
    expect(displayWidth(lines[0] ?? ""), card.id).toBeLessThanOrEqual(3);
    expect(lines[0]?.startsWith(rail.glyph), card.id).toBe(true);
  }
});

test("flow 468 AC12: card icons are single-cell and distinct, each with a distinct single-cell ASCII fallback", async () => {
  const c = await loadCards();
  const cards = c.buildSidebarCards({});
  for (const card of cards) {
    expect(displayWidth(card.icon), card.id).toBe(1);
    expect(card.asciiIcon, card.id).toMatch(/^[\x21-\x7e]$/);
  }
  expect(new Set(cards.map((card) => card.icon)).size).toBe(7);
  expect(new Set(cards.map((card) => card.asciiIcon)).size).toBe(7);
});

test("flow 468 AC12: every former section maps to exactly one card tab, and a section missing from the map fails here", async () => {
  const c = await loadCards();
  // The module's own list of former sections must equal the table above, nothing more or less:
  // adding a section to the sidebar without placing it on a card breaks this test.
  expect([...c.SIDEBAR_SECTION_IDS].sort()).toEqual([...ALL_SECTIONS].sort());
  expect(new Set(c.SIDEBAR_SECTION_IDS).size).toBe(c.SIDEBAR_SECTION_IDS.length);
  const unmapped = c.SIDEBAR_SECTION_IDS.filter((section) => c.SIDEBAR_SECTION_CARD[section] === undefined);
  expect(unmapped).toEqual([]);
  for (const [cardId, sections] of Object.entries(FORMER_SECTIONS)) {
    for (const section of sections) expect(c.SIDEBAR_SECTION_CARD[section], section).toBe(cardId);
  }
  // Tabs: one per former section, in the card's order, with a readable label.
  const cards = c.buildSidebarCards({});
  for (const card of cards) {
    expect(card.tabs.map((tab) => tab.id), card.id).toEqual([...(FORMER_SECTIONS[card.id] ?? [])]);
    for (const tab of card.tabs) expect(tab.label.trim().length, `${card.id}/${tab.id}`).toBeGreaterThan(0);
  }
  expect(cards.flatMap((card) => card.tabs).length).toBe(ALL_SECTIONS.length);
});

test("flow 468 AC12: every value a former section showed is reachable, in full, from its card's detail tab", async () => {
  const c = await loadCards();
  for (const section of ALL_SECTIONS) {
    const value = longValue(section);
    const card = cardOf(c.buildSidebarCards({ sections: { [section]: value } }), c.SIDEBAR_SECTION_CARD[section] ?? "");
    const tab = card.tabs.find((entry) => entry.id === section);
    expect(tab, section).toBeDefined();
    for (const width of [40, 100]) {
      const lines = tab?.lines(width) ?? [];
      for (const line of lines) expect(displayWidth(line), `${section} @${width}: "${line}"`).toBeLessThanOrEqual(width);
      expect(squash(lines.join(" ")), `${section} @${width}`).toContain(value);
    }
  }
});

test("flow 468 AC12: the attention signals are reachable too: the hold text, the pending count and the update version", async () => {
  const c = await loadCards();
  const cards = c.buildSidebarCards({ approvalsPending: 4, hold: "held by peer-a until 12:04", updateAvailable: "0.3.200", reviewsNotReady: 3 });
  const remote = cardOf(cards, "remote");
  expect(squash(remote.tabs.find((tab) => tab.id === "hold")?.lines(80).join(" ") ?? "")).toContain("held by peer-a until 12:04");
  expect(squash(remote.tabs.find((tab) => tab.id === "approvals")?.lines(80).join(" ") ?? "")).toContain("4");
  expect(squash(cardOf(cards, "session").tabs.flatMap((tab) => tab.lines(80)).join(" "))).toContain("0.3.200");
  expect(squash(cardOf(cards, "reviews").tabs.find((tab) => tab.id === "findings")?.lines(80).join(" ") ?? "")).toContain("3");
});

// ---------------------------------------------------------------------------
// AC13 — click opens the detail modal, Route reaches /routing, wide modal width
// ---------------------------------------------------------------------------

test("flow 468 AC13: the Policy card's Route tab reaches /routing and the Session card's Model tab reaches /model", async () => {
  const c = await loadCards();
  const cards = c.buildSidebarCards({});
  expect(cardOf(cards, "policy").tabs.find((tab) => tab.id === "route")?.command).toBe("/routing");
  expect(cardOf(cards, "session").tabs.find((tab) => tab.id === "model")?.command).toBe("/model");
});

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without @opentui/core");
  }
  return OTUI;
}

async function withTmpDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "keryx-sidebar-cards-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VERSION = "9.8.7";

async function mountChrome(
  otui: OtuiBundle,
  geo: Geometry,
  opts: { width?: number; height?: number } = {},
): Promise<TestSetup & { chrome: ShellChrome; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 140, height: opts.height ?? 40 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · chrome",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
    toastMs: 60_000,
    sidebar: { geometry: geo, version: VERSION },
  } as ShellChromeOptions);
  await setup.flush();
  return {
    ...setup,
    chrome,
    destroy: () => {
      chrome.destroy();
      setup.renderer.destroy();
    },
  };
}

type Positioned = { x: number; y: number; width: number; parent: Positioned | null; id: string };

function byId(h: TestSetup, id: string): Positioned {
  const node = h.renderer.root.findDescendantById(id) as unknown as Positioned | undefined;
  if (node === undefined) {
    throw new Error(`no renderable with id ${id}`);
  }
  return node;
}

/** The rendered rows, cut to the sidebar column. */
function sidebarRows(h: TestSetup): string[] {
  const x = byId(h, "sidebar").x;
  return h.captureCharFrame().split("\n").map((row) => row.slice(x));
}

/** Spans that start inside the sidebar column. */
function sidebarSpans(h: TestSetup): { text: string; fg: unknown; bg: unknown }[] {
  const x = byId(h, "sidebar").x;
  const out: { text: string; fg: unknown; bg: unknown }[] = [];
  for (const line of h.captureSpans().lines) {
    let col = 0;
    for (const span of line.spans) {
      if (col >= x) out.push({ text: span.text, fg: span.fg, bg: span.bg });
      col += span.width;
    }
  }
  return out;
}

async function mountCards(
  otui: OtuiBundle,
  h: Awaited<ReturnType<typeof mountChrome>>,
  geo: Geometry,
  snapshot: Snapshot,
  onOpenCard: (cardId: string) => void = () => {},
): Promise<{ refresh(): void; destroy(): void }> {
  const c = await loadCards();
  const host = c.mountSidebarCards(otui.core, h.renderer, h.chrome.sidebarTop, {
    geometry: geo,
    snapshot: () => snapshot,
    onOpenCard,
  });
  await h.flush();
  return host;
}

otuiTest("flow 468 AC13: clicking a card opens its detail, in default mode and in rail mode", async () => {
  const otui = requireOtui();
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    const opened: string[] = [];
    const host = await mountCards(otui, h, geo, {}, (cardId) => opened.push(cardId));
    try {
      for (const mode of ["default", "rail"] as const) {
        geo.setMode(mode);
        host.refresh();
        await h.flush();
        opened.length = 0;
        for (const id of CARD_ORDER) {
          const slot = byId(h, `sb-card-${id}`);
          await h.mockMouse.click(slot.x, slot.y);
          await h.flush();
        }
        expect(opened, mode).toEqual(CARD_ORDER);
      }
    } finally {
      host.destroy();
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC13: a card's detail modal has one tab per former section and starts on the requested tab", async () => {
  const otui = requireOtui();
  const g = await loadGeometry();
  const c = await loadCards();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    try {
      for (const [cardId, sections] of Object.entries(FORMER_SECTIONS)) {
        const handle = c.openSidebarCard(otui.core, h.chrome, cardId, { snapshot: () => ({}) });
        expect(handle, cardId).toBeDefined();
        await h.flush();
        expect(handle?.activeTab(), cardId).toBe(sections[0] ?? "");
        for (const section of sections) {
          expect(h.renderer.root.findDescendantById(`modal-tab-${section}`), `${cardId}/${section}`).toBeDefined();
        }
        handle?.close();
        await h.flush();
      }
      const policy = c.openSidebarCard(otui.core, h.chrome, "policy", { snapshot: () => ({}), initialTab: "route" });
      await h.flush();
      expect(policy?.activeTab()).toBe("route");
      policy?.close();
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC13: the Route tab shows /routing and Enter on it opens /routing", async () => {
  const otui = requireOtui();
  const g = await loadGeometry();
  const c = await loadCards();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    const ran: string[] = [];
    try {
      const handle = c.openSidebarCard(otui.core, h.chrome, "policy", {
        snapshot: () => ({ sections: { route: "routing on · 3 routed" } }),
        initialTab: "route",
        runCommand: (command) => ran.push(command),
      });
      await h.flush();
      const frame = h.captureCharFrame();
      expect(frame).toContain("routing on · 3 routed");
      expect(frame).toContain("/routing");
      h.mockInput.pressEnter();
      await h.flush();
      expect(ran).toEqual(["/routing"]);
      handle?.close();
    } finally {
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC13: the whole value of a section can be read in the detail modal", async () => {
  const otui = requireOtui();
  const g = await loadGeometry();
  const c = await loadCards();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    try {
      const value = "anthropic/claude-with-a-long-name-for-testing-0042 via gateway-eu-west-1";
      const handle = c.openSidebarCard(otui.core, h.chrome, "session", {
        snapshot: () => ({ sections: { model: value } }),
        initialTab: "model",
      });
      await h.flush();
      expect(squash(h.captureCharFrame())).toContain(value);
      handle?.close();
    } finally {
      h.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// AC12 (mounted) — one slot per card, fixed order, patched in place
// ---------------------------------------------------------------------------

otuiTest("flow 468 AC12: the host keeps one slot per card in fixed order and patches in place across mode switches", async () => {
  const otui = requireOtui();
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 140, configDir, mode: "default" });
    const h = await mountChrome(otui, geo);
    const host = await mountCards(otui, h, geo, fullSnapshot());
    try {
      const slots = (): Positioned[] => CARD_ORDER.map((id) => byId(h, `sb-card-${id}`));
      const before = slots();
      expect(before.map((slot) => slot.y)).toEqual([...before.map((slot) => slot.y)].sort((a, b) => a - b));
      for (const mode of ["wide", "rail", "default"] as const) {
        geo.setMode(mode);
        host.refresh();
        await h.flush();
        expect(slots().map((slot) => slot.id)).toEqual(before.map((slot) => slot.id));
        for (const [i, slot] of slots().entries()) expect(slot, `${mode} ${CARD_ORDER[i]}`).toBe(before[i]!); // same renderable, not rebuilt
      }
      expect(sidebarRows(h).join("\n")).toContain("Session");
    } finally {
      host.destroy();
      h.destroy();
    }
  });
});

otuiTest("flow 468 AC12: a wide sidebar shows a long value in full where the default sidebar truncates it", async () => {
  const otui = requireOtui();
  const g = await loadGeometry();
  await withTmpDir(async (configDir) => {
    const geo = g.createSidebarGeometry({ columns: 160, configDir, mode: "default" });
    const h = await mountChrome(otui, geo, { width: 160 });
    const model = "anthropic/claude-with-a-long-name-for-testing-0042";
    const host = await mountCards(otui, h, geo, { sections: { model } });
    try {
      expect(sidebarRows(h).join("\n")).not.toContain(model);
      geo.setMode("wide");
      host.refresh();
      await h.flush();
      expect(sidebarRows(h).join("\n")).toContain(model);
    } finally {
      host.destroy();
      h.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// AC17 — attention never hides; a theme switch recolours everything
// ---------------------------------------------------------------------------

const SIGNALS: readonly { name: string; snapshot: Snapshot; card: string; badge: string | undefined }[] = [
  { name: "a pending approval", snapshot: { approvalsPending: 2 }, card: "remote", badge: "2" },
  { name: "a hold", snapshot: { hold: "held by peer-a until 12:04" }, card: "remote", badge: undefined },
  { name: "an available version update", snapshot: { updateAvailable: "0.3.200" }, card: "session", badge: undefined },
  { name: "a not-ready review", snapshot: { reviewsNotReady: 3 }, card: "reviews", badge: "3" },
];

test("flow 468 AC17: with nothing pending every card is normal and carries no badge", async () => {
  const c = await loadCards();
  for (const card of c.buildSidebarCards({ sections: { model: "m", status: "Ready" } })) {
    expect(card.severity, card.id).toBe("normal");
    expect(card.badge, card.id).toBeUndefined();
    expect(card.rail().badge, card.id).toBeUndefined();
  }
});

test("flow 468 AC17: a pending approval, a hold, an update and a not-ready review each raise their own card and show a badge in all three modes", async () => {
  const c = await loadCards();
  for (const signal of SIGNALS) {
    const cards = c.buildSidebarCards(signal.snapshot);
    for (const card of cards) {
      if (card.id !== signal.card) {
        expect(card.severity, `${signal.name}: ${card.id} stays normal`).toBe("normal");
        expect(card.badge, `${signal.name}: ${card.id}`).toBeUndefined();
      }
    }
    const raised = cardOf(cards, signal.card);
    expect(raised.severity, signal.name).not.toBe("normal");
    expect(raised.badge, signal.name).toBeDefined();
    expect(displayWidth(raised.badge ?? ""), signal.name).toBeLessThanOrEqual(2);
    if (signal.badge !== undefined) expect(raised.badge, signal.name).toBe(signal.badge);
    for (const mode of MODES) {
      if (mode === "rail") {
        expect(raised.rail().badge, `${signal.name} rail`).toBe(raised.badge);
      } else {
        const width = mode === "wide" ? WIDE_TEXT_WIDTH : DEFAULT_TEXT_WIDTH;
        expect(raised.lines(width, mode)[0], `${signal.name} ${mode}`).toContain(raised.badge ?? "");
      }
    }
  }
});

test("flow 468 AC17: attention outranks normal when two signals land on the same card, and the pending count is the badge", async () => {
  const c = await loadCards();
  const remote = cardOf(c.buildSidebarCards({ approvalsPending: 5, hold: "held" }), "remote");
  expect(remote.severity).not.toBe("normal");
  expect(remote.badge).toBe("5");
});

otuiTest("flow 468 AC17: the badge and the raised colour are painted in all three modes without opening anything", async () => {
  const otui = requireOtui();
  const g = await loadGeometry();
  const c = await loadCards();
  const previous = getThemeId();
  try {
    applyThemeId("groknight");
    await withTmpDir(async (configDir) => {
      const geo = g.createSidebarGeometry({ columns: 160, configDir, mode: "default" });
      const h = await mountChrome(otui, geo, { width: 160 });
      const snapshot: Snapshot = { approvalsPending: 2 };
      const host = await mountCards(otui, h, geo, snapshot);
      try {
        const remote = cardOf(c.buildSidebarCards(snapshot), "remote");
        const attention = roleColor("attention").toLowerCase();
        for (const mode of MODES) {
          geo.setMode(mode);
          host.refresh();
          await h.flush();
          const rows = sidebarRows(h);
          const marker = mode === "rail" ? remote.rail().glyph : "Remote";
          const row = rows.find((entry) => entry.includes(marker) && entry.includes("2")) ?? "";
          expect(row, mode).not.toBe("");
          const painted = sidebarSpans(h).filter((span) => span.text.includes(marker) || span.text.includes("2"));
          expect(
            painted.some((span) => themeColorToHex(span.fg)?.toLowerCase() === attention),
            `${mode}: the card is drawn in the attention colour`,
          ).toBe(true);
        }
      } finally {
        host.destroy();
        h.destroy();
      }
    });
  } finally {
    applyThemeId(previous);
  }
});

function palette(id: "groknight" | "tokyonight"): Set<string> {
  const { name: _name, ...slots } = resolveTheme(id);
  return new Set(Object.values(slots).map((hex) => String(hex).toLowerCase()));
}

otuiTest("flow 468 AC17: a theme switch recolours the pinned header, every card and the rail glyphs", async () => {
  const otui = requireOtui();
  const g = await loadGeometry();
  const c = await loadCards();
  const previous = getThemeId();
  try {
    const night = palette("groknight");
    const tokyo = palette("tokyonight");
    const stale = [...night].filter((hex) => !tokyo.has(hex));
    expect(stale.length).toBeGreaterThan(0); // the two palettes really differ
    for (const mode of MODES) {
      applyThemeId("groknight");
      await withTmpDir(async (configDir) => {
        const geo = g.createSidebarGeometry({ columns: 160, configDir, mode });
        const h = await mountChrome(otui, geo, { width: 160 });
        const snapshot = fullSnapshot();
        const host = await mountCards(otui, h, geo, snapshot);
        try {
          const painted = (): { text: string; hexes: Set<string> } => {
            const spans = sidebarSpans(h);
            const hexes = new Set<string>();
            for (const span of spans) {
              for (const value of [span.fg, span.bg]) {
                const hex = themeColorToHex(value)?.toLowerCase();
                if (hex !== undefined) hexes.add(hex);
              }
            }
            return { text: spans.map((span) => span.text).join("\n"), hexes };
          };
          const before = painted();
          if (mode === "rail") {
            for (const card of c.buildSidebarCards(snapshot)) expect(before.text, `rail ${card.id}`).toContain(card.icon);
          } else {
            expect(before.text).toContain("keryx");
            for (const title of CARD_TITLES) expect(before.text, title).toContain(title);
          }
          expect([...before.hexes].some((hex) => night.has(hex)), `${mode}: painted from the groknight palette`).toBe(true);

          applyThemeId("tokyonight");
          await h.flush();
          const after = painted();
          const leftovers = stale.filter((hex) => after.hexes.has(hex));
          expect(leftovers, `${mode}: groknight-only colours left in the sidebar`).toEqual([]);
          expect([...after.hexes].some((hex) => tokyo.has(hex)), `${mode}: painted from the tokyonight palette`).toBe(true);
          expect([...after.hexes].sort()).not.toEqual([...before.hexes].sort());
        } finally {
          host.destroy();
          h.destroy();
        }
      });
    }
  } finally {
    applyThemeId(previous);
  }
});
