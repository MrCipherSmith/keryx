// Flow 403 (AC19): the work intake on the operator's surfaces.
//
// One object feeds all of them: `buildIntakeStatus` (src/intake/status.ts). The sidebar row shows its `line`, the
// `/intake` modal draws its `tabs`, the text of `/intake status|list` and of the readline shell is cut from it, and
// `keryx intake` reads the same object. Nothing here counts a card of its own.
//
// A decision from the modal goes through `decideIntakeCard`, the door the Telegram buttons use, with
// `decidedBy: "tui"`. A card another surface already decided is never decided again: the modal reads the status
// afresh before it calls the door and tells the operator what happened instead.

import type { IntakeCardSummary, IntakeStatus } from "../intake/types";
import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalChrome, type ModalHandle } from "./modal-host";
import { onThemeChange, type TextRole } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";
export { INTAKE_COMMAND, INTAKE_USAGE, INTAKE_POLL_MS, INTAKE_TABS, INTAKE_FOOTER, isIntakeCommand, parseIntakeArgs, intakeConfiguredSync, intakeActionsFor, intakeStatusText, intakeListText, runIntakeText, readlineIntakeText } from "./intake-text";
export type { IntakeTabId, IntakeRequest, IntakeSurfaceDeps, IntakeKey } from "./intake-text";
import { ACTION_LABEL, cardDetail, cardHeadline, clean, eventLine, resolveDeps, INTAKE_COMMAND, INTAKE_POLL_MS, INTAKE_TABS, INTAKE_FOOTER, isIntakeCommand, parseIntakeArgs, intakeActionsFor, runIntakeText, type IntakeTabId, type IntakeSurfaceDeps, type IntakeKey } from "./intake-text";

type OpenTui = typeof import("@opentui/core");


// ---- the sidebar row ------------------------------------------------------------------------------

export interface IntakePanelProjection {
  /** `status.line` cut at its ` | ` into rows that fit the sidebar. Empty until the first status arrives. */
  readonly rows: readonly string[];
  readonly role: TextRole;
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function projectIntakePanel(status: IntakeStatus | undefined, width: number): IntakePanelProjection {
  if (status === undefined) return { rows: [fit("Intake: …", width)], role: "muted" };
  // A project with no intake config has nothing to show: no row at all, not a permanent "off".
  if (!status.configured) return { rows: [], role: "muted" };
  const parts = status.line.split(" | ");
  // keep the row short enough for the sidebar: `Intake: N ждут` on the first row, the rest under it
  const rows = parts.length > 1 && status.line.length > width ? parts.map((part) => fit(part, width)) : [fit(status.line, width)];
  const role: TextRole = !status.enabled ? "muted" : status.waiting > 0 ? "attention" : "ok";
  return { rows, role };
}

// ---- the modal ------------------------------------------------------------------------------------

export interface IntakeTabView {
  readonly lines: string[];
  /** Selectable cards, for the tabs that hold cards. */
  readonly items: readonly IntakeCardSummary[];
  /** The line each item starts on. */
  readonly itemStart: number[];
}

const EMPTY: Record<IntakeTabId, string> = {
  waiting: "Нет карточек, которые ждут решения.",
  decided: "Решённых карточек пока нет.",
  deferred: "Отложенных карточек нет.",
  events: "Опрос ещё не находил событий.",
};

export function formatIntakeTab(status: IntakeStatus, tab: IntakeTabId, selected: number, notice?: string): IntakeTabView {
  const lines: string[] = [status.line];
  if (notice !== undefined && notice.length > 0) lines.push(notice);
  lines.push("");
  const items: IntakeCardSummary[] = [];
  const itemStart: number[] = [];
  if (tab === "events") {
    if (status.tabs.events.length === 0) lines.push(EMPTY.events);
    for (const e of status.tabs.events) lines.push(eventLine(e));
    return { lines, items, itemStart };
  }
  const cards = status.tabs[tab];
  if (cards.length === 0) lines.push(EMPTY[tab]);
  cards.forEach((card, index) => {
    itemStart.push(lines.length);
    items.push(card);
    lines.push(`${index === selected ? ">" : " "} ${cardHeadline(card)}`, `    ${cardDetail(card, tab)}`, "");
  });
  return { lines, items, itemStart };
}

export interface IntakeModalOptions extends IntakeSurfaceDeps {
  /** The status the modal opens on; it reads again before any decision. */
  readonly initial: IntakeStatus;
  readonly initialTab?: IntakeTabId;
  /** Runs with each status the modal read, so the sidebar row follows at once. */
  readonly onChanged?: (status: IntakeStatus) => void;
  readonly onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  readonly renderer?: { width?: number; height?: number };
  readonly visibleRows?: number;
  readonly inputBlocked?: () => boolean;
}

export interface IntakeModalHandle extends ModalHandle {
  visibleLines(): readonly string[];
  selected(): IntakeCardSummary | undefined;
  /** Read the status again (or take one the caller already read) and repaint. */
  reload(next?: IntakeStatus): Promise<void>;
}

function alreadyDecided(fresh: IntakeStatus, id: string): string {
  const hit = [...fresh.tabs.decided, ...fresh.tabs.deferred].find((c) => c.id === id);
  if (hit === undefined) return "Карточки уже нет среди ожидающих: её решили в другом месте.";
  const how = hit.choice !== undefined ? ACTION_LABEL[hit.choice] : hit.state;
  return `Карточка уже решена: ${how}${hit.decidedBy !== undefined ? ` (${clean(hit.decidedBy, 24)})` : ""}. Повторно не действую.`;
}

export function openIntake(otui: unknown, chrome: unknown, options: IntakeModalOptions): IntakeModalHandle | undefined {
  const core = otui as OpenTui;
  const deps = resolveDeps(options);
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let status = options.initial;
  let tab: IntakeTabId = options.initialTab ?? "waiting";
  const selection: Record<IntakeTabId, number> = { waiting: 0, decided: 0, deferred: 0, events: 0 };
  let scroll = 0;
  let width: number | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  let busy = false;
  let notice: string | undefined;
  const keys: { off?: () => void } = {};

  const view = (): IntakeTabView => {
    const model = formatIntakeTab(status, tab, selection[tab], notice);
    selection[tab] = Math.min(Math.max(0, model.items.length - 1), Math.max(0, selection[tab]));
    return formatIntakeTab(status, tab, selection[tab], notice);
  };
  const visible = (): string[] => windowLines(wrapLines(view().lines.join("\n"), width).split("\n"), scroll, bodyRows);
  const paint = (): void => {
    if (closed) return;
    const model = view();
    const wrapped = wrapLines(model.lines.join("\n"), width).split("\n");
    scroll = clampScroll(scrollToReveal(model.itemStart[selection[tab]] ?? 0, scroll, bodyRows), wrapped.length, bodyRows);
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, windowLines(wrapped, scroll, bodyRows).join("\n"))}`;
  };
  const adopt = (next: IntakeStatus): void => {
    status = next;
    options.onChanged?.(next);
  };
  const selectedCard = (): IntakeCardSummary | undefined => view().items[selection[tab]];

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: INTAKE_COMMAND,
    tabs: INTAKE_TABS,
    initialTab: tab,
    footer: INTAKE_FOOTER,
    renderTab: (tabId, body, ctx) => {
      tab = tabId as IntakeTabId;
      scroll = 0;
      width = ctx.width;
      bodyNode = new core.TextRenderable(r as never, { id: "intake-body", content: "" }) as never;
      (body as { add(child: unknown): void }).add(bodyNode);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) return undefined;
  const modal = handle;
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint("intake-modal", paint, () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true),
  );

  const reload = async (next?: IntakeStatus): Promise<void> => {
    if (closed) return;
    try {
      status = next ?? (await deps.status());
    } catch {
      // the modal keeps what it showed
    }
    paint();
  };

  const decide = async (key: IntakeKey): Promise<void> => {
    if (tab !== "waiting") {
      notice = "Решать можно на вкладке «Ждут».";
      return;
    }
    const card = selectedCard();
    if (card === undefined) {
      notice = "Нечего решать.";
      return;
    }
    const action = intakeActionsFor(card)[key];
    if (action === undefined) {
      notice = `Для этой карточки нет действия «${key}».`;
      return;
    }
    // what the card is NOW, not what the modal drew a moment ago
    const fresh = await deps.status();
    adopt(fresh);
    if (!fresh.tabs.waiting.some((c) => c.id === card.id)) {
      notice = alreadyDecided(fresh, card.id);
      return;
    }
    const result = await deps.decide(deps.root, card.id, action, { decidedBy: "tui" });
    notice = result.message;
    adopt(await deps.status());
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await work();
    } catch (cause) {
      notice = `Не вышло: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      busy = false;
      paint();
    }
  };

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    if (token === "up" || token === "k") {
      selection[tab] = Math.max(0, selection[tab] - 1);
      notice = undefined;
      paint();
    } else if (token === "down" || token === "j") {
      selection[tab] += 1;
      notice = undefined;
      paint();
    } else if (token === "t" || token === "d" || token === "l") {
      void run(() => decide(token));
    } else if (token === "p") {
      void run(async () => {
        const next = !status.paused;
        await deps.setPaused(next);
        notice = next ? "Автоматический опрос на паузе." : "Опрос возобновлён.";
        adopt(await deps.status());
      });
    }
  });

  return {
    ...modal,
    visibleLines: visible,
    selected: selectedCard,
    reload,
  };
}

// ---- the sidebar and the shell's routing -------------------------------------------------------------

export interface IntakeSidebarOptions extends IntakeSurfaceDeps {
  otui: unknown;
  chrome: ModalChrome & { showToast(message: string): void };
  parent: unknown;
  width: number;
  onKeypress: IntakeModalOptions["onKeypress"];
  /** One transcript text (the shell's `io.onSystem`). */
  notice?: (text: string) => void;
  inputBlocked?: () => boolean;
  /** The poll; injectable so a test fires the tick itself. */
  interval?: (tick: () => Promise<void>, ms: number) => () => void;
  pollMs?: number;
}

export interface IntakeSidebar {
  projection(): IntakePanelProjection;
  status(): IntakeStatus | undefined;
  paintCount(): number;
  show(): Promise<IntakeModalHandle | undefined>;
  openModal(): IntakeModalHandle | undefined;
  /** Routes `/intake`; false for any other line. */
  handleCommand(line: string): boolean;
  refresh(): Promise<void>;
  dispose(): void;
}

/** The shell's routing of `/intake`, called from both of `runLine`'s branches. Busy is allowed: it never touches the turn. */
export function routeIntakeCommand(line: string, intake: Pick<IntakeSidebar, "handleCommand">): boolean {
  return isIntakeCommand(line) && intake.handleCommand(line);
}

function defaultInterval(tick: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export function mountIntakeSidebar(options: IntakeSidebarOptions): IntakeSidebar {
  const core = options.otui as OpenTui;
  const { chrome } = options;
  const r = chrome.renderer as never;
  const deps = resolveDeps(options);
  const notice = options.notice ?? (() => {});
  const inputBlocked =
    options.inputBlocked ?? ((): boolean => (chrome as { keyboardOwnedElsewhere?: () => boolean }).keyboardOwnedElsewhere?.() === true);

  const box = new core.BoxRenderable(r, { id: "sb-intake", flexDirection: "column", flexShrink: 0 });
  (options.parent as { add(child: unknown): void }).add(box);
  let modal: IntakeModalHandle | undefined;
  let current: IntakeStatus | undefined;
  let projected: IntakePanelProjection = projectIntakePanel(undefined, options.width);
  let paintedKey: string | undefined;
  let paints = 0;
  let disposed = false;

  const paint = (force = false): void => {
    if (disposed) return;
    const key = JSON.stringify(projected);
    if (!force && key === paintedKey) return;
    paintedKey = key;
    paints += 1;
    clearTranscriptChildren(box);
    projected.rows.forEach((row, index) => {
      box.add(
        new core.TextRenderable(r, {
          id: `sb-intake-row-${index}`,
          ...(index === 0 ? { marginTop: 1 } : {}),
          content: new core.StyledText([index === 0 ? roleChunk(core, projected.role, row) : dimChunk(core, row)]),
          onMouseDown: () => {
            void show();
          },
        }),
      );
    });
  };

  const adopt = (next: IntakeStatus): void => {
    current = next;
    projected = projectIntakePanel(next, options.width);
    paint();
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    let next: IntakeStatus;
    try {
      next = await deps.status();
    } catch {
      return;
    }
    if (disposed) return;
    adopt(next);
    await modal?.reload(next);
  };

  const show = async (): Promise<IntakeModalHandle | undefined> => {
    await refresh();
    if (disposed || current === undefined) return undefined;
    if (!current.configured) {
      // No config file: there is no modal to open, only a one-line way to turn intake on.
      notice(`${current.disabledReason ?? current.line}\n`);
      return undefined;
    }
    modal?.close({ restoreFocus: false });
    modal = openIntake(core, chrome, {
      root: deps.root,
      status: deps.status,
      decide: deps.decide,
      setPaused: deps.setPaused,
      poll: deps.poll,
      initial: current,
      onChanged: adopt,
      onKeypress: options.onKeypress,
      inputBlocked,
    });
    return modal;
  };

  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("intake-row", () => paint(true), () => disposed || isRenderableGone(box)));
  paint(true);
  void refresh();
  const stopPoll = (options.interval ?? defaultInterval)(refresh, options.pollMs ?? INTAKE_POLL_MS);

  return {
    projection: () => projected,
    status: () => current,
    paintCount: () => paints,
    show,
    openModal: () => modal,
    handleCommand(line) {
      if (!isIntakeCommand(line)) return false;
      const request = parseIntakeArgs(line);
      if (request.action === "open") {
        void show();
      } else {
        void runIntakeText(request, deps).then((text) => {
          notice(text);
          return refresh();
        });
      }
      return true;
    },
    refresh,
    dispose() {
      disposed = true;
      stopPoll();
      unsubscribeTheme();
      modal?.close({ restoreFocus: false });
    },
  };
}
