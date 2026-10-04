// Flow 403 (AC19): the work intake on the operator's surfaces.
//
// One object feeds all of them: `buildIntakeStatus` (src/intake/status.ts). The sidebar row shows its `line`, the
// `/intake` modal draws its `tabs`, the text of `/intake status|list` and of the readline shell is cut from it, and
// `keryx intake` reads the same object. Nothing here counts a card of its own.
//
// A decision from the modal goes through `decideIntakeCard`, the door the Telegram buttons use, with
// `decidedBy: "tui"`. A card another surface already decided is never decided again: the modal reads the status
// afresh before it calls the door and tells the operator what happened instead.

import { decideIntakeCard } from "../intake/actions";
import { runIntakePoll } from "../intake/poll";
import { buildIntakeStatus, setIntakePaused } from "../intake/status";
import type { IntakeAction, IntakeCardSummary, IntakePollResult, IntakeRecentEvent, IntakeStatus } from "../intake/types";
import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalChrome, type ModalHandle } from "./modal-host";
import { onThemeChange, type TextRole } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";

type OpenTui = typeof import("@opentui/core");

export const INTAKE_COMMAND = "/intake";
export const INTAKE_USAGE = `Usage: ${INTAKE_COMMAND} [status|list|pause|resume|poll]`;
export const INTAKE_POLL_MS = 5000;

export const INTAKE_TABS = [
  { id: "waiting", label: "Ждут" },
  { id: "decided", label: "Решённые" },
  { id: "deferred", label: "Отложенные" },
  { id: "events", label: "События" },
] as const;
export type IntakeTabId = (typeof INTAKE_TABS)[number]["id"];

export const INTAKE_FOOTER = [
  { key: "↑/↓", label: "выбор" },
  { key: "←/→", label: "вкладки" },
  { key: "t", label: "взять" },
  { key: "d", label: "отклонить" },
  { key: "l", label: "позже" },
  { key: "p", label: "пауза/пуск" },
  { key: "esc", label: "закрыть" },
] as const;

// ---- the command ----------------------------------------------------------------------------------

export function isIntakeCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === INTAKE_COMMAND;
}

export type IntakeRequest = { action: "open" } | { action: "status" | "list" | "pause" | "resume" | "poll" } | { action: "invalid"; message: string };

export function parseIntakeArgs(line: string): IntakeRequest {
  const [, sub, ...rest] = line.trim().split(/\s+/);
  if (sub === undefined) return { action: "open" };
  if (rest.length === 0 && (sub === "status" || sub === "list" || sub === "pause" || sub === "resume" || sub === "poll")) return { action: sub };
  return { action: "invalid", message: INTAKE_USAGE };
}

// ---- the seams ------------------------------------------------------------------------------------

export interface IntakeSurfaceDeps {
  readonly root: string;
  /** The one status object. Default: `buildIntakeStatus(root)`. */
  readonly status?: () => Promise<IntakeStatus>;
  /** The door every surface decides through. Default: `decideIntakeCard`. */
  readonly decide?: typeof decideIntakeCard;
  readonly setPaused?: (paused: boolean) => Promise<void>;
  /** One poll by hand. Default: `runIntakePoll(root, { manual: true })`. */
  readonly poll?: () => Promise<IntakePollResult>;
}

interface ResolvedDeps {
  readonly root: string;
  readonly status: () => Promise<IntakeStatus>;
  readonly decide: typeof decideIntakeCard;
  readonly setPaused: (paused: boolean) => Promise<void>;
  readonly poll: () => Promise<IntakePollResult>;
}

function resolveDeps(deps: IntakeSurfaceDeps): ResolvedDeps {
  const { root } = deps;
  return {
    root,
    status: deps.status ?? (() => buildIntakeStatus(root)),
    decide: deps.decide ?? decideIntakeCard,
    setPaused: deps.setPaused ?? ((paused) => setIntakePaused(root, paused)),
    poll: deps.poll ?? (() => runIntakePoll(root, { manual: true })),
  };
}

// ---- text ---------------------------------------------------------------------------------------

// A title or a repository name comes from GitHub: it may carry terminal control bytes.
// eslint-disable-next-line no-control-regex -- strips terminal control bytes from untrusted text
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function clean(text: string, max = 90): string {
  const flat = text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

const ACTION_LABEL: Readonly<Record<IntakeAction, string>> = {
  take: "взять",
  decline: "отклонить",
  later: "позже",
  "review-flow": "ревью",
  skip: "пропустить",
  "ci-triage": "разобрать CI",
  ignore: "игнорировать",
  understood: "понятно",
};

const KEY_ACTIONS = {
  t: ["take", "review-flow", "ci-triage", "understood"],
  d: ["decline", "skip", "ignore"],
  l: ["later"],
} as const satisfies Record<string, readonly IntakeAction[]>;
export type IntakeKey = keyof typeof KEY_ACTIONS;

/** What `t`, `d` and `l` mean for this card: the first of their actions its buttons offer. */
export function intakeActionsFor(card: Pick<IntakeCardSummary, "actions">): Partial<Record<IntakeKey, IntakeAction>> {
  const out: Partial<Record<IntakeKey, IntakeAction>> = {};
  for (const key of Object.keys(KEY_ACTIONS) as IntakeKey[]) {
    const hit = KEY_ACTIONS[key].find((action) => card.actions.includes(action));
    if (hit !== undefined) out[key] = hit;
  }
  return out;
}

function cardHeadline(c: IntakeCardSummary): string {
  return `${c.kind.padEnd(7)} ${c.repo !== undefined ? `${clean(c.repo, 40)} ` : ""}${clean(c.title)}`;
}

function cardDetail(c: IntakeCardSummary, tab: IntakeTabId): string {
  if (tab === "waiting") {
    const keys = Object.entries(intakeActionsFor(c)).map(([key, action]) => `${key} ${ACTION_LABEL[action as IntakeAction]}`);
    const hint = c.suggestion !== undefined ? `предложено: ${ACTION_LABEL[c.suggestion]}; ` : "";
    return `${hint}${c.state === "failed" ? "прошлая попытка не удалась; " : ""}${keys.join(", ")}`;
  }
  if (tab === "deferred") return `напомнить: ${c.remindAt ?? "—"}`;
  const choice = c.choice !== undefined ? ACTION_LABEL[c.choice] : c.state;
  return `→ ${choice}${c.decidedBy !== undefined ? ` (${clean(c.decidedBy, 24)})` : ""}${c.decidedAt !== undefined ? ` ${c.decidedAt}` : ""}${c.flowId !== undefined ? `; flow ${clean(c.flowId, 24)}` : ""}`;
}

function eventLine(e: IntakeRecentEvent): string {
  return `${e.at}  ${e.kind.padEnd(7)} ${clean(e.key, 60)}  → ${e.cardId}`;
}

export function intakeStatusText(status: IntakeStatus): string {
  const lines = [
    status.line,
    `  включён: ${status.enabled ? "да" : "нет"}${status.paused ? " (пауза)" : ""}${status.quiet ? "; сейчас тихие часы" : ""}`,
    `  ждут решения: ${status.waiting}; в очереди на отправку: ${status.queued}; отложено: ${status.deferred}; решено: ${status.decided}`,
    `  репозитории: ${status.repos.join(", ") || "не заданы"}; аккаунт GitHub по пути проекта: ${status.ghAccount}`,
    `  последний опрос: ${status.lastPollAt ?? "ещё не было"}`,
  ];
  if (status.lastRun !== undefined) lines.push(`  итог последнего: ${status.lastRun.outcome} — ${status.lastRun.detail}`);
  return `${lines.join("\n")}\n`;
}

export function intakeListText(status: IntakeStatus): string {
  const groups: Array<[string, readonly IntakeCardSummary[], IntakeTabId]> = [
    ["Ждут", status.tabs.waiting, "waiting"],
    ["Отложенные", status.tabs.deferred, "deferred"],
    ["Решённые", status.tabs.decided, "decided"],
  ];
  const lines: string[] = [];
  for (const [label, cards, tab] of groups) {
    if (cards.length === 0) continue;
    lines.push(`${label} (${cards.length}):`);
    for (const c of cards) lines.push(`  ${c.id}  ${cardHeadline(c)}`, `      ${cardDetail(c, tab)}`);
  }
  return lines.length === 0 ? "Карточек пока нет.\n" : `${lines.join("\n")}\n`;
}

function pollText(result: IntakePollResult): string {
  const lines = [`Intake: ${result.outcome} — ${result.detail}`];
  for (const f of result.failures) lines.push(`  ${f.source}: ${f.detail}`);
  return `${lines.join("\n")}\n`;
}

/** `/intake status|list|pause|resume|poll` as text, for the transcript and the readline shell. Never throws. */
export async function runIntakeText(request: Exclude<IntakeRequest, { action: "open" }>, input: IntakeSurfaceDeps): Promise<string> {
  const deps = resolveDeps(input);
  try {
    if (request.action === "invalid") return `${request.message}\n`;
    if (request.action === "status") return intakeStatusText(await deps.status());
    if (request.action === "list") return intakeListText(await deps.status());
    if (request.action === "pause" || request.action === "resume") {
      await deps.setPaused(request.action === "pause");
      const status = await deps.status();
      return `${request.action === "pause" ? "Intake: автоматический опрос на паузе." : "Intake: опрос возобновлён."}\n${status.line}\n`;
    }
    const text = pollText(await deps.poll());
    return `${text}${(await deps.status()).line}\n`;
  } catch (cause) {
    return `/intake ${request.action}: ${cause instanceof Error ? cause.message : String(cause)}\n`;
  }
}

/** The readline shell has no modal: the bare command prints the status and what is waiting. */
export async function readlineIntakeText(line: string, input: IntakeSurfaceDeps): Promise<string> {
  const request = parseIntakeArgs(line);
  if (request.action !== "open") return runIntakeText(request, input);
  try {
    const status = await resolveDeps(input).status();
    return `${intakeStatusText(status)}${intakeListText(status)}Решить карточку: кнопки в Telegram, либо /intake в полноэкранном шелле.\n`;
  } catch (cause) {
    return `/intake: ${cause instanceof Error ? cause.message : String(cause)}\n`;
  }
}

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

  const box = new core.BoxRenderable(r, { id: "sb-intake", flexDirection: "column", flexShrink: 0, marginTop: 1 });
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
