// The sidebar's seven cards (flow 468 phase C).
//
// The sidebar used to be a long column of ~30 labelled sections. It is now seven
// cards, always in the same order (Session, Workspace, Work, Reviews, Ops, Policy,
// Remote), each a 3 to 5 line summary. Clicking a card opens a detail modal with
// one tab per FORMER section, so nothing the old column showed is lost: the card is
// the glance, the tab is the whole value.
//
// Three layers, kept apart so each can be tested alone:
//   - `buildSidebarCards(snapshot)`: pure. A snapshot of display text per former
//     section plus the attention signals goes in, seven card models come out.
//   - `mountSidebarCards(...)`: seven fixed slots (`sb-card-<id>`) painted from the
//     models. A slot is never removed and re-created (a Text destroyed between a
//     mouse-down and its dispatch loses the click); the text inside is patched.
//   - `openSidebarCard(...)`: the detail modal, reusing `openModal`.
//
// OpenTUI stays a parameter (ADR-0005): it is referenced only through
// `typeof import(...)`, there is no top-level import of the optional package (the
// static guard in `src/capability/no-optional-imports` is a regex over file text).
import { displayWidth } from "../lib/live-render";
import { openModal, type ModalChrome } from "./modal-host";
import { sidebarTextWidth, type SidebarGeometryState, type SidebarMode } from "./sidebar-geometry";
import { getTheme, onThemeChange, roleColor } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";

type OpenTui = typeof import("@opentui/core");
type Renderer = ModalChrome["renderer"];

export type SidebarCardId = "session" | "workspace" | "work" | "reviews" | "ops" | "policy" | "remote";
export type SidebarCardSeverity = "normal" | "attention" | "error";

/** Columns a rail row has: border + one padding cell + three text cells (`SIDEBAR_RAIL_WIDTH` = 5). */
const RAIL_CELLS = 3;
/**
 * A card is its title row plus at most three value rows: seven cards of four lines and the gaps
 * between them still fit a 40-row terminal, and the first three stay on screen at 24.
 */
const MAX_VALUE_ROWS = 3;
const MIN_CARD_LINES = 3;
const NOTHING_TO_SHOW = "Nothing to show yet.";

/** What the card builders read. Every field is optional: an empty snapshot is a quiet sidebar. */
export interface SidebarSnapshot {
  /** Display text per former section; multi-line values keep their lines. */
  sections?: Partial<Record<string, string>> | undefined;
  /** Remote approvals waiting for an answer. */
  approvalsPending?: number | undefined;
  /** The pause-lease banner while a peer holds this instance. */
  hold?: string | undefined;
  /** The newer version, once the version check found one. */
  updateAvailable?: string | undefined;
  /** Managed reviews whose readiness verdict is NOT READY. */
  reviewsNotReady?: number | undefined;
}

export interface SidebarCardTab {
  /** The former section's id. */
  id: string;
  label: string;
  /** The slash command of the existing inspector this section opens (Enter on the tab). */
  command?: string;
  /** The section's whole value, wrapped to `width`. */
  lines(width: number): string[];
}

export interface SidebarCardModel {
  id: SidebarCardId;
  order: number;
  icon: string;
  asciiIcon: string;
  title: string;
  severity: SidebarCardSeverity;
  badge?: string;
  tabs: SidebarCardTab[];
  /** default|wide: 3 to 5 lines, each at most `textWidth` cells. rail: one line of at most 3 cells. */
  lines(textWidth: number, mode: SidebarMode): string[];
  rail(): { glyph: string; badge?: string };
}

interface SectionDef {
  id: string;
  label: string;
  command?: string;
}

interface RowDef {
  sections: readonly string[];
  /** A required row shows `fallback` when it has nothing, so an empty card still has its 3 lines. */
  required: boolean;
  fallback: string;
  /** A value to put before the sections' own (the Session card's pending update). */
  extra?: (snapshot: SidebarSnapshot) => string | undefined;
}

interface CardDef {
  id: SidebarCardId;
  title: string;
  icon: string;
  asciiIcon: string;
  sections: readonly SectionDef[];
  rows: readonly RowDef[];
}

// Icons are single-cell geometric shapes, none with an emoji presentation, each with a
// distinct printable ASCII fallback for terminals that cannot draw them.
const CARD_DEFS: readonly CardDef[] = [
  {
    id: "session",
    title: "Session",
    icon: "◉",
    asciiIcon: "S",
    sections: [
      { id: "model", label: "Model", command: "/model" },
      { id: "mode", label: "Mode", command: "/settings" },
      { id: "usage", label: "Usage" },
      { id: "context", label: "Context" },
      { id: "balance", label: "Balance" },
    ],
    rows: [
      { sections: ["model"], required: true, fallback: "no model" },
      { sections: ["mode", "usage"], required: true, fallback: "mode —" },
      {
        sections: ["context", "balance"],
        required: false,
        fallback: "",
        extra: (snapshot) => (snapshot.updateAvailable === undefined ? undefined : `update ${snapshot.updateAvailable}`),
      },
    ],
  },
  {
    id: "workspace",
    title: "Workspace",
    icon: "▣",
    asciiIcon: "W",
    sections: [
      { id: "directory", label: "Directory" },
      { id: "branch", label: "Branch" },
      { id: "pr", label: "PR" },
      { id: "workspace", label: "Workspace", command: "/workspace" },
    ],
    rows: [
      { sections: ["directory"], required: true, fallback: "no directory" },
      { sections: ["branch", "pr"], required: true, fallback: "no branch" },
      { sections: ["workspace"], required: false, fallback: "" },
    ],
  },
  {
    id: "work",
    title: "Work",
    icon: "▸",
    asciiIcon: "T",
    sections: [
      { id: "status", label: "Status" },
      { id: "plan", label: "Plan" },
      { id: "subagents", label: "Subagents" },
      { id: "jobs", label: "Jobs" },
    ],
    rows: [
      { sections: ["status"], required: true, fallback: "idle" },
      { sections: ["plan"], required: false, fallback: "" },
      { sections: ["subagents", "jobs"], required: true, fallback: "no workers" },
    ],
  },
  {
    id: "reviews",
    title: "Reviews",
    icon: "◈",
    asciiIcon: "R",
    sections: [
      { id: "catchup", label: "Review", command: "/review" },
      { id: "findings", label: "Findings", command: "/reviews" },
      { id: "autoreview", label: "Autoreview" },
      { id: "external-diff", label: "Ext diff", command: "/external-diff" },
    ],
    rows: [
      { sections: ["findings"], required: true, fallback: "no reviews yet" },
      { sections: ["catchup", "external-diff"], required: false, fallback: "" },
      { sections: ["autoreview"], required: true, fallback: "no autoreview" },
    ],
  },
  {
    id: "ops",
    title: "Ops",
    icon: "◧",
    asciiIcon: "O",
    sections: [
      { id: "governance", label: "Governance", command: "/governance" },
      { id: "triggers", label: "Triggers", command: "/triggers" },
      { id: "schedules", label: "Schedules", command: "/schedules" },
      { id: "intake", label: "Intake", command: "/intake status" },
      { id: "decisions", label: "Decisions", command: "/decisions" },
      { id: "research-sync", label: "Research" },
    ],
    rows: [
      { sections: ["governance"], required: true, fallback: "governance —" },
      { sections: ["triggers", "schedules"], required: true, fallback: "triggers —" },
      { sections: ["intake", "decisions", "research-sync"], required: false, fallback: "" },
    ],
  },
  {
    id: "policy",
    title: "Policy",
    icon: "◇",
    asciiIcon: "P",
    sections: [
      { id: "route", label: "Route", command: "/routing" },
      { id: "guard", label: "Guard", command: "/guard" },
      { id: "edit-guard", label: "EditGuard", command: "/editguard" },
      { id: "rewind", label: "Rewind", command: "/rewind" },
      { id: "project-ctx", label: "Project", command: "/projectctx" },
      { id: "external", label: "External", command: "/external" },
      { id: "tools", label: "Tools", command: "/integrate" },
    ],
    rows: [
      { sections: ["route"], required: true, fallback: "routing —" },
      { sections: ["guard", "edit-guard", "rewind"], required: true, fallback: "guards off" },
      { sections: ["external", "tools", "project-ctx"], required: false, fallback: "" },
    ],
  },
  {
    id: "remote",
    title: "Remote",
    icon: "◎",
    asciiIcon: "@",
    sections: [
      { id: "remote", label: "Remote", command: "/remote-control status" },
      { id: "telegram", label: "Telegram", command: "/channels status" },
      { id: "approvals", label: "Approvals", command: "/approvals" },
      { id: "hold", label: "Hold" },
    ],
    rows: [
      { sections: ["remote"], required: true, fallback: "remote off" },
      { sections: ["telegram"], required: true, fallback: "telegram —" },
      { sections: ["approvals", "hold"], required: false, fallback: "" },
    ],
  },
];

export const SIDEBAR_CARD_IDS: readonly SidebarCardId[] = CARD_DEFS.map((card) => card.id);

/** Every FORMER sidebar section, in sidebar order. A section absent here is a section no card shows. */
export const SIDEBAR_SECTION_IDS: readonly string[] = CARD_DEFS.flatMap((card) => card.sections.map((section) => section.id));

/** The card each former section belongs to. */
export const SIDEBAR_SECTION_CARD: Readonly<Record<string, SidebarCardId>> = Object.fromEntries(
  CARD_DEFS.flatMap((card) => card.sections.map((section): [string, SidebarCardId] => [section.id, card.id])),
);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Cut `text` to `width` cells, ending in an ellipsis when something was dropped. */
function fitCells(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  let out = "";
  for (const ch of text) {
    if (displayWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Wrap one paragraph at spaces, breaking a word longer than `width` by cells. */
function wrapParagraph(text: string, width: number): string[] {
  if (text.trim() === "") return [""];
  const lines: string[] = [];
  let line = "";
  const push = (): void => {
    if (line !== "") lines.push(line);
    line = "";
  };
  for (const word of text.split(/\s+/).filter((entry) => entry !== "")) {
    let rest = word;
    while (displayWidth(rest) > width) {
      push();
      let head = "";
      for (const ch of rest) {
        if (displayWidth(head + ch) > width) break;
        head += ch;
      }
      if (head === "") break;
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (rest === "") continue;
    if (line === "") line = rest;
    else if (displayWidth(`${line} ${rest}`) <= width) line = `${line} ${rest}`;
    else {
      push();
      line = rest;
    }
  }
  push();
  return lines;
}

/** Wrap every line of `text` to `width`; blank lines are kept as paragraph breaks. */
function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  return text.split("\n").flatMap((paragraph) => wrapParagraph(paragraph, w));
}

function firstLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  for (const line of value.split("\n")) {
    const text = line.replace(/\s+/g, " ").trim();
    if (text !== "") return text;
  }
  return undefined;
}

/** A count that fits a badge: two cells. */
function countBadge(count: number): string {
  return count > 99 ? "99" : String(count);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** One section's whole value: its own text plus the attention signal that belongs with it. */
function sectionText(snapshot: SidebarSnapshot, id: string): string | undefined {
  const own = snapshot.sections?.[id];
  const text = own === undefined || own.trim() === "" ? undefined : own;
  switch (id) {
    case "model": {
      const update = snapshot.updateAvailable === undefined ? undefined : `Update available: ${snapshot.updateAvailable}`;
      return text === undefined ? update : update === undefined ? text : `${text}\n${update}`;
    }
    case "findings": {
      const count = snapshot.reviewsNotReady ?? 0;
      const notReady = count > 0 ? `${count} review${count === 1 ? "" : "s"} not ready` : undefined;
      return text === undefined ? notReady : notReady === undefined ? text : `${text}\n${notReady}`;
    }
    case "approvals": {
      if (text !== undefined) return text;
      const count = snapshot.approvalsPending ?? 0;
      return count > 0 ? `${count} remote approval${count === 1 ? "" : "s"} pending` : undefined;
    }
    case "hold":
      return snapshot.hold !== undefined && snapshot.hold !== "" ? snapshot.hold : text;
    default:
      return text;
  }
}

function signalFor(def: CardDef, snapshot: SidebarSnapshot): { severity: SidebarCardSeverity; badge?: string } {
  switch (def.id) {
    case "session":
      return snapshot.updateAvailable !== undefined ? { severity: "attention", badge: "↑" } : { severity: "normal" };
    case "reviews": {
      const count = snapshot.reviewsNotReady ?? 0;
      return count > 0 ? { severity: "attention", badge: countBadge(count) } : { severity: "normal" };
    }
    case "remote": {
      const pending = snapshot.approvalsPending ?? 0;
      if (pending > 0) return { severity: "attention", badge: countBadge(pending) };
      if (snapshot.hold !== undefined && snapshot.hold !== "") return { severity: "attention", badge: "!" };
      return { severity: "normal" };
    }
    default:
      return { severity: "normal" };
  }
}

function headerLine(icon: string, title: string, badge: string | undefined, width: number): string {
  const left = `${icon} ${title}`;
  if (badge === undefined) return fitCells(left, width);
  const gap = width - displayWidth(left) - displayWidth(badge);
  return gap >= 1 ? `${left}${" ".repeat(gap)}${badge}` : `${fitCells(left, Math.max(1, width - displayWidth(badge) - 1))} ${badge}`;
}

function valueRows(def: CardDef, snapshot: SidebarSnapshot, width: number): string[] {
  const rows: string[] = [];
  for (const row of def.rows) {
    const parts = row.sections.map((id) => firstLine(sectionText(snapshot, id))).filter((part): part is string => part !== undefined);
    const extra = row.extra?.(snapshot);
    if (extra !== undefined) parts.unshift(extra);
    if (parts.length === 0) {
      if (row.required) rows.push(fitCells(row.fallback, width));
      continue;
    }
    rows.push(fitCells(parts.join(" · "), width));
  }
  return rows.slice(0, MAX_VALUE_ROWS);
}

function buildCard(def: CardDef, order: number, snapshot: SidebarSnapshot, ascii: boolean): SidebarCardModel {
  const { severity, badge } = signalFor(def, snapshot);
  const icon = ascii ? def.asciiIcon : def.icon;
  const tabs: SidebarCardTab[] = def.sections.map((section) => ({
    id: section.id,
    label: section.label,
    ...(section.command !== undefined ? { command: section.command } : {}),
    lines: (width) => wrapText(sectionText(snapshot, section.id) ?? NOTHING_TO_SHOW, width),
  }));
  return {
    id: def.id,
    order,
    icon: def.icon,
    asciiIcon: def.asciiIcon,
    title: def.title,
    severity,
    ...(badge !== undefined ? { badge } : {}),
    tabs,
    lines: (textWidth, mode) => {
      if (mode === "rail") {
        return [fitCells(`${icon}${badge ?? ""}`, RAIL_CELLS)];
      }
      const lines = [headerLine(icon, def.title, badge, textWidth), ...valueRows(def, snapshot, textWidth)];
      while (lines.length < MIN_CARD_LINES) lines.push("");
      return lines;
    },
    rail: () => ({ glyph: def.icon, ...(badge !== undefined ? { badge } : {}) }),
  };
}

/** The seven cards, in their fixed order, for `snapshot`. Pure. */
export function buildSidebarCards(snapshot: SidebarSnapshot, options: { ascii?: boolean } = {}): SidebarCardModel[] {
  return CARD_DEFS.map((def, index) => buildCard(def, index + 1, snapshot, options.ascii === true));
}

// ---------------------------------------------------------------------------
// Reading a former section
// ---------------------------------------------------------------------------

type TextNode = { id?: string; visible?: boolean; plainText?: unknown; getChildren?: () => readonly unknown[] };

/**
 * The text a renderable subtree shows, one line per text row. The former sidebar sections
 * still run (they own the polling and the state); the cards read what they painted instead
 * of a second copy of every source. Label rows (`…-k`, the dim "Model" above the value) and
 * hidden nodes are left out: the tab's own label names the section.
 */
export function collectRenderableText(node: unknown): string {
  const lines: string[] = [];
  const walk = (current: unknown): void => {
    const item = current as TextNode | null | undefined;
    if (item === null || item === undefined || item.visible === false) return;
    if (typeof item.id === "string" && item.id.endsWith("-k")) return;
    if (typeof item.plainText === "string") {
      for (const line of item.plainText.split("\n")) {
        if (line.trim() !== "") lines.push(line.trimEnd());
      }
      return;
    }
    if (typeof item.getChildren === "function") {
      for (const child of item.getChildren()) walk(child);
    }
  };
  walk(node);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mounted slots
// ---------------------------------------------------------------------------

type Parent = { add(child: unknown): void };
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;

export interface SidebarCardsOptions {
  geometry: { state(): Pick<SidebarGeometryState, "mode" | "width">; subscribe?: (listener: (state: SidebarGeometryState) => void) => () => void };
  snapshot: () => SidebarSnapshot;
  onOpenCard: (cardId: SidebarCardId) => void;
  asciiIcons?: boolean | undefined;
}

export interface SidebarCardsHost {
  /** Repaint every slot from the current snapshot, geometry and theme. */
  refresh(): void;
  destroy(): void;
}

interface Slot {
  box: Box;
  texts: Text[];
}

/**
 * Mount the seven card slots into `parent`. Slots are created once, in order, and only
 * patched afterwards: `refresh` changes their text, colour and visibility, never their
 * identity. A mouse-down anywhere on a slot opens the card.
 */
export function mountSidebarCards(otui: OpenTui, renderer: Renderer, parent: Parent, options: SidebarCardsOptions): SidebarCardsHost {
  const slots = new Map<SidebarCardId, Slot>();
  let destroyed = false;
  for (const def of CARD_DEFS) {
    const open = (): void => {
      options.onOpenCard(def.id);
    };
    const box = new otui.BoxRenderable(renderer, {
      id: `sb-card-${def.id}`,
      flexDirection: "column",
      flexShrink: 0,
      marginTop: def.id === "session" ? 0 : 1,
      onMouseDown: open,
    });
    const texts: Text[] = [];
    for (let index = 0; index < MAX_VALUE_ROWS + 1; index += 1) {
      // No handler here: a mouse-down on a row bubbles to the slot, and a handler on both would open the card twice.
      const text = new otui.TextRenderable(renderer, { id: `sb-card-${def.id}-l${index}`, content: "", flexShrink: 0 });
      texts.push(text);
      box.add(text);
    }
    parent.add(box);
    slots.set(def.id, { box, texts });
  }

  const paint = (): void => {
    if (destroyed) return;
    const state = options.geometry.state();
    const mode = state.mode;
    const width = mode === "rail" ? RAIL_CELLS : sidebarTextWidth(state.width);
    const cards = buildSidebarCards(options.snapshot(), { ascii: options.asciiIcons === true });
    const theme = getTheme();
    for (const card of cards) {
      const slot = slots.get(card.id);
      if (slot === undefined) continue;
      slot.box.marginTop = mode === "rail" || card.order === 1 ? 0 : 1;
      const lines = card.lines(width, mode);
      const head =
        card.severity === "error" ? roleColor("error", theme) : card.severity === "attention" ? roleColor("attention", theme) : roleColor("text", theme);
      for (const [index, text] of slot.texts.entries()) {
        const line = lines[index];
        if (line === undefined) {
          text.visible = false;
          continue;
        }
        text.visible = true;
        text.content = line;
        text.fg = index === 0 ? head : roleColor("muted", theme);
      }
    }
  };

  const unsubscribeGeometry = options.geometry.subscribe?.(() => paint());
  const anchor = slots.get("session")?.box;
  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("sidebar-cards", paint, () => destroyed || isRenderableGone(anchor)));
  paint();

  return {
    refresh: paint,
    destroy() {
      destroyed = true;
      unsubscribeGeometry?.();
      unsubscribeTheme();
      for (const slot of slots.values()) {
        try {
          slot.box.destroy();
        } catch {
          // The renderer may already be down; the slot goes with it.
        }
      }
      slots.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

export interface OpenSidebarCardOptions {
  snapshot: () => SidebarSnapshot;
  initialTab?: string | undefined;
  /** Runs the slash command of the tab Enter was pressed on (the shell's `runLine`). */
  runCommand?: ((command: string) => void) | undefined;
}

export const SIDEBAR_CARD_FOOTER = [
  { key: "←/→", label: "tab" },
  { key: "enter", label: "open the full view" },
  { key: "esc", label: "close" },
] as const;

/**
 * Open the detail modal of one card: a tab per former section, each showing the
 * section's whole value; Enter on a tab that has an inspector runs its command.
 * Returns `undefined` for an unknown card or without OpenTUI, like `openModal`.
 */
export function openSidebarCard(
  otui: OpenTui | undefined,
  chrome: ModalChrome | undefined,
  cardId: string,
  options: OpenSidebarCardOptions,
): { close(): void; activeTab(): string } | undefined {
  if (otui === undefined || chrome === undefined) return undefined;
  const find = (): SidebarCardModel | undefined => buildSidebarCards(options.snapshot()).find((card) => card.id === cardId);
  const first = find();
  if (first === undefined) return undefined;
  const tabOf = (tabId: string): SidebarCardTab | undefined => find()?.tabs.find((tab) => tab.id === tabId);
  const handle: ReturnType<typeof openModal> = openModal(otui, chrome, {
    title: first.title,
    tabs: first.tabs.map((tab) => ({ id: tab.id, label: tab.label })),
    ...(options.initialTab !== undefined ? { initialTab: options.initialTab } : {}),
    footer: SIDEBAR_CARD_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const tab = tabOf(tabId);
      if (tab === undefined) return;
      const lines = tab.lines(ctx.width);
      const parent = body as Parent;
      parent.add(new otui.TextRenderable(chrome.renderer, { id: `sb-card-detail-${tabId}`, content: lines.join("\n"), fg: roleColor("text") }));
      if (tab.command !== undefined) {
        parent.add(
          new otui.TextRenderable(chrome.renderer, {
            id: `sb-card-detail-${tabId}-hint`,
            content: `\nEnter opens ${tab.command}`,
            fg: roleColor("muted"),
          }),
        );
      }
    },
    claimKey: (key) => {
      if (key.name !== "return" && key.name !== "enter") return false;
      const command = tabOf(handle?.activeTab() ?? "")?.command;
      if (command === undefined) return false;
      handle?.close();
      options.runCommand?.(command);
      return true;
    },
  });
  if (handle === undefined) return undefined;
  const opened = handle;
  return { close: () => opened.close(), activeTab: () => opened.activeTab() };
}
